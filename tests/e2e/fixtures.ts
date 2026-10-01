import { test as base, expect, type Page } from '@playwright/test';
import { type CrewServer, startServer } from '../helpers/server';

export { expect };

/**
 * `crew`: a fresh server (own data, demo agent) for each test.
 * `page` fails the test when the page throws or logs a console error.
 * `openChat(page, id)` opens a chat by its address.
 */
export const test = base.extend<{ crew: CrewServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern here
  crew: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.stop();
  },
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await use(page);
    expect(errors, 'errors in the page').toEqual([]);
  },
});

export async function openChat(page: Page, crew: CrewServer, chatId: string) {
  await page.goto(`${crew.base}/#/chat/${chatId}`);
  await page.waitForSelector('.composer');
}
