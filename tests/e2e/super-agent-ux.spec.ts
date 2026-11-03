// The Super-agent's user experience (ADR 107), demo agent, no model: turning the mode on part by part
// from Settings with the keyboard, seeing what runs in the background and why on the Activity page
// and stopping it in one click, a draft that says what approving it does, and the basics every view
// shares (named controls, focus kept in dialogs and given back).
import type { Page } from '@playwright/test';
import { expect, openChat, test } from './fixtures';

/** Visible controls (in the main pane and dialogs, or under `scope`) that a screen reader could not name. */
async function unnamedControls(page: Page, scope = 'main, .modal'): Promise<string[]> {
  return page.evaluate((sel) => {
    const roots = [...document.querySelectorAll(sel)];
    const named = (el: Element) => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
      if ((el as HTMLInputElement).labels?.length) return true;
      if (el.tagName === 'BUTTON' && (el.textContent || '').trim()) return true;
      return !!el.getAttribute('title');
    };
    return roots
      .flatMap((r) => [...r.querySelectorAll('button, input:not([type=hidden]), textarea, select')])
      .filter((el) => (el as HTMLElement).getBoundingClientRect().width > 0 && !named(el))
      .map((el) => el.outerHTML.slice(0, 120));
  }, scope);
}

test('turns Super-agent mode on part by part from Settings, with the keyboard, after showing what it costs', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  await openChat(page, crew, b.chats[0].id);
  await page.locator('.sb-nav-item[title="Settings"]').click();
  const card = page.locator('#settings-superagent');
  await expect(card.getByTestId('sa-primer')).toBeVisible();
  for (const name of ['Triggers', 'Router', 'Workers', 'Watchdog']) await expect(card.getByTestId('sa-primer')).toContainText(name);

  // Every part says what it does and what it costs; a part whose prerequisite is off cannot be turned on.
  const parts = card.getByTestId('sa-parts');
  await expect(parts.locator('[data-part]')).toHaveCount(10);
  await expect(parts.locator('[data-part="watchdog"]')).toContainText('Costs: No model call while nothing is flagged; at most 4 looks an hour and $1.00 a day.');
  await expect(parts.locator('[data-part="router"]')).toContainText('Needs Triggers on first.');
  await expect(parts.getByRole('switch', { name: 'Router and Workers' })).toBeDisabled();
  await expect(parts.locator('[data-part="speculative"]').getByRole('button', { name: 'Set up in Projects' })).toBeVisible();

  // The core, from the keyboard: the confirmation takes focus, lists the costs, and Enter accepts.
  await card.getByRole('button', { name: 'Turn on the core' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Turn on the core of Super-agent mode?' });
  await expect(dialog).toContainText('Router and Workers:');
  await expect(dialog).toContainText('The Watchdog, speculative fixes and the GitHub channel stay off');
  await expect(dialog.getByRole('button', { name: 'Turn them on' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  for (const name of ['Triggers', 'Router and Workers', 'Direct routing', 'Chain of recall']) await expect(parts.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
  await expect(parts.getByRole('switch', { name: 'Watchdog' })).toHaveAttribute('aria-checked', 'false');
  let s = (await crew.api('GET', '/bootstrap')).settings.superAgent;
  expect([s.enabled, s.router.enabled, s.router.subscriptions, s.recall.enabled, s.watchdog.enabled]).toEqual([true, true, true, true, false]);

  // One more part with the space bar; its settings appear below the list.
  const watchdog = parts.getByRole('switch', { name: 'Watchdog' });
  await watchdog.focus();
  await page.keyboard.press('Space');
  await expect(watchdog).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('watchdog-settings')).toBeVisible();
  await card.getByTestId('watchdog-settings').locator('summary').click();
  await expect(card.getByTestId('watchdog-settings').getByLabel('Budget per day (USD)')).toHaveValue('1');
  expect(await unnamedControls(page, '#settings-superagent, #settings-gateway')).toEqual([]);

  // And all off again, after a confirmation.
  await card.getByRole('button', { name: 'Turn everything off' }).click();
  await page.getByRole('dialog', { name: 'Turn Super-agent mode off?' }).getByRole('button', { name: 'Turn it off' }).click();
  await expect(parts.getByRole('switch', { name: 'Triggers' })).toHaveAttribute('aria-checked', 'false');
  s = (await crew.api('GET', '/bootstrap')).settings.superAgent;
  expect([s.enabled, s.router.enabled, s.router.subscriptions, s.recall.enabled, s.watchdog.enabled]).toEqual([false, false, false, false, false]);
});

test('shows what runs in the background, the Trigger that started it and its cost, and stops it in one click', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const group = b.chats.find((c: any) => c.kind === 'group');
  await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true, subscriptions: true } } });
  await openChat(page, crew, group.id);
  const strip = page.getByTestId('activity-strip');
  await expect(strip).toContainText('Nothing running in the background');

  await page.locator('.composer textarea').fill('Make a slow change to the footer');
  await page.keyboard.press('Enter');
  await expect(page.locator('.worker-row', { hasText: 'slow change' }).locator('.badge')).toHaveText('Working', { timeout: 30_000 });
  await expect(strip).toContainText('1 running');
  await strip.click();

  // The Worker's row: who, where, why (its Trigger), for how long, its cost, and Stop.
  const row = page.getByTestId('activity-workers').locator('.sa-row', { hasText: 'Make a slow change to the footer' });
  await expect(row).toContainText('Chief');
  await expect(row).toContainText('in “Web team”');
  await expect(row.locator('.sa-cost')).toHaveText('$0.00');
  await expect(row.locator('.badge')).toHaveText('Working');
  await expect(page.getByTestId('activity-totals')).toContainText('1 running');

  // Its Trigger opens in a dialog that keeps focus inside, and gives it back on Escape.
  const link = row.getByRole('button', { name: /^Open Trigger tg_/ });
  await link.click();
  const dialog = page.getByRole('dialog', { name: 'User message' });
  await expect(dialog).toContainText('Make a slow change to the footer');
  await expect(dialog.locator('.trigger-facts .mono').first()).toHaveText(/^tg_/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.modal'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(link).toBeFocused();
  expect(await unnamedControls(page)).toEqual([]);

  // One click stops it; the page and the strip say nothing runs any more.
  await row.getByRole('button', { name: 'Stop Worker Make a slow change to the footer' }).click();
  await expect(page.getByTestId('activity-workers')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('activity-totals')).toContainText('0 running');
  await expect(strip).toContainText('Nothing running in the background');
  await page.locator('.sb-nav-item[title="Chats"]').click();
  await expect(page.locator('.worker-row', { hasText: 'slow change' }).locator('.badge')).toHaveText('Stopped');
});

test('says what approving a draft will do before it runs, and lists it as waiting for you', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  const group = b.chats.find((c: any) => c.kind === 'group');
  await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
  const r = await crew.api('POST', `/drafts?chatId=${group.id}`, { kind: 'issue-comment', repo: 'acme/shop', number: 12, body: 'Fixed in the latest commit.' });
  expect(r.status).toBe(200);
  await openChat(page, crew, group.id);

  const card = page.locator('.drafts-bar .draft-card');
  const effect = card.getByTestId('draft-effect');
  await expect(effect).toContainText('When you approve');
  await expect(effect).toContainText('Posts the text below on GitHub (Comment on issue #12 in acme/shop), with your own gh login.');
  await expect(effect).toContainText('Discard instead: nothing leaves this machine');
  // The text that would be posted is open, and so is the exact command.
  await expect(card.locator('.draft-body').first()).toBeVisible();
  await expect(card.locator('.draft-body').first()).toHaveText('Fixed in the latest commit.');
  await expect(card.locator('.draft-cmd pre')).toContainText('gh issue comment 12');

  // The Activity page lists the chat as waiting for the user, and opens it.
  await expect(page.getByTestId('activity-strip')).toContainText('1 waiting for you');
  await page.getByTestId('activity-strip').click();
  const waiting = page.getByTestId('activity-waiting');
  await expect(waiting).toContainText('1 drafted action to approve or discard');
  await waiting.getByRole('button', { name: 'Open chat' }).click();

  // Discard from the keyboard: nothing ran.
  await page.getByRole('button', { name: 'Discard: Comment on issue, Comment on issue #12 in acme/shop' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.drafts-bar')).toHaveCount(0);
  await expect(page.getByTestId('activity-strip')).toContainText('Nothing running in the background');
});

test('every Super-agent page names its controls and shows its empty state when nothing happened yet', async ({ page, crew }) => {
  const b = await crew.api('GET', '/bootstrap');
  await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true }, watchdog: { enabled: true } } });
  await openChat(page, crew, b.chats[0].id);
  await page.locator('.sb-nav-item[title="Triggers"]').click();
  await expect(page.locator('main')).toContainText('No Triggers yet');
  // One event, so there is something to filter.
  await crew.api('POST', `/chats/${b.chats[0].id}/messages`, { text: 'Hello there' });

  await page.getByTestId('activity-strip').click();
  await expect(page.locator('main')).toContainText('Nothing runs in the background');
  expect(await unnamedControls(page)).toEqual([]);

  await page.locator('.sb-nav-item[title="Watchdog"]').click();
  await expect(page.getByTestId('watchdog-status')).toBeVisible();
  await expect(page.locator('main')).toContainText('None waiting.');
  await expect(page.getByRole('meter', { name: 'Spent today' })).toHaveAttribute('aria-valuetext', '$0.00 of $1.00');
  expect(await unnamedControls(page)).toEqual([]);

  await page.locator('.sb-nav-item[title="Triggers"]').click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.trigger-row', { hasText: 'Hello there' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filter by source' }).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Filter by source' }).getByRole('button', { name: 'Speculative fix' }).click();
  await expect(page.locator('main')).toContainText('No Triggers match these filters');
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page.locator('.trigger-row').first()).toBeVisible();
  expect(await unnamedControls(page)).toEqual([]);

  // Turning the Watchdog off from Settings leaves its page with the notice that lands back on the switch.
  await crew.api('PATCH', '/settings', { superAgent: { watchdog: { enabled: false } } });
  await page.reload();
  await page.waitForSelector('.composer, .page');
  await page.locator('.sb-nav-item[title="Settings"]').click();
  await expect(page.locator('#settings-superagent').getByRole('switch', { name: 'Watchdog' })).toHaveAttribute('aria-checked', 'false');
});
