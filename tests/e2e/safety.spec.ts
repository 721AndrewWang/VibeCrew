// Draft-only external actions and Settings → Safety (ADR 007) in the browser.
import { expect, openChat, test } from './fixtures';

test('a drafted action waits above the composer with its exact command, and runs only on a click', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const group = b.chats.find((c: any) => c.kind === 'group');
  await openChat(page, crew, group.id);
  await crew.api('POST', `/drafts?chatId=${group.id}`, { kind: 'pr-open', title: 'Fix the header', body: 'Fixes the overlap.', base: 'main' });
  await crew.api('POST', `/drafts?chatId=${group.id}`, { kind: 'message', channel: '#team', body: 'Shipped the header fix.' });
  const bar = page.locator('.drafts-bar');
  await expect(bar).toContainText('2 drafted actions waiting for you');
  await expect(bar.locator('.draft-cmd pre').first()).toHaveText("gh pr create --title 'Fix the header' --body 'Fixes the overlap.' --base main");
  const message = bar.locator('.draft-card', { hasText: '#team' });
  await message.locator('button', { hasText: 'I posted it' }).click();
  await expect(bar).toContainText('1 drafted action waiting for you');
  await bar.locator('button', { hasText: 'Discard' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.msg-list')).toContainText('You discarded the drafted action');
});

test('the Safety section shows what the guard makes of a command', async ({ page, crew }) => {
  await openChat(page, crew, (await crew.api('GET', '/bootstrap')).chats[0].id);
  await page.locator('.sb-nav-item[title="Settings"]').click();
  const section = page.locator('.settings-card', { hasText: 'Command guard' });
  const input = section.locator('input.mono');
  await input.fill('cd app && git -C . push');
  await section.locator('button', { hasText: 'Check' }).click();
  await expect(section.locator('.guard-verdict')).toContainText('Refused');
  await input.fill('rm -rf dist');
  await section.locator('button', { hasText: 'Check' }).click();
  await expect(section.locator('.guard-verdict')).toContainText('Deletes: dist');
  await section.locator('.setting-row', { hasText: 'Audit log' }).locator('button.toggle').click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.safety.audit).toBe(true);
});
