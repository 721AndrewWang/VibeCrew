// Settings pages in the browser: the logo picker and the deny list.
import { expect, test } from './fixtures';

test('picking a logo changes the app, the tab icon and what the server serves', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="设置"]').click();
  const choices = page.locator('.logo-choice');
  await expect(choices).toHaveCount(6);
  await expect(page.locator('.logo-choice[aria-checked="true"]')).toContainText('C 字母');

  await choices.filter({ hasText: '代码括号' }).click();
  await expect(page.locator('.logo-choice[aria-checked="true"]')).toContainText('代码括号');
  await expect.poll(async () => page.locator('.brand .logo').innerHTML()).toContain('M49 42');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon.svg?logo=code');
  expect(await (await fetch(`${crew.base}/icon.svg`)).text()).toContain('M49 42');

  await page.reload();
  await expect.poll(async () => page.locator('.brand .logo').innerHTML()).toContain('M49 42');
  expect(await page.evaluate(() => localStorage.getItem('vc-logo'))).toBe('code');
});

test('the deny list is saved from the defaults section', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="设置"]').click();
  const field = page.locator('.field', { hasText: '禁止的操作' }).locator('textarea');
  await field.fill('Bash(*prod-server*)\n\nBash(rm -rf /*)');
  await page.locator('.card', { hasText: '默认值' }).locator('.btn.primary', { hasText: '保存' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.denyRules).toEqual(['Bash(*prod-server*)', 'Bash(rm -rf /*)']);
});

test('the sandbox section saves the switch and the domain list, and says when it cannot run here', async ({ page, crew }) => {
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="设置"]').click();
  const card = page.locator('.settings-card', { has: page.locator('h2', { hasText: '沙盒' }) });
  await expect(card.locator('.sr-title')).toContainText('关进沙盒');
  const status = await crew.api('GET', '/sandbox');
  await expect(card.locator('[data-testid="sandbox-unavailable"]')).toHaveCount(status.available ? 0 : 1);
  await card.locator('textarea').fill('registry.npmjs.org\nhttps://api.example.com/v1\nnonsense host\n10.0.0.5:8080');
  await card.locator('.btn.primary', { hasText: '保存' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.sandbox.allowedDomains).toEqual(['registry.npmjs.org', 'api.example.com', '10.0.0.5:8080']);
  await expect(card.locator('textarea')).toHaveValue('registry.npmjs.org\napi.example.com\n10.0.0.5:8080');
  await card.locator('.toggle').click();
  await card.locator('.btn.primary', { hasText: '保存' }).click();
  await expect.poll(async () => (await crew.api('GET', '/bootstrap')).settings.sandbox.enabled).toBe(false);
  await expect(card.locator('[data-testid="sandbox-unavailable"]')).toHaveCount(0);
});
