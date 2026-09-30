// Renders the logos in shared/logos.ts into icon files with headless Chrome:
//   web/public/icon.svg, icon-{192,512}.png           the default logo (favicon, web app manifest)
//   web/public/logos/<id>-{192,512}.png               every logo; the server serves the chosen one
//   desktop/icons/{16..512}x{16..512}.png, tray.png   the default logo (AppImage, first install)
//   desktop/logos/<id>/…                              every logo; the desktop app follows the setting
//
//   npm run icons
//
// Uses CREW_CHROME_PATH / CHROME_PATH if set, like the server does.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appIconSvg, DEFAULT_LOGO, LOGOS } from '../shared/logos.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = process.env.CREW_CHROME_PATH || process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DESKTOP_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

const browser = await chromium.launch({ executablePath, headless: true });
const render = async (svg, size, out) => {
  fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(root, out), omitBackground: true });
  await page.close();
};
const desktopSet = async (svg, dir) => {
  for (const s of DESKTOP_SIZES) await render(svg, s, `${dir}/${s}x${s}.png`);
  await render(svg, 32, `${dir}/tray.png`);
};
try {
  for (const { id } of LOGOS) {
    const svg = appIconSvg(id);
    for (const s of [192, 512]) await render(svg, s, `web/public/logos/${id}-${s}.png`);
    await desktopSet(svg, `desktop/logos/${id}`);
  }
  const svg = appIconSvg(DEFAULT_LOGO);
  fs.writeFileSync(path.join(root, 'web', 'public', 'icon.svg'), svg);
  for (const s of [192, 512]) await render(svg, s, `web/public/icon-${s}.png`);
  await desktopSet(svg, 'desktop/icons');
} finally {
  await browser.close();
}
console.log(`icons for ${LOGOS.length} logos written to web/public and desktop/`);
