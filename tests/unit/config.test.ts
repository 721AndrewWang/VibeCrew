import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findChrome, playwrightCacheDir, playwrightChromes } from '../../server/config';
import { tempDir } from '../helpers/server';

const home = os.homedir();

describe('playwrightCacheDir', () => {
  it('is the platform cache folder Playwright installs browsers into', () => {
    expect(playwrightCacheDir('darwin', {})).toBe(path.join(home, 'Library', 'Caches', 'ms-playwright'));
    expect(playwrightCacheDir('linux', {})).toBe(path.join(home, '.cache', 'ms-playwright'));
    expect(playwrightCacheDir('linux', { XDG_CACHE_HOME: '/xdg' })).toBe(path.join('/xdg', 'ms-playwright'));
    expect(playwrightCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe(path.join('C:\\Users\\me\\AppData\\Local', 'ms-playwright'));
    expect(playwrightCacheDir('win32', {})).toBe(path.join(home, 'AppData', 'Local', 'ms-playwright'));
  });

  it('follows PLAYWRIGHT_BROWSERS_PATH, except 0, which keeps browsers inside the package', () => {
    expect(playwrightCacheDir('linux', { PLAYWRIGHT_BROWSERS_PATH: '/srv/pw' })).toBe(path.resolve('/srv/pw'));
    expect(playwrightCacheDir('linux', { PLAYWRIGHT_BROWSERS_PATH: 'pw', INIT_CWD: '/proj' })).toBe(path.join('/proj', 'pw'));
    expect(playwrightCacheDir('darwin', { PLAYWRIGHT_BROWSERS_PATH: '0' })).toBeNull();
  });
});

describe('playwrightChromes', () => {
  const MAC = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];

  it("lists each build's executable in the platform's layout: newest build first, the headless shell after the full builds", () => {
    const cache = tempDir('crew-pw');
    for (const d of ['chromium-999', 'chromium-1234', 'chromium_headless_shell-1234', 'chromium-tip-of-tree-5', 'ffmpeg-1011']) fs.mkdirSync(path.join(cache, d));
    const mac = playwrightChromes(cache, 'darwin');
    const newest = mac.indexOf(path.join(cache, 'chromium-1234', 'chrome-mac-arm64', ...MAC));
    const older = mac.indexOf(path.join(cache, 'chromium-999', 'chrome-mac-arm64', ...MAC));
    const shell = mac.indexOf(path.join(cache, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
    expect(newest).toBe(0); // 1234 > 999 as numbers, not as strings
    expect(older).toBeGreaterThan(newest);
    expect(shell).toBeGreaterThan(older);
    expect(mac).toContain(path.join(cache, 'chromium-1234', 'chrome-mac-x64', ...MAC));
    expect(mac.some((p) => p.includes('tip-of-tree') || p.includes('ffmpeg'))).toBe(false);

    expect(playwrightChromes(cache, 'linux')[0]).toBe(path.join(cache, 'chromium-1234', 'chrome-linux64', 'chrome'));
    expect(playwrightChromes(cache, 'win32')[0]).toBe(path.join(cache, 'chromium-1234', 'chrome-win64', 'chrome.exe'));
  });

  it('is empty without a cache folder', () => {
    expect(playwrightChromes(path.join(tempDir('crew-pw'), 'missing'), 'linux')).toEqual([]);
  });
});

describe('findChrome', () => {
  it('takes CREW_CHROME_PATH first, and forgets a binary that has gone', () => {
    const dir = tempDir('crew-chrome');
    const bin = path.join(dir, 'chrome');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    process.env.CREW_CHROME_PATH = bin;
    try {
      expect(findChrome()).toBe(bin);
      fs.rmSync(bin);
      expect(findChrome()).not.toBe(bin);
    } finally {
      delete process.env.CREW_CHROME_PATH;
    }
  });
});
