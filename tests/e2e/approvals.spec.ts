// The approval card in the chat: it says why Crew asked, and the buttons answer it.
import { expect, openChat, test } from './fixtures';

test('the card says why it asked and answers with one click', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
  await crew.api('PATCH', `/bots/${chief.id}`, { allowRules: [] });
  await crew.api('PATCH', `/chats/${dm.id}`, { permission: 'ask' });
  await openChat(page, crew, dm.id);
  await page.locator('.composer textarea').fill('帮我做一个页面');
  await page.keyboard.press('Enter');
  const card = page.locator('.approval.pending').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.approval-reason').first()).toHaveText('为什么要问：权限是「每步确认」');
  await card.locator('button', { hasText: '允许' }).first().click();
  await expect(page.locator('.approval.allowed').first()).toBeVisible();
  // The next request (writing a file) gets the same explanation, and "always allow" is offered for commands only.
  const next = page.locator('.approval.pending').first();
  await expect(next).toBeVisible({ timeout: 20_000 });
  await next.locator('button', { hasText: '允许' }).first().click();
  await expect(page.locator('.approval.pending')).toHaveCount(0, { timeout: 20_000 });
});
