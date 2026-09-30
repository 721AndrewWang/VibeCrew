// Builds the VibeCrew AppImage and installs it for the current user:
//   ~/Applications/VibeCrew.AppImage
//   ~/.local/share/applications/vibecrew.desktop   (app menu / dock entry)
//   ~/.local/share/icons/hicolor/<size>/apps/vibecrew.png
//
//   npm run desktop:install            build + install (or update)
//   npm run desktop:install -- --skip-build   install the AppImage already in release/
//   npm run desktop:uninstall          remove all of the above (your data in ~/.vibecrew stays)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = os.homedir();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const APP_DIR = path.join(home, 'Applications');
const APPIMAGE = path.join(APP_DIR, 'VibeCrew.AppImage');
const DESKTOP_FILE = path.join(home, '.local', 'share', 'applications', 'vibecrew.desktop');
const ICON_ROOT = path.join(home, '.local', 'share', 'icons', 'hicolor');
const AUTOSTART_FILE = path.join(home, '.config', 'autostart', 'vibecrew.desktop');
const APPARMOR_PROFILE = '/etc/apparmor.d/vibecrew';
/** Optional root-owned install made by `sudo desktop/install-system.sh` (runs sandboxed). */
const SYSTEM_BIN = '/opt/VibeCrew/vibecrew';
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

const args = new Set(process.argv.slice(2));

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} 失败（退出码 ${r.status}）`);
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
 * How the launcher starts VibeCrew. The system install in /opt (with its AppArmor profile) runs
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
    'Name=VibeCrew',
    'GenericName=AI 开发小队',
    'Comment=Web 开发 AI 机器人小队（基于 Claude Code）',
    `Exec=${cmd} %U`,
    'Icon=vibecrew',
    'Terminal=false',
    // Electron names the X11 window class after the executable.
    'StartupWMClass=vibecrew',
    // Reopening while VibeCrew sits in the tray (or the quit action) maps no new window, which
    // would leave GNOME's busy cursor spinning for ~15 s.
    'StartupNotify=false',
    'Categories=Development;IDE;',
    'Keywords=AI;Claude;Web;Bot;Agent;前端;机器人;',
    'Actions=show;quit;',
    '',
    '[Desktop Action show]',
    'Name=打开窗口',
    `Exec=${cmd}`,
    '',
    '[Desktop Action quit]',
    'Name=退出 VibeCrew（停止所有机器人）',
    `Exec=${cmd} --quit`,
    '',
  ].join('\n');
}

/** The pid of a running VibeCrew desktop instance, from Electron's single-instance lock. */
function runningInstance() {
  try {
    const target = fs.readlinkSync(path.join(home, '.config', 'VibeCrew', 'SingletonLock'));
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

/** True when /opt/VibeCrew holds a different build than release/ (install-system.sh copies with cp -a). */
function systemCopyStale() {
  const same = (rel) => {
    try {
      const a = fs.statSync(path.join(root, 'release', 'linux-unpacked', rel));
      const b = fs.statSync(path.join('/opt/VibeCrew', rel));
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
  for (const s of SIZES) fs.rmSync(path.join(ICON_ROOT, `${s}x${s}`, 'apps', 'vibecrew.png'), { force: true });
  tryRun('update-desktop-database', [path.dirname(DESKTOP_FILE)]);
  refreshIcons();
  console.log('已卸载 VibeCrew 桌面应用。你的数据（~/.vibecrew）和项目都保留着。');
  if (fs.existsSync(SYSTEM_BIN)) console.log(`系统安装还在 /opt/VibeCrew，用 sudo ${path.join(root, 'desktop', 'install-system.sh')} --remove 删除。`);
}

function install() {
  if (!args.has('--skip-build')) run('npm', ['run', 'desktop:pack']);

  const built = path.join(root, 'release', `VibeCrew-${pkg.version}.AppImage`);
  if (!fs.existsSync(built)) throw new Error(`找不到 ${built}，请先运行 npm run desktop:pack`);

  // Replace atomically so a running copy keeps working until it restarts.
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = `${APPIMAGE}.new`;
  fs.copyFileSync(built, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, APPIMAGE);

  for (const s of SIZES) {
    const dir = path.join(ICON_ROOT, `${s}x${s}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(root, 'desktop', 'icons', `${s}x${s}.png`), path.join(dir, 'vibecrew.png'));
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
✅ VibeCrew ${pkg.version} 已安装
   启动：  ${usingSystem ? `${SYSTEM_BIN}（系统安装，沙盒已开启）` : APPIMAGE}
   菜单：  在「显示应用」里搜索 VibeCrew（可右键「固定到 Dock」）
   数据：  ~/.vibecrew（和 npm start 共用）
`);
  const systemStale = usingSystem && systemCopyStale();
  if (systemStale) {
    console.log(`⚠️  菜单启动的是 /opt/VibeCrew，但那里还是旧的构建。先更新它：sudo ${path.join(root, 'desktop', 'install-system.sh')}\n`);
  }
  const pid = runningInstance();
  if (pid && !systemStale) {
    console.log(`⚠️  VibeCrew 正在运行（可能在托盘里，进程 ${pid}），它还是旧版本。
   从托盘菜单选择「退出」，再重新打开，就会用上新版本。
`);
  }
  if (!usingSystem && !hasLibfuse2()) {
    console.log(`⚠️  没有找到 libfuse.so.2，AppImage 会打不开。请先安装：sudo apt install libfuse2t64
`);
  }
  if (!sandboxed) {
    console.log(`ℹ️  Ubuntu 默认限制了 Chromium 沙盒，所以 VibeCrew 以 --no-sandbox 运行（和大多数 Electron 应用一样）。
   想开启沙盒：sudo ${path.join(root, 'desktop', 'install-system.sh')}，然后重新运行 npm run desktop:install
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
