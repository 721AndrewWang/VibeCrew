import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { Bootstrap, ChatMessage } from '../../shared/types';
import { type CrewServer, git, waitFor, waitTurn } from '../helpers/server';
import { expect, openChat, test } from './fixtures';

// The isolated workspace UI: a group chat works on its own branch, its changes are reviewed and
// merged into main from the computer pane, conflicts go back to a bot, and the branch goes away.

/** The highest message seq in a chat (to wait for the replies that follow). */
async function lastSeq(crew: CrewServer, chatId: string): Promise<number> {
  const { messages } = await crew.api<{ messages: ChatMessage[] }>('GET', `/chats/${chatId}/messages?limit=30`);
  return messages.reduce((n, m) => Math.max(n, m.seq ?? 0), 0);
}

/** Waits until every bot reply after `sinceSeq` has finished and no bot of the chat is busy. */
async function waitIdle(crew: CrewServer, chatId: string, sinceSeq: number) {
  await waitTurn(crew.api, chatId, sinceSeq);
  await waitFor(async () => {
    const b = await crew.api<Bootstrap>('GET', '/bootstrap');
    return !Object.values(b.statuses).some((s) => s.chatId === chatId && s.state !== 'idle' && s.state !== 'error');
  });
}

/** Sends a message from the composer and waits for the bots to finish answering it. */
async function say(page: Page, crew: CrewServer, chatId: string, text: string) {
  const since = await lastSeq(crew, chatId);
  await page.locator('.composer-box textarea').fill(text);
  await page.keyboard.press('Enter');
  await waitFor(async () => (await lastSeq(crew, chatId)) > since);
  await waitIdle(crew, chatId, since);
}

/** Opens a chat by its address and waits until it shows. */
async function switchChat(page: Page, crew: CrewServer, chat: { id: string; title: string }) {
  await openChat(page, crew, chat.id);
  await expect(page.locator('.chat-head .ch-title')).toHaveText(chat.title);
}

const clickMenu = (page: Page, text: string) => page.locator('.menu .menu-item', { hasText: text }).first().click();

test('isolated workspaces: branch, review, merge, conflicts, close', async ({ page, crew }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gitIn = (dir: string, ...args: string[]) => git(dir, crew.env, ...args);
  const b = await crew.api<Bootstrap>('GET', '/bootstrap');
  const project = b.projects[0];
  const group = b.chats.find((c) => c.kind === 'group');
  if (!project || !group) throw new Error('the demo data has no project or group chat');
  const mergeButton = page.locator('.ws-section .btn.primary', { hasText: '合并到 main' });
  const mergedToast = page.locator('.toast.success', { hasText: '已合并到 main' });
  let branch = '';

  await test.step('enable a workspace from the header menu', async () => {
    await switchChat(page, crew, group);
    await page.locator('.project-pill').click();
    await clickMenu(page, '在独立分支中工作');
    await page.locator('.modal .btn.primary', { hasText: '新建分支' }).click();
    const pill = page.locator('.project-pill.isolated .pill-branch');
    await expect(pill, 'header shows the branch').toHaveText(/^crew\//, { timeout: 15_000 });
    branch = ((await pill.textContent()) ?? '').trim();
    await expect(page.locator('.comp-head .branch-pill'), 'computer pane shows the branch').toContainText(branch);
    await expect(page.locator('.chat-item.active svg.lucide-git-branch'), 'sidebar marks the chat').toHaveCount(1);
  });

  await test.step('a bot turn shows up in the changes tab', async () => {
    await say(page, crew, group.id, '请帮我改一下首页的标题');
    await page.locator('.comp-tab', { hasText: '改动' }).click();
    const file = page.locator('.ws-section .turn-file').first();
    await expect(file, 'changes tab lists the branch file').toContainText('crew-demo.md', { timeout: 15_000 });
    await file.click();
    await expect(page.locator('.ws-section .diff').first()).toBeVisible();
  });

  await test.step('merge from the UI', async () => {
    await page.locator('.ws-section .commit-box input').fill('首页标题（UI 测试）');
    await mergeButton.click();
    await expect(mergedToast.first(), 'merge toast').toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ws-meta')).toContainText('没有区别');
    expect(gitIn(project.path, 'log', '-1', '--format=%s'), 'main got the squash commit').toBe('首页标题（UI 测试）');
  });

  await test.step('a conflict is shown and a bot resolves it', async () => {
    fs.writeFileSync(path.join(project.path, 'crew-demo.md'), '# main 上的新版本\n');
    const commit = await crew.api('POST', `/projects/${project.id}/git/commit`, { message: 'main: edit demo' });
    expect(commit.status).toBe(200);
    await say(page, crew, group.id, '再改一下这个文件');
    await expect(page.locator('.ws-meta')).not.toContainText('没有区别');
    await mergeButton.click();
    const alert = page.locator('.ws-alert');
    await expect(alert, 'conflict alert shown').toContainText('crew-demo.md');
    const since = await lastSeq(crew, group.id);
    await alert.locator('.btn.primary', { hasText: '让机器人解决冲突' }).click();
    await waitFor(async () => (await lastSeq(crew, group.id)) > since);
    await waitIdle(crew, group.id, since);
    await expect(async () => {
      await page.locator('.ws-section button[title="刷新"]').click();
      await expect(alert, 'alert gone after the bot resolved it').toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(mergedToast, 'the first merge toast is gone').toHaveCount(0, { timeout: 15_000 });
    await mergeButton.click();
    await expect(mergedToast.first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => gitIn(project.path, 'log', '-1', '--format=%s'), { message: 'merge after resolving' }).toContain('Web');
    expect(gitIn(project.path, 'status', '--porcelain'), 'clean main after the merge').toBe('');
  });

  await test.step('chat settings and the projects page', async () => {
    await page.locator('.ch-who').click();
    await expect(page.locator('.modal')).toBeVisible();
    await page.keyboard.press('Escape');
    if (await page.locator('.modal').count()) await page.locator('.modal .btn', { hasText: '取消' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await page.locator('.sb-nav-item[title="项目"]').click();
    await expect(page.locator('.pc-workspaces'), 'projects page lists the workspace').toContainText(branch);
    await expect(page.locator('.project-card'), 'workspace is not a project card').toHaveCount(1);
    await page.locator('.pc-workspaces .branch-pill').first().click();
    await expect(page.locator('.ws-section'), 'branch pill opens the chat changes').toBeVisible();
  });

  await test.step('a new group starts in its own workspace', async () => {
    await page.locator('button[title="新建"]').click();
    await clickMenu(page, '新建群聊');
    await page.locator('.modal .pick-card').nth(1).click();
    await page.locator('.modal input.input').first().fill('Parallel');
    await page.locator('.modal .setting-row .toggle').click();
    await page.locator('.modal .btn.primary', { hasText: '创建群聊' }).click();
    await expect(page.locator('.chat-head .ch-title')).toHaveText('Parallel', { timeout: 15_000 });
    await expect(page.locator('.project-pill.isolated .pill-branch'), 'its header shows its own branch').toHaveText(/^crew\/parallel-/, { timeout: 15_000 });
    const par = await waitFor(async () => (await crew.api<Bootstrap>('GET', '/bootstrap')).chats.find((c) => c.title === 'Parallel' && c.workspaceId));
    expect(par.workspaceId, 'new group starts in its own workspace').toBeTruthy();
  });

  await test.step('close the workspace from the header', async () => {
    await switchChat(page, crew, group);
    await expect(page.locator('.project-pill.isolated .pill-branch')).toHaveText(branch);
    await page.locator('.project-pill').click();
    await clickMenu(page, '关闭独立工作区');
    await page.locator('.modal .btn', { hasText: '关闭工作区' }).click();
    await expect(page.locator('.project-pill.isolated')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.comp-head .branch-pill'), 'back in the project folder').toHaveCount(0);
    await expect.poll(() => gitIn(project.path, 'branch', '--list', branch), { message: 'branch removed after full merge' }).toBe('');
  });

  await test.step('no horizontal overflow at phone width', async () => {
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${crew.base}/`);
    const item = page.locator('.chat-item', { hasText: group.title }).first();
    await expect(item).toBeVisible();
    await expect.poll(overflow, { message: 'no horizontal overflow (chat list)' }).toBeLessThanOrEqual(0);
    await item.click();
    await expect(page.locator('.chat-head .ch-title')).toHaveText(group.title);
    await expect.poll(overflow, { message: 'no horizontal overflow (chat)' }).toBeLessThanOrEqual(0);
  });
});
