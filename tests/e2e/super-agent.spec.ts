// Super-agent mode in the browser with every switch on (ADR 105): the Workers bar shows the Router
// dispatching a Worker; the Worker's push is refused by the guard and drafted, and the draft waits
// above the composer; the Triggers view lists the events with their verdicts and opens one with its
// related ids; the Watchdog page ticks, flags the Worker the guard refused twice, and says it told
// the chat; a draft is discarded with one click. Demo agent, no model.
import { expect, openChat, test } from './fixtures';

test('walks Triggers, Workers, the Watchdog and drafts with every switch on', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const group = b.chats.find((c: any) => c.kind === 'group');
  await crew.api('PATCH', `/chats/${group.id}`, { permission: 'auto' });
  await crew.api('PATCH', '/settings', {
    superAgent: { enabled: true, router: { enabled: true, subscriptions: true }, recall: { enabled: true }, watchdog: { enabled: true } },
    safety: { audit: true },
  });
  await openChat(page, crew, group.id);
  await expect(page.locator('.workers-bar')).toContainText('Router');

  // Workers: the Router dispatches one; it tries to push twice, the guard refuses, it drafts the push.
  await page.locator('.composer textarea').fill('Make a footer change and push it twice');
  await page.keyboard.press('Enter');
  const row = page.locator('.worker-row', { hasText: 'push it twice' });
  await expect(row.locator('.badge')).toHaveText('Done', { timeout: 40_000 });
  const drafts = page.locator('.drafts-bar');
  await expect(drafts).toContainText('1 drafted action waiting for you');
  await expect(drafts.locator('.draft-cmd pre').first()).toContainText('git push');

  // Triggers: the user's message was settled by the fast path; opening it shows its id and thread.
  await page.locator('.sb-nav-item[title="Triggers"]').click();
  const userRow = page.locator('.trigger-row', { hasText: 'User message' }).filter({ hasText: 'push it twice' });
  await expect(userRow).toContainText('Act · fast');
  // The Worker's report went straight to its Router, also by rule.
  await expect(page.locator('.trigger-row', { hasText: 'Turn result' }).filter({ hasText: 'Worker "Make a footer change' }).first()).toContainText('delivered to its Router directly');
  await userRow.click();
  const modal = page.locator('.modal');
  await expect(modal.locator('.trigger-facts .mono').first()).toHaveText(/^tg_/);
  await modal.getByLabel('Close').click();

  // The Watchdog: a tick flags the Worker the guard refused twice, and it tells the chat.
  await page.locator('.sb-nav-item[title="Watchdog"]').click();
  await expect(page.getByTestId('watchdog-status')).toBeVisible();
  await page.locator('button', { hasText: 'Tick now' }).click();
  const tick = page.locator('.wd-row[data-tick]').first();
  await expect(tick).toContainText('guard:wk_', { timeout: 30_000 });
  await expect(page.locator('.wd-row[data-action="notify"]').first()).toContainText('refused', { timeout: 30_000 });
  await expect(page.getByTestId('watchdog-log')).toContainText('Acted', { timeout: 30_000 });

  // Back in the chat: the draft is discarded; nothing ran.
  await page.locator('.wd-row[data-action="notify"] button', { hasText: 'Open chat' }).first().click();
  await expect(drafts).toBeVisible();
  await drafts.locator('button', { hasText: 'Discard' }).click();
  await expect(drafts).toHaveCount(0);
  await expect(page.locator('.msg-list')).toContainText('You discarded the drafted action');
});
