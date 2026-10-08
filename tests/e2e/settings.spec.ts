// Settings pages in the browser: the logo picker and the deny list.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

test('picking a logo changes the app, the tab icon and what the server serves', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="设置"]').click();
  const choices = page.locator('.logo-choice');
  await expect(choices).toHaveCount(6);
  await expect(page.locator('.logo-choice[aria-checked="true"]')).toContainText('C 字母');

  await choices.filter({ hasText: '代码括号' }).click();
  await expect(page.locator('.logo-choice[aria-checked="true"]')).toContainText('代码括号');
  await expect.poll(async () => page.locator('.brand .logo').innerHTML()).toContain('M49 42');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon.svg?logo=code');
  expect(await (await fetch(`${crew.base}/icon.svg`)).text()).toContain('M49 42');

  await page.reload();
  await expect.poll(async () => page.locator('.brand .logo').innerHTML()).toContain('M49 42');
  expect(await page.evaluate(() => localStorage.getItem('vc-logo'))).toBe('code');
});

test('the deny list is saved from the defaults section', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="设置"]').click();
  const field = page.locator('.field', { hasText: '禁止的操作' }).locator('textarea');
  await field.fill('Bash(*prod-server*)\n\nBash(rm -rf /*)');
  await page.locator('.card', { hasText: '默认值' }).locator('.btn.primary', { hasText: '保存' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.denyRules).toEqual(['Bash(*prod-server*)', 'Bash(rm -rf /*)']);
});

test('the sandbox section saves the switch and the domain list, and says when it cannot run here', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="设置"]').click();
  const card = page.locator('.settings-card', { has: page.locator('h2', { hasText: '沙盒' }) });
  await expect(card.locator('.sr-title')).toContainText('关进沙盒');
  const status = await crew.api('GET', '/sandbox');
  await expect(card.locator('[data-testid="sandbox-unavailable"]')).toHaveCount(status.available ? 0 : 1);
  await card.locator('textarea').fill('registry.npmjs.org\nhttps://api.example.com/v1\nnonsense host\n10.0.0.5:8080');
  await card.locator('.btn.primary', { hasText: '保存' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.sandbox.allowedDomains).toEqual(['registry.npmjs.org', 'api.example.com', '10.0.0.5:8080']);
  await expect(card.locator('textarea')).toHaveValue('registry.npmjs.org\napi.example.com\n10.0.0.5:8080');
  await card.locator('.toggle').click();
  await card.locator('.btn.primary', { hasText: '保存' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.sandbox.enabled).toBe(false);
  await expect(card.locator('[data-testid="sandbox-unavailable"]')).toHaveCount(0);
});

test('improvement proposals can be made, accepted and reverted from the bots page', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  // A proposal needs evidence from two separate requests.
  for (const text of ['你好', '再说一句']) {
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text });
    await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);
  }

  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="机器人"]').click();
  const panel = page.locator('.improve-card');
  await expect(panel.locator('.improve-empty')).toBeVisible();
  await panel.locator('button', { hasText: '分析最近的表现' }).click();
  const item = panel.locator('.improve-item').first();
  await expect(item.locator('.improve-title')).toContainText('Chief 的每轮新会话');
  await item.locator('button', { hasText: '接受' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBe(true);

  await panel.locator('.improve-toggle:not(.friction-toggle)').click();
  await panel.locator('.improve-row button', { hasText: '撤回' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBeUndefined();
  await expect(panel.locator('.improve-row .badge')).toHaveText('已撤回');
});

test('a skill draft can be edited in the panel before it is accepted', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: '帮我做一个复杂的页面' });
  await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);

  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="机器人"]').click();
  const panel = page.locator('.improve-card');
  await panel.locator('.improve-candidates button', { hasText: '起草技能' }).click();
  const item = panel.locator('.improve-item').first();
  await expect(item.locator('.improve-title')).toContainText('新技能');
  await item.locator('button', { hasText: '修改' }).click();
  await item.locator('.improve-editor input').first().fill('my-page');
  await item.locator('.improve-editor textarea').fill('1. 看结构\n2. 按 {{args}} 写页面\n3. 截图确认');
  await item.locator('button', { hasText: '保存修改' }).click();
  await expect(item.locator('.hint', { hasText: '这份草稿你改过' })).toBeVisible();
  await expect(item.locator('.improve-skill .mono')).toContainText('/my-page');
  await item.locator('button', { hasText: '接受' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).skills.find((s: any) => s.name === 'my-page')?.body).toBe('1. 看结构\n2. 按 {{args}} 写页面\n3. 截图确认');
});

test('a proposed setting change can be edited before it is accepted', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  for (const text of ['你好', '再说一句']) {
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text });
    await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);
  }
  // The demo analysis proposes turning on Chief's fresh session.
  await crew.api('POST', '/improvements/run');
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="机器人"]').click();
  const item = page.locator('.improve-item').first();
  await expect(item.locator('.improve-title')).toContainText('Chief 的每轮新会话');
  await item.locator('button', { hasText: '修改' }).click();
  // Switching it back off would be no change at all: the editor says so and will not save it.
  await item.locator('.improve-editor .toggle').click();
  await expect(item.locator('.improve-editor .hint', { hasText: '和现在一样' })).toBeVisible();
  await expect(item.locator('button', { hasText: '保存修改' })).toBeDisabled();
  await item.locator('button', { hasText: '取消' }).click();
  await item.locator('button', { hasText: '接受' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBe(true);
});

test('the friction report shows what got in the way and hands it to a group', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const group = await crew.api('POST', '/chats', { title: '维护小队', botIds: [chief.id], projectId: b.projects[0].id });
  const at = Date.now() - 60_000;
  const events = [
    { at, kind: 'approval-readonly', key: 'Bash(ls*)', detail: 'Forge：ls -la', chatId: group.id, chatTitle: '维护小队' },
    { at, kind: 'approval-readonly', key: 'Bash(ls*)', detail: 'Forge：ls src' },
    { at, kind: 'stall', key: 'Chief 交回后没人接手', detail: 'Chief 停了' },
  ];
  fs.writeFileSync(path.join(crew.home, 'friction.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="机器人"]').click();
  await page.locator('.friction-toggle').click();
  const kinds = page.locator('.friction-kind');
  await expect(kinds.first()).toContainText('只读命令也来问你');
  await expect(kinds.first().locator('.badge')).toHaveText('2');
  await expect(kinds.first().locator('.friction-group').first()).toContainText('Bash(ls*) × 2');
  await expect(kinds.nth(1)).toContainText('接力停住');

  await page.locator('.friction-body select').selectOption(group.id);
  await page.locator('.friction-body button', { hasText: '交给小队去修' }).click();
  await expect
    .poll(async () => (await crew.api('GET', `/chats/${group.id}/messages?limit=5`)).messages.find((m: any) => m.role === 'user')?.text ?? '', { timeout: 10_000 })
    .toContain('@Chief 这是 Crew 最近 7 天的摩擦报告');
  await crew.api('POST', `/chats/${group.id}/stop`).catch(() => {});
});

test('the bot card shows the cache hit rate and the average re-read per turn', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  for (const text of ['你好', '再说一句']) {
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text });
    await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);
  }
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="机器人"]').click();
  // Re-reads of 17.5k and 23k against 4k written and 100 uncached: 91%, 20k a turn.
  const badge = page.locator('.cache-badge');
  await expect(badge).toContainText('缓存命中 91% · 每轮重读 20k');
  await expect(badge).toHaveAttribute('title', /重读最多的一轮：23k/);
});
