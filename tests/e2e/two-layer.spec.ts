// Two-layer mode in the UI: the Workers bar shows the Router and the Workers it dispatched, a
// Worker's transcript opens from its row, and a running Worker can be stopped there.
import { expect, openChat, test } from './fixtures';

test('shows the Router and its Workers, opens a transcript, and stops a Worker', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const group = b.chats.find((c: any) => c.kind === 'group');
  await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true } } });
  await openChat(page, crew, group.id);
  await expect(page.locator('.workers-bar')).toContainText('Router');

  await page.locator('.composer textarea').fill('Build a pricing page');
  await page.keyboard.press('Enter');
  const row = page.locator('.worker-row').first();
  await expect(row).toContainText('Build a pricing page');
  await expect(row.locator('.badge')).toHaveText('Done', { timeout: 30_000 });
  await expect(row).toContainText("Merged 1 file into the chat's branch");
  // The Router's replies are in the chat; the Worker's own turn is not.
  await expect(page.locator('.msg.bot .msg-meta', { hasText: 'Router' }).first()).toBeVisible();

  await row.locator('.wr-main').click();
  const dialog = page.locator('.modal');
  await expect(dialog).toContainText('Worker: Build a pricing page');
  await expect(dialog).toContainText('The task from the Router');
  await expect(dialog.locator('.msg.bot')).toHaveCount(1);
  await dialog.getByLabel('Close').click();

  await page.locator('.composer textarea').fill('Make a slow change to the footer');
  await page.keyboard.press('Enter');
  const slow = page.locator('.worker-row', { hasText: 'slow change' });
  await expect(slow.locator('.badge')).toHaveText('Working', { timeout: 30_000 });
  await slow.getByTitle('Stop this Worker').click();
  await expect(slow.locator('.badge')).toHaveText('Stopped', { timeout: 15_000 });
  await slow.getByTitle(/Dismiss/).click();
  await expect(slow).toHaveCount(0);
});
