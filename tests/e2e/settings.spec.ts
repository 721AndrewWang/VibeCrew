// Settings pages in the browser: the logo picker and the deny list.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

test('picking a logo changes the app, the tab icon and what the server serves', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Settings"]').click();
  const choices = page.locator('.logo-choice');
  await expect(choices).toHaveCount(6);
  await expect(page.locator('.logo-choice[aria-checked="true"]')).toContainText('Letter C');

  await choices.filter({ hasText: 'Code brackets' }).click();
  await expect(page.locator('.logo-choice[aria-checked="true"]')).toContainText('Code brackets');
  await expect.poll(async () => page.locator('.brand .logo').innerHTML()).toContain('M49 42');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon.svg?logo=code');
  expect(await (await fetch(`${crew.base}/icon.svg`)).text()).toContain('M49 42');

  await page.reload();
  await expect.poll(async () => page.locator('.brand .logo').innerHTML()).toContain('M49 42');
  expect(await page.evaluate(() => localStorage.getItem('vc-logo'))).toBe('code');
});

test('the deny list is saved from the defaults section', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Settings"]').click();
  const field = page.locator('.field', { hasText: 'Forbidden actions' }).locator('textarea');
  await field.fill('Bash(*prod-server*)\n\nBash(rm -rf /*)');
  await page
    .locator('.card', { has: page.locator('h2', { hasText: /^Defaults$/ }) })
    .locator('.btn.primary', { hasText: /^\s*Save$/ })
    .click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.denyRules).toEqual(['Bash(*prod-server*)', 'Bash(rm -rf /*)']);
});

test('the sandbox section saves the switch and the domain list, and says when it cannot run here', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Settings"]').click();
  const card = page.locator('.settings-card', { has: page.locator('h2', { hasText: /^Sandbox$/ }) });
  await expect(card.locator('.sr-title')).toContainText('Run bot commands in a sandbox');
  const status = await crew.api('GET', '/sandbox');
  await expect(card.locator('[data-testid="sandbox-unavailable"]')).toHaveCount(status.available ? 0 : 1);
  await card.locator('textarea').fill('registry.npmjs.org\nhttps://api.example.com/v1\nnonsense host\n10.0.0.5:8080');
  await card.locator('.btn.primary', { hasText: /^\s*Save$/ }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.sandbox.allowedDomains).toEqual(['registry.npmjs.org', 'api.example.com', '10.0.0.5:8080']);
  await expect(card.locator('textarea')).toHaveValue('registry.npmjs.org\napi.example.com\n10.0.0.5:8080');
  await card.locator('.toggle').click();
  await card.locator('.btn.primary', { hasText: /^\s*Save$/ }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.sandbox.enabled).toBe(false);
  await expect(card.locator('[data-testid="sandbox-unavailable"]')).toHaveCount(0);
});

test('improvement proposals can be made, accepted and reverted from the bots page', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  // A proposal needs evidence from two separate requests.
  for (const text of ['Hello', 'One more thing']) {
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text });
    await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);
  }

  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Bots"]').click();
  const panel = page.locator('.improve-card');
  await expect(panel.locator('.improve-empty')).toBeVisible();
  await panel.locator('button', { hasText: 'Analyze recent performance' }).click();
  const item = panel.locator('.improve-item').first();
  await expect(item.locator('.improve-title')).toContainText('Chief: fresh session per turn');
  await item.locator('button', { hasText: 'Accept' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBe(true);

  await panel.locator('.improve-toggle:not(.friction-toggle)').click();
  await panel.locator('.improve-row button', { hasText: 'Revert' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBeUndefined();
  await expect(panel.locator('.improve-row .badge')).toHaveText('Reverted');
});

test('a skill draft can be edited in the panel before it is accepted', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: 'Build me a complex page' });
  await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);

  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Bots"]').click();
  const panel = page.locator('.improve-card');
  await panel.locator('.improve-candidates button', { hasText: 'Draft a skill' }).click();
  const item = panel.locator('.improve-item').first();
  await expect(item.locator('.improve-title')).toContainText('new skill');
  await item.locator('button', { hasText: /^\s*Edit$/ }).click();
  await item.locator('.improve-editor input').first().fill('my-page');
  await item.locator('.improve-editor textarea').fill('1. Look at the structure\n2. Build the page per {{args}}\n3. Screenshot to confirm');
  await item.locator('button', { hasText: 'Save changes' }).click();
  await expect(item.locator('.hint', { hasText: 'You edited this draft' })).toBeVisible();
  await expect(item.locator('.improve-skill .mono')).toContainText('/my-page');
  await item.locator('button', { hasText: 'Accept' }).click();
  await expect
    .poll(async () => (await crew.api('GET', '/bootstrap')).skills.find((s: any) => s.name === 'my-page')?.body)
    .toBe('1. Look at the structure\n2. Build the page per {{args}}\n3. Screenshot to confirm');
});

test('a proposed setting change can be edited before it is accepted', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  for (const text of ['Hello', 'One more thing']) {
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text });
    await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);
  }
  // The demo analysis proposes turning on Chief's fresh session.
  await crew.api('POST', '/improvements/run');
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Bots"]').click();
  const item = page.locator('.improve-item').first();
  await expect(item.locator('.improve-title')).toContainText('Chief: fresh session per turn');
  await item.locator('button', { hasText: /^\s*Edit$/ }).click();
  // Switching it back off would be no change at all: the editor says so and will not save it.
  await item.locator('.improve-editor .toggle').click();
  await expect(item.locator('.improve-editor .hint', { hasText: 'This is the same as now' })).toBeVisible();
  await expect(item.locator('button', { hasText: 'Save changes' })).toBeDisabled();
  await item.locator('button', { hasText: 'Cancel' }).click();
  await item.locator('button', { hasText: 'Accept' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBe(true);
});

test('the friction report shows what got in the way and hands it to a group', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const group = await crew.api('POST', '/chats', { title: 'Maintenance team', botIds: [chief.id], projectId: b.projects[0].id });
  const at = Date.now() - 60_000;
  const events = [
    { at, kind: 'approval-readonly', key: 'Bash(ls*)', detail: 'Forge: ls -la', chatId: group.id, chatTitle: 'Maintenance team' },
    { at, kind: 'approval-readonly', key: 'Bash(ls*)', detail: 'Forge: ls src' },
    { at, kind: 'stall', key: 'Nobody picked up after Chief handed back', detail: 'Chief stopped' },
  ];
  fs.writeFileSync(path.join(crew.home, 'friction.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Bots"]').click();
  await page.locator('.friction-toggle').click();
  const kinds = page.locator('.friction-kind');
  await expect(kinds.first()).toContainText('Read-only commands asked for approval');
  await expect(kinds.first().locator('.badge')).toHaveText('2');
  await expect(kinds.first().locator('.friction-group').first()).toContainText('Bash(ls*) × 2');
  await expect(kinds.nth(1)).toContainText('Handoff chain stalled');

  await page.locator('.friction-body select').selectOption(group.id);
  await page.locator('.friction-body button', { hasText: 'Hand to the team to fix' }).click();
  await expect
    .poll(async () => (await crew.api('GET', `/chats/${group.id}/messages?limit=5`)).messages.find((m: any) => m.role === 'user')?.text ?? '', { timeout: 10_000 })
    .toContain("@Chief Here's Crew's friction report for the last 7 days");
  await crew.api('POST', `/chats/${group.id}/stop`).catch(() => {});
});

test('the bot card shows the cache hit rate and the average re-read per turn', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  for (const text of ['Hello', 'One more thing']) {
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text });
    await expect.poll(async () => (await crew.api('GET', `/chats/${dm.id}/messages?limit=8`)).messages.some((m: any) => m.seq > sent.seq && m.status === 'done'), { timeout: 20_000 }).toBe(true);
  }
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="Bots"]').click();
  // Re-reads of 17.5k and 23k against 4k written and 100 uncached: 91%, 20k a turn.
  const badge = page.locator('.cache-badge');
  await expect(badge).toContainText('Cache hit 91% · 20k reread/turn');
  await expect(badge).toHaveAttribute('title', /Biggest reread in one turn: 23k/);
});
