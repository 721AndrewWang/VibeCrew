// Every main screen opens without errors, in both themes and at phone width.
import { expect, test } from './fixtures';

const SCREENS = ['Chats', 'Bots', 'Skills', 'Routines', 'Projects', 'Settings'];

for (const colorScheme of ['light', 'dark'] as const) {
  test(`all screens open (${colorScheme})`, async ({ page, crew }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(crew.base);
    await expect(page.locator('.chat-item').first()).toBeVisible();
    for (const name of SCREENS) {
      await page.locator(`.sb-nav-item[title="${name}"]`).click();
      await expect(page.locator('.main')).toBeVisible();
    }
  });
}

test('phone width: no sideways scrolling, chat and composer reachable', async ({ page, crew }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
  await page.goto(crew.base);
  await page.locator('.chat-item', { hasText: group.title }).click();
  await expect(page.locator('.composer .switch-pill').first()).toBeVisible();
  await expect(page.locator('.composer .ctx-ring')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test('the address follows the open chat, and back/forward switch chats', async ({ page, crew }) => {
  const chats = (await crew.api('GET', '/bootstrap')).chats.slice(0, 2);
  const title = page.locator('.chat-head .ch-title');
  await page.goto(`${crew.base}/#/chat/${chats[0].id}`);
  await expect(title).toHaveText(chats[0].title);
  await page.locator(`.chat-item[data-chat="${chats[1].id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${chats[1].id}$`));
  await page.goBack();
  await expect(title).toHaveText(chats[0].title);
  await page.goForward();
  await expect(title).toHaveText(chats[1].title);
  // A link to another chat, e.g. typed into the address bar.
  await page.evaluate((id) => {
    location.hash = `#/chat/${id}`;
  }, chats[0].id);
  await expect(title).toHaveText(chats[0].title);
});
