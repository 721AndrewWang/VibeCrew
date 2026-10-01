// The packaged desktop app, each test in a throwaway HOME so the real profile and icon theme are
// never touched: its icons follow the logo setting, and an old VibeCrew home is migrated.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { freePort, ROOT, tempDir } from '../helpers/server';

const EXE = path.join(ROOT, 'release/linux-unpacked/crew');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

test.skip(!fs.existsSync(EXE), 'run `npm run desktop:pack` first');

function envFor(home: string, port: number, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC_|CREW_|VIBECREW_|XDG_CONFIG_HOME$|XDG_DATA_HOME$)/.test(k)) env[k] = v;
  return { ...env, HOME: home, CREW_PORT: String(port), CREW_FAKE_AGENT: '1', ...extra };
}

async function launch(env: Record<string, string>, args: string[] = []) {
  const app = await electron.launch({ executablePath: EXE, args: ['--no-sandbox', ...args], env, timeout: 60_000 });
  const win = await app.firstWindow();
  const firstUrl = win.url();
  await expect.poll(() => win.url(), { timeout: 30_000 }).toMatch(/^http:\/\/127\.0\.0\.1:/);
  await win.waitForSelector('.brand', { timeout: 60_000 });
  return { app, win, firstUrl };
}

test('window, tray and installed Dock icons follow the logo setting', async () => {
  const root = tempDir('crew-desktop-logo');
  const home = path.join(root, 'home');
  const theme = path.join(home, '.local/share/icons/hicolor');
  const vchome = path.join(root, 'crewhome');
  // An "installed" app: menu entry plus the default icons, as desktop/install.mjs leaves them.
  fs.mkdirSync(path.join(home, '.local/share/applications'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/share/applications/crew.desktop'), '[Desktop Entry]\nName=Crew\nIcon=crew\n');
  for (const s of SIZES) {
    fs.mkdirSync(path.join(theme, `${s}x${s}/apps`), { recursive: true });
    fs.copyFileSync(path.join(ROOT, `desktop/icons/${s}x${s}.png`), path.join(theme, `${s}x${s}/apps/crew.png`));
  }
  const themeIs = (id: string) => SIZES.every((s) => fs.readFileSync(path.join(theme, `${s}x${s}/apps/crew.png`)).equals(fs.readFileSync(path.join(ROOT, `desktop/logos/${id}/${s}x${s}.png`))));
  const port = await freePort();
  const env = envFor(home, port, { CREW_HOME: vchome, CREW_PROJECTS: path.join(root, 'projects') });
  const log = () => (fs.existsSync(path.join(vchome, 'logs/server.log')) ? fs.readFileSync(path.join(vchome, 'logs/server.log'), 'utf8') : '');
  try {
    let { app, win, firstUrl } = await launch(env, [`--user-data-dir=${path.join(root, 'ud')}`]);
    expect(firstUrl).toMatch(/loading\.html/);
    expect(themeIs('c')).toBe(true);

    // Changed through the API (another device): the Dock icons follow.
    await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logo: 'orbit' }) });
    await expect.poll(() => themeIs('orbit'), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => log(), { timeout: 15_000 }).toContain('logo: orbit');

    // Changed in the window's own Settings page.
    await win.locator('.sb-nav-item[title="设置"]').click();
    await win.locator('.logo-choice', { hasText: '声波' }).click();
    await expect.poll(() => themeIs('wave'), { timeout: 15_000 }).toBe(true);
    expect(await win.locator('.brand .logo').innerHTML()).toContain('M42 48V80');
    await app.close();

    // Changed while closed: synced at the next start, loading page included.
    const sfile = path.join(vchome, 'settings.json');
    fs.writeFileSync(sfile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sfile, 'utf8')), logo: 'bot' }));
    ({ app, win, firstUrl } = await launch(env, [`--user-data-dir=${path.join(root, 'ud')}`]));
    expect(firstUrl).toContain('logo=bot');
    await expect.poll(() => themeIs('bot'), { timeout: 15_000 }).toBe(true);
    await app.close();

    // Not installed (no menu entry): the icon theme is left alone.
    fs.rmSync(path.join(home, '.local/share/applications/crew.desktop'));
    fs.writeFileSync(sfile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sfile, 'utf8')), logo: 'code' }));
    ({ app } = await launch(env, [`--user-data-dir=${path.join(root, 'ud')}`]));
    await new Promise((r) => setTimeout(r, 2500));
    expect(themeIs('bot')).toBe(true);
    await app.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A home folder as VibeCrew (the old name) left it. */
function oldHome(home: string) {
  fs.mkdirSync(path.join(home, '.config', 'VibeCrew'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'VibeCrew', 'marker.txt'), 'profile');
  fs.mkdirSync(path.join(home, '.vibecrew'), { recursive: true });
  fs.writeFileSync(path.join(home, '.vibecrew', 'settings.json'), JSON.stringify({ token: 'x', initialized: true, defaultPermission: 'ask' }));
  fs.writeFileSync(path.join(home, '.vibecrew', 'desktop.json'), JSON.stringify({ trayNoticeShown: true, bounds: { width: 1111, height: 777 } }));
}

test('first start after the rename moves the browser profile and the data', async () => {
  const root = tempDir('crew-desktop-migrate');
  const home = path.join(root, 'home');
  oldHome(home);
  const port = await freePort();
  try {
    const { app, win } = await launch(envFor(home, port));
    expect(fs.existsSync(path.join(home, '.config', 'Crew', 'marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.config', 'VibeCrew'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.crew', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.vibecrew'))).toBe(false);
    const b = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
    expect(b.settings.defaultPermission).toBe('ask');
    // The window state was read after the move (frame decorations add a few pixels).
    expect(Math.abs((await win.evaluate(() => window.outerWidth)) - 1111)).toBeLessThan(30);
    expect(await win.title()).toBe('Crew');
    await app.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to start next to a running VibeCrew, moving nothing', async () => {
  const root = tempDir('crew-desktop-legacy');
  const home = path.join(root, 'home');
  oldHome(home);
  // A live VibeCrew: its lock points at a running process (this one).
  fs.symlinkSync(`somehost-${process.pid}`, path.join(home, '.config', 'VibeCrew', 'SingletonLock'));
  try {
    const child = spawn(EXE, ['--no-sandbox'], { env: envFor(home, await freePort()), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('timeout');
      }, 20_000);
      child.on('exit', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(code).toBe(0);
    expect(out).toContain('旧版 VibeCrew');
    expect(fs.existsSync(path.join(home, '.vibecrew'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.config', 'VibeCrew', 'marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.crew'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
