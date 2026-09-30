// Renders web/public/icon.svg into the PNG icons with headless Chrome:
//   web/public/icon-{192,512}.png                       (web app manifest)
//   desktop/icons/{16..512}x{16..512}.png, tray.png     (Electron window, tray, app menu)
//
//   npm run icons
//
// Uses VIBECREW_CHROME_PATH / CHROME_PATH if set, like the server does.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = fs.readFileSync(path.join(root, 'web', 'public', 'icon.svg'), 'utf8');
const executablePath = process.env.VIBECREW_CHROME_PATH || process.env.CHROME_PATH || '/usr/bin/google-chrome';

const browser = await chromium.launch({ executablePath, headless: true });
const render = async (size, out) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(root, out), omitBackground: true });
  await page.close();
};
try {
  for (const s of [192, 512]) await render(s, `web/public/icon-${s}.png`);
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) await render(s, `desktop/icons/${s}x${s}.png`);
  await render(32, 'desktop/icons/tray.png');
} finally {
  await browser.close();
}
console.log('icons written to web/public and desktop/icons');
