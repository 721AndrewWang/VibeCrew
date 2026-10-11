// The message box: Claude Code-style switches (mode, model, effort), the context ring, the model in replies.
import { expect, openChat, test } from './fixtures';

const bootstrap = async (crew: { api: (m: string, u: string) => Promise<any> }) => crew.api('GET', '/bootstrap');

test('mode, model and effort switches change the chat for every bot', async ({ page, crew }) => {
  const group = (await bootstrap(crew)).chats.find((c: any) => c.kind === 'group');
  await openChat(page, crew, group.id);
  const pills = page.locator('.composer .switch-pill');
  await expect(pills).toHaveCount(3);
  // Lens is read-only and stays so whatever the switch says; the others all edit freely, so the
  // switch shows their shared setting rather than "Per bot".
  await expect(pills.nth(0)).toContainText('Auto-edit files');

  await pills.nth(0).click();
  await page.locator('.menu .menu-item', { hasText: 'Auto (AI-reviewed)' }).click();
  await expect(pills.nth(0)).toContainText('Auto (AI-reviewed)');
  await pills.nth(1).click();
  await page.locator('.menu .menu-item', { hasText: 'Sonnet 5' }).first().click();
  await pills.nth(2).click();
  await page.locator('.menu .menu-item', { hasText: 'Max' }).click();
  await expect(pills.nth(1)).toContainText('Sonnet 5');
  await expect(pills.nth(2)).toContainText('Max');
  const chat = (await bootstrap(crew)).chats.find((c: any) => c.id === group.id);
  expect([chat.permission, chat.model, chat.effort]).toEqual(['review', 'claude-sonnet-5', 'max']);

  await pills.nth(0).click();
  await page.locator('.menu .menu-item', { hasText: "Use each bot's own setting" }).click();
  await expect(pills.nth(0)).toContainText('Auto-edit files');
  const reset = (await bootstrap(crew)).chats.find((c: any) => c.id === group.id);
  expect(reset.permission).toBeUndefined();
});

test('the context ring fills after a reply, lists each bot, and empties with a new topic', async ({ page, crew }) => {
  const dm = (await bootstrap(crew)).chats.find((c: any) => c.kind === 'dm');
  await openChat(page, crew, dm.id);
  const ring = page.locator('.composer .ctx-ring');
  await expect(ring).toHaveAttribute('title', /shown after a bot replies/);
  await expect(page.locator('.composer .ctx-fill')).toHaveCount(0);

  await page.locator('.composer textarea').fill('Hello');
  await page.keyboard.press('Enter');
  await expect(ring).toHaveAttribute('title', 'Context used 10% (Chief: 20k / 200k)');
  await expect(page.locator('.composer .ctx-fill')).toHaveCount(1);
  // The model in use: in the reply's footer and in the model switch.
  await expect(page.locator('.msg-foot').last()).toContainText('Opus 5.5');
  await expect(page.locator('.composer .switch-pill').nth(1)).toContainText('Default · Opus 5.5');

  await ring.click();
  await expect(page.locator('.menu')).toContainText('20k / 200k');
  await page.locator('.menu .menu-item', { hasText: 'Start new topic' }).click();
  await page.locator('.modal .btn.primary', { hasText: 'Start new topic' }).click();
  await expect(page.locator('.composer .ctx-fill')).toHaveCount(0);
});

test('a narrow window wraps the switches instead of hiding them', async ({ page, crew }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const dm = (await bootstrap(crew)).chats.find((c: any) => c.kind === 'dm');
  await openChat(page, crew, dm.id);
  const pills = page.locator('.composer .switch-pill');
  for (const i of [0, 1, 2]) await expect(pills.nth(i)).toBeVisible();
  const box = (await page.locator('.composer').boundingBox())!;
  const send = (await page.locator('.composer .send-btn').boundingBox())!;
  expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width + 1);
});
