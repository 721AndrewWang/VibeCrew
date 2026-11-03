// The Super-agent's bars and meters in the browser (ADR 110; deferred by ADRs 011 and 107), demo
// agent, offline: the Background jobs bar and the Activity page list a running job and stop it in
// one click; a speculative fix shows on the Activity page while Crew checks it, then waits as a ready
// fix in the chat's Speculative fixes bar and under "Waiting for you"; the Watchdog page puts the
// speculative runs' spend for today next to its own budget, as a second meter.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openChat, test } from './fixtures';

test('lists a background job in its bar and on the Activity page, and stops it in one click', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
  await crew.api('PATCH', `/bots/${chief.id}`, { fullDuplex: true });
  await crew.api('PATCH', `/chats/${dm.id}`, { permission: 'auto' });
  await openChat(page, crew, dm.id);

  await page.locator('.composer textarea').fill('Run `sleep 60; echo late` in the background, please');
  await page.keyboard.press('Enter');
  const bar = page.locator('.jobs-bar');
  await expect(bar).toContainText('Background jobs 1 running', { timeout: 30_000 });
  const row = bar.locator('.worker-row', { hasText: 'Demo build' });
  await expect(row.locator('.badge')).toHaveText('Running');
  await expect(row).toContainText('sleep 60; echo late');
  await expect(row.getByRole('button', { name: 'Stop job Demo build' })).toBeVisible();

  // The strip opens the Activity page, which lists the job with who started it, where, and Stop.
  const strip = page.getByTestId('activity-strip');
  await expect(strip).toContainText('1 running');
  await strip.click();
  const jobs = page.getByTestId('activity-jobs');
  const item = jobs.locator('.sa-row', { hasText: 'Demo build' });
  await expect(item).toContainText('started by Chief');
  await expect(item).toContainText('sleep 60; echo late');
  await expect(item.locator('.badge')).toHaveText('Running');
  await item.getByRole('button', { name: /^Stop/ }).click();
  await expect(jobs).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('activity-totals')).toContainText('0 running');

  // Back in the chat, the bar says it was stopped.
  await page.locator('.sb-nav-item[title="Chats"]').click();
  await expect(bar).toContainText('none running');
  await expect(bar.locator('.worker-row', { hasText: 'Demo build' }).locator('.badge')).toHaveText('Stopped');
});

test('shows a speculative fix while it is checked, then as waiting for you, and its spend on the Watchdog page', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const project = b.projects[0];
  const group = b.chats.find((c: any) => c.kind === 'group');
  const chat = await crew.api('POST', '/chats', { title: 'Bugs', botIds: [group.leadBotId], projectId: project.id });
  // A bug the demo run can reproduce (a file with BUG in it) and a check that takes a moment, so the
  // run is still being checked when the page looks.
  fs.writeFileSync(path.join(project.path, 'app.txt'), 'Title: BUG\n');
  fs.writeFileSync(path.join(project.path, 'check.sh'), 'sleep 3\nfor f in repro/*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project.path, env: { ...process.env, ...crew.env } });
  git('add', '-A');
  git('commit', '-qm', 'the app and its checks');
  await crew.api('PATCH', '/settings', { superAgent: { enabled: true, watchdog: { enabled: true } } });
  await crew.api('PATCH', `/projects/${project.id}`, { speculative: { enabled: true, checkCommand: 'sh check.sh' } });

  await openChat(page, crew, chat.id);
  await page.locator('.composer textarea').fill('The home page title looks wrong, it shows a weird word');
  await page.keyboard.press('Enter');

  // While Crew runs the checks: on the Activity page, with the Trigger that started it and Stop.
  await page.getByTestId('activity-strip').click();
  const running = page.getByTestId('activity-speculative').locator('.sa-row', { hasText: 'The home page title looks wrong' });
  await expect(running.locator('.badge')).toHaveText('Checking', { timeout: 30_000 });
  await expect(running).toContainText('running sh check.sh');
  await expect(running.getByRole('button', { name: /^Open Trigger tg_/ })).toBeVisible();
  await expect(running.getByRole('button', { name: 'Stop and discard the speculative fix for The home page title looks wrong, it shows a weird word' })).toBeVisible();

  // Proven: it leaves the running list and waits for the user, in the Activity page and the chat.
  const waiting = page.getByTestId('activity-waiting').locator(`[data-activity="waiting-${chat.id}"]`);
  await expect(waiting).toContainText('1 speculative fix to merge or discard', { timeout: 30_000 });
  await expect(page.getByTestId('activity-speculative')).toHaveCount(0);
  await waiting.getByRole('button', { name: 'Open chat' }).click();
  const fixes = page.locator('.spec-bar');
  await expect(fixes).toContainText('1 speculative fix ready');
  await expect(fixes.getByTestId('speculation-effect')).toContainText('Nothing is pushed.');
  await expect(fixes).toContainText('fails without the fix (exit code 1) and passes with it');

  // The Watchdog page: its own budget, and the speculative runs' spend today against theirs.
  const sp = (await crew.api('GET', `/speculations?chatId=${chat.id}`)).speculations.find((s: any) => s.status === 'ready');
  await page.locator('.sb-nav-item[title="Watchdog"]').click();
  const meter = page.getByRole('meter', { name: 'Speculative runs today' });
  await expect(meter).toHaveAttribute('aria-valuemax', '2');
  await expect(meter).toHaveAttribute('aria-valuenow', String(sp.costUsd));
  await expect(meter).toContainText('/ $2');
  // Next to the Watchdog's own spend, in the same row of meters.
  await expect(page.locator('.wd-meters [role="meter"]').nth(1)).toHaveAttribute('aria-label', 'Spent today');
  await expect(page.locator('.wd-meters [role="meter"]').nth(2)).toHaveAttribute('aria-label', 'Speculative runs today');

  // Discarding it from the bar empties both.
  await page.locator('.sb-nav-item[title="Chats"]').click();
  await fixes.getByRole('button', { name: /^Discard/ }).click();
  await expect(fixes).toHaveCount(0);
  await page.getByTestId('activity-strip').click();
  await expect(page.getByTestId('activity-waiting')).toHaveCount(0);
});
