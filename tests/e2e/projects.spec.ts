// The "open an existing folder" path box starts out holding the current folder; what the user
// types or pastes there must replace it, not be appended to it.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

test('typing or pasting a full path replaces the folder already in the box', async ({ page, crew }) => {
  const target = path.join(crew.dir, 'elsewhere', 'my-app');
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  await page.goto(crew.base);
  await page.locator('.sb-nav-item[title="项目"]').click();
  await page.locator('.page button', { hasText: '打开文件夹' }).first().click();
  const box = page.locator('.fb-bar input');
  await expect(box).not.toHaveValue('');
  const start = await box.inputValue();

  // Click in and type: the old folder goes away.
  await box.click();
  await page.keyboard.type(target);
  await expect(box).toHaveValue(target);
  await page.keyboard.press('Enter');
  await expect(page.locator('.fb-item', { hasText: 'src' })).toBeVisible();

  // Paste with the caret at the end: still replaced.
  await box.click();
  await page.keyboard.press('End');
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, start);
  await expect(box).toHaveValue(start);

  // A folder name (not a full path) is still typed where the caret is.
  await box.click();
  await page.keyboard.press('End');
  await page.keyboard.type('/x');
  await expect(box).toHaveValue(`${start}/x`);
});
