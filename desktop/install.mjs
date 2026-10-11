// Builds the Crew AppImage and installs it for the current user:
//   ~/Applications/Crew.AppImage
//   ~/.local/share/applications/crew.desktop   (app menu / dock entry)
//   ~/.local/share/icons/hicolor/<size>/apps/crew.png
//
//   npm run desktop:install            build + install (or update)
//   npm run desktop:install -- --skip-build   install the AppImage already in release/
//   npm run desktop:uninstall          remove all of the above (your data in ~/.crew stays)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = os.homedir();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const APP_DIR = path.join(home, 'Applications');
const APPIMAGE = path.join(APP_DIR, 'Crew.AppImage');
const DESKTOP_FILE = path.join(home, '.local', 'share', 'applications', 'crew.desktop');
const ICON_ROOT = path.join(home, '.local', 'share', 'icons', 'hicolor');
const AUTOSTART_FILE = path.join(home, '.config', 'autostart', 'crew.desktop');
const APPARMOR_PROFILE = '/etc/apparmor.d/crew';
/** Optional root-owned install made by `sudo desktop/install-system.sh` (runs sandboxed). */
const SYSTEM_BIN = '/opt/Crew/crew';
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const CREW_HOME = path.resolve(process.env.CREW_HOME || path.join(home, '.crew'));

const args = new Set(process.argv.slice(2));

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (exit code ${r.status})`);
}

function tryRun(cmd, cmdArgs) {
  try {
    execFileSync(cmd, cmdArgs, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * How the launcher starts Crew. The system install in /opt (with its AppArmor profile) runs
 * with Chromium's sandbox. The AppImage cannot: Ubuntu 23.10+ blocks the user namespaces the
 * sandbox needs, and its AppRun adds --no-sandbox by itself; the flag is written out to be explicit.
 */
function launcher() {
  if (fs.existsSync(SYSTEM_BIN) && fs.existsSync(APPARMOR_PROFILE)) return { cmd: SYSTEM_BIN, sandboxed: true };
  let restricted = false;
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
  } catch {
    /* older kernel: no restriction */
  }
  return { cmd: restricted ? `${APPIMAGE} --no-sandbox` : APPIMAGE, sandboxed: !restricted };
}

function desktopEntry(cmd) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Crew',
    'GenericName=AI Dev Team',
    'Comment=A team of AI bots for web development (built on Claude Code)',
    `Exec=${cmd} %U`,
    'Icon=crew',
    'Terminal=false',
    // Electron names the X11 window class after the executable.
    'StartupWMClass=crew',
    // Reopening while Crew sits in the tray (or the quit action) maps no new window, which
    // would leave GNOME's busy cursor spinning for ~15 s.
    'StartupNotify=false',
    'Categories=Development;IDE;',
    'Keywords=AI;Claude;Web;Bot;Agent;Frontend;Coding;',
    'Actions=show;quit;',
    '',
    '[Desktop Action show]',
    'Name=Open Window',
    `Exec=${cmd}`,
    '',
    '[Desktop Action quit]',
    'Name=Quit Crew (stops all bots)',
    `Exec=${cmd} --quit`,
    '',
  ].join('\n');
}

/** The pid of a running Crew desktop instance, from Electron's single-instance lock. */
function runningInstance() {
  try {
    const target = fs.readlinkSync(path.join(home, '.config', 'Crew', 'SingletonLock'));
    const pid = Number(target.split('-').pop());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function hasLibfuse2() {
  try {
    if (execFileSync('ldconfig', ['-p'], { encoding: 'utf8' }).includes('libfuse.so.2')) return true;
  } catch {
    /* fall through */
  }
  return ['/usr/lib/x86_64-linux-gnu/libfuse.so.2', '/usr/lib/aarch64-linux-gnu/libfuse.so.2', '/lib/x86_64-linux-gnu/libfuse.so.2'].some((f) => fs.existsSync(f));
}

/** True when /opt/Crew holds a different build than release/ (install-system.sh copies with cp -a). */
function systemCopyStale() {
  const same = (rel) => {
    try {
      const a = fs.statSync(path.join(root, 'release', 'linux-unpacked', rel));
      const b = fs.statSync(path.join('/opt/Crew', rel));
      return a.size === b.size && Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs);
    } catch {
      return false;
    }
  };
  return !['resources/app/dist-server/server.mjs', 'resources/app/web/dist/index.html', 'resources/app/desktop/main.cjs'].every(same);
}

/**
 * Makes GNOME pick up new icons without creating a user icon cache: a cache in
 * ~/.local/share/icons/hicolor would hide icons other tools copy there later.
 */
/** Icons of the logo chosen in Settings → Appearance (the running app keeps them in sync as well). */
function iconDir() {
  let id;
  // Before the first start after the rename, the settings are still in VibeCrew's folder.
  for (const dir of [CREW_HOME, path.join(home, '.vibecrew')]) {
    try {
      id = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).logo;
      break;
    } catch {
      /* no settings there */
    }
  }
  const dir = typeof id === 'string' && /^[a-z]+$/.test(id) ? path.join(root, 'desktop', 'logos', id) : '';
  return dir && fs.existsSync(dir) ? dir : path.join(root, 'desktop', 'icons');
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Crew used to be called VibeCrew. A running VibeCrew is asked to quit (it holds the port and the
 * data folder, which Crew moves to ~/.crew on its first start); its AppImage, menu entry and icons
 * go. Returns the text of its autostart entry, if it had one.
 */
function retireVibeCrew() {
  const appImage = path.join(APP_DIR, 'VibeCrew.AppImage');
  const desktopFile = path.join(home, '.local', 'share', 'applications', 'vibecrew.desktop');
  const autostart = path.join(home, '.config', 'autostart', 'vibecrew.desktop');
  const icons = SIZES.map((s) => path.join(ICON_ROOT, `${s}x${s}`, 'apps', 'vibecrew.png'));
  if (![appImage, desktopFile, autostart, ...icons].some((f) => fs.existsSync(f))) return null;
  let pid = null;
  try {
    pid =
      Number(
        fs
          .readlinkSync(path.join(home, '.config', 'VibeCrew', 'SingletonLock'))
          .split('-')
          .pop(),
      ) || null;
  } catch {
    /* not running */
  }
  if (pid && alive(pid)) {
    console.log(`Quitting the old VibeCrew (process ${pid}); its data moves over when Crew first starts...`);
    if (fs.existsSync(appImage)) spawnSync(appImage, ['--no-sandbox', '--quit'], { stdio: 'ignore', timeout: 15000 });
    else process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 60 && alive(pid); i++) sleepSync(500);
    if (alive(pid)) throw new Error('The old VibeCrew did not quit. Quit it from its tray menu, then run the install again.');
  }
  const autostartText = fs.existsSync(autostart) ? fs.readFileSync(autostart, 'utf8') : null;
  for (const f of [appImage, desktopFile, autostart, ...icons]) fs.rmSync(f, { force: true });
  tryRun('update-desktop-database', [path.dirname(desktopFile)]);
  console.log('Removed the old VibeCrew app, menu entry and icons.');
  return autostartText;
}

function refreshIcons() {
  const now = new Date();
  try {
    fs.utimesSync(ICON_ROOT, now, now);
  } catch {
    /* no theme dir */
  }
  if (fs.existsSync(path.join(ICON_ROOT, 'icon-theme.cache'))) tryRun('gtk-update-icon-cache', ['-f', '-t', ICON_ROOT]);
}

function uninstall() {
  // Ask a running instance to quit first so nothing keeps using the files.
  const bin = fs.existsSync(APPIMAGE) ? APPIMAGE : fs.existsSync(SYSTEM_BIN) ? SYSTEM_BIN : null;
  if (bin) spawnSync(bin, ['--no-sandbox', '--quit'], { stdio: 'ignore', timeout: 15000 });
  for (const f of [APPIMAGE, DESKTOP_FILE, AUTOSTART_FILE]) fs.rmSync(f, { force: true });
  for (const s of SIZES) fs.rmSync(path.join(ICON_ROOT, `${s}x${s}`, 'apps', 'crew.png'), { force: true });
  tryRun('update-desktop-database', [path.dirname(DESKTOP_FILE)]);
  refreshIcons();
  console.log('Uninstalled the Crew desktop app. Your data (~/.crew) and projects are kept.');
  if (fs.existsSync(SYSTEM_BIN)) console.log(`The system install in /opt/Crew is still there. Remove it with: sudo ${path.join(root, 'desktop', 'install-system.sh')} --remove`);
}

function install() {
  if (!args.has('--skip-build')) run('npm', ['run', 'desktop:pack']);

  const built = path.join(root, 'release', `Crew-${pkg.version}.AppImage`);
  if (!fs.existsSync(built)) throw new Error(`${built} not found. Run npm run desktop:pack first.`);

  const legacyAutostart = retireVibeCrew();
  if (legacyAutostart && !fs.existsSync(AUTOSTART_FILE)) {
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
    fs.writeFileSync(AUTOSTART_FILE, legacyAutostart.replace(/VibeCrew/g, 'Crew').replace(/vibecrew/g, 'crew'));
  }

  // Replace atomically so a running copy keeps working until it restarts.
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = `${APPIMAGE}.new`;
  fs.copyFileSync(built, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, APPIMAGE);

  const icons = iconDir();
  for (const s of SIZES) {
    const dir = path.join(ICON_ROOT, `${s}x${s}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(icons, `${s}x${s}.png`), path.join(dir, 'crew.png'));
  }
  refreshIcons();

  const { cmd, sandboxed } = launcher();
  fs.mkdirSync(path.dirname(DESKTOP_FILE), { recursive: true });
  fs.writeFileSync(DESKTOP_FILE, desktopEntry(cmd));
  tryRun('update-desktop-database', [path.dirname(DESKTOP_FILE)]);

  // Keep an existing autostart entry pointing at the right command (and its enabled state).
  if (fs.existsSync(AUTOSTART_FILE)) {
    const text = fs.readFileSync(AUTOSTART_FILE, 'utf8').replace(/^Exec=.*$/m, `Exec=${cmd} --hidden`);
    fs.writeFileSync(AUTOSTART_FILE, text);
  }

  const usingSystem = cmd === SYSTEM_BIN;
  console.log(`
✅ Crew ${pkg.version} installed
   Launch:  ${usingSystem ? `${SYSTEM_BIN} (system install, sandbox on)` : APPIMAGE}
   Menu:    search for Crew in "Show Apps" (right-click it to "Pin to Dock")
   Data:    ~/.crew (shared with npm start)
`);
  const systemStale = usingSystem && systemCopyStale();
  if (systemStale) {
    console.log(`⚠️  The menu launches /opt/Crew, but that is still an old build. Update it first: sudo ${path.join(root, 'desktop', 'install-system.sh')}\n`);
  }
  const pid = runningInstance();
  if (pid && !systemStale) {
    console.log(`⚠️  Crew is running (maybe in the tray, process ${pid}) and is still the old version.
   Choose "Quit" from the tray menu, then reopen it to use the new version.
`);
  }
  if (!usingSystem && !hasLibfuse2()) {
    console.log(`⚠️  libfuse.so.2 not found, so the AppImage will not open. Install it first: sudo apt install libfuse2t64
`);
  }
  if (!sandboxed) {
    console.log(`ℹ️  Ubuntu restricts the Chromium sandbox by default, so Crew runs with --no-sandbox (like most Electron apps).
   To enable the sandbox: sudo ${path.join(root, 'desktop', 'install-system.sh')}, then run npm run desktop:install again
`);
  }
}

try {
  if (args.has('--uninstall')) uninstall();
  else install();
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
