'use strict';
// VibeCrew desktop shell: runs the VibeCrew server as a child process, shows the UI in a
// window, and keeps the bots working from the tray after the window is closed.

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'dist-server', 'server.mjs');
const HOME_DIR = path.resolve(process.env.VIBECREW_HOME || path.join(os.homedir(), '.vibecrew'));
const STATE_FILE = path.join(HOME_DIR, 'desktop.json');
const LOG_DIR = path.join(HOME_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const ICON = path.join(__dirname, 'icons', '512x512.png');
const TRAY_ICON = path.join(__dirname, 'icons', 'tray.png');
const LOADING_PAGE = path.join(__dirname, 'loading.html');
const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'vibecrew.desktop');

const startHidden = process.argv.includes('--hidden');
const wantsQuit = process.argv.includes('--quit');

app.setName('VibeCrew');

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
/** The server process this app started (never an external one). */
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let childPort = 0;
/** Port of the server the UI is showing. */
let serverPort = 0;
/** Showing a server someone else started (e.g. `npm start`); we never stop it. */
let attached = false;
let quitting = false;
let booting = false;
let lostDuringBoot = false;
let relaunchRequested = false;
let shownOnce = false;
let lastExternalOpen = 0;
/** Which server the window's page was loaded from; null after a failed load. */
let loadedFrom = null;
const crashes = [];
let attachedMisses = 0;

// ---------------------------------------------------------------- small helpers

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const state = readJson(STATE_FILE, {});

function saveState() {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch {
    /* not fatal */
  }
}

function log(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[desktop ${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

function logTail(lines = 30) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function configuredPort() {
  const fromEnv = Number(process.env.VIBECREW_PORT);
  if (fromEnv) return fromEnv;
  const s = readJson(path.join(HOME_DIR, 'settings.json'), {});
  return Number(s.port) || 4321;
}

const appOrigin = () => `http://127.0.0.1:${serverPort}`;
const childAlive = () => !!child && child.exitCode === null && child.signalCode === null;

/**
 * What answers on the port: { kind: 'vibecrew', pid } for a VibeCrew server, 'free' when nothing
 * listens, 'foreign' when some other HTTP server answers, 'other' for timeouts and resets.
 */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.ok === true && j.app === 'vibecrew' ? { kind: 'vibecrew', pid: j.pid } : { kind: 'foreign' });
        } catch {
          resolve({ kind: 'foreign' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ kind: e && e.code === 'ECONNREFUSED' ? 'free' : 'other' }));
  });
}

async function findFreePort(from) {
  for (let p = from; p < from + 40; p++) if ((await probe(p)).kind === 'free') return p;
  return 0;
}

// ---------------------------------------------------------------- server environment

/** Drops entries the AppImage launcher prepended (its bundled libraries must not reach other programs). */
function withoutAppDir(value, appdir) {
  return String(value || '')
    .split(':')
    .filter((p) => p && !p.includes('/.mount_') && !(appdir && (p === appdir || p.startsWith(`${appdir}/`))))
    .filter((p, i, all) => all.indexOf(p) === i)
    .join(':');
}

const SHELL_MARK = '__VIBECREW_ENV__';

/**
 * Apps started from the dock or at login get a minimal environment: nothing from ~/.bashrc,
 * such as PATH additions (nvm, ~/.local/bin) or proxy settings (http_proxy, which Claude Code
 * may need to reach Anthropic). Ask an interactive login shell for the environment a terminal
 * would have. Bounded by a hard timeout: an interactive shell ignores SIGTERM and rc files can block.
 */
function loginShellEnv(env) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let proc = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    try {
      proc = spawn(env.SHELL || '/bin/bash', ['-ilc', `printf '${SHELL_MARK}'; env -0; printf '${SHELL_MARK}'`], {
        env: { ...env, TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch {
      finish(null);
      return;
    }
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => {
      out += c;
      const start = out.indexOf(SHELL_MARK);
      const end = start >= 0 ? out.indexOf(SHELL_MARK, start + SHELL_MARK.length) : -1;
      if (end < 0) return;
      const vars = {};
      for (const entry of out.slice(start + SHELL_MARK.length, end).split('\0')) {
        const i = entry.indexOf('=');
        if (i > 0) vars[entry.slice(0, i)] = entry.slice(i + 1);
      }
      finish(vars);
    });
    proc.on('error', () => finish(null));
    proc.on('exit', () => setTimeout(() => finish(null), 50));
  });
}

/** Variables that describe the capturing shell itself, not the user's setup. */
const SHELL_ONLY = /^(PWD|OLDPWD|SHLVL|_|TERM|COLUMNS|LINES|PS[0-9]|PROMPT_COMMAND|BASH_.*|HIST.*)$/;
const DESKTOP_ONLY = /^(ELECTRON_|CHROME_DESKTOP$|APPIMAGE$|APPDIR$|OWD$|ARGV0$|DESKTOP_STARTUP_ID$)/;

/**
 * NODE_OPTIONS as the user set it. A packaged Electron filters its own copy before any JS runs
 * (and Chromium reuses the process's environ memory for its title), so there the value comes
 * from the login shell below, which reads the same ~/.profile and ~/.bashrc as a terminal.
 */
function originalNodeOptions() {
  return app.isPackaged ? undefined : process.env.NODE_OPTIONS;
}

async function serverEnv(port) {
  const env = { ...process.env };
  const appdir = env.APPDIR;
  let nodeOptions = originalNodeOptions();
  // Nothing the bots start (shells, dev servers, other Electron apps) should see these.
  for (const k of Object.keys(env)) if (DESKTOP_ONLY.test(k)) delete env[k];
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) {
    env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    const v = withoutAppDir(env[k], appdir);
    if (v) env[k] = v;
    else delete env[k];
  }

  // The shell must start from the user's own NODE_OPTIONS, not Electron's rewritten copy.
  const shellInput = { ...env };
  if (nodeOptions === undefined) delete shellInput.NODE_OPTIONS;
  else shellInput.NODE_OPTIONS = nodeOptions;
  const shell = await loginShellEnv(shellInput);
  if (shell) {
    for (const [k, v] of Object.entries(shell)) {
      if (SHELL_ONLY.test(k) || DESKTOP_ONLY.test(k) || k.startsWith('VIBECREW_')) continue;
      if (k === 'NODE_OPTIONS') nodeOptions = v;
      else if (k === 'PATH') env.PATH = [v, env.PATH].filter(Boolean).join(':');
      else env[k] = v;
    }
  } else {
    log('could not read the login shell environment; using the desktop session environment');
  }
  for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    const v = withoutAppDir(env[k], appdir);
    if (v) env[k] = v;
    else delete env[k];
  }

  // The server itself runs without the user's NODE_OPTIONS; it hands them back to what it starts.
  delete env.NODE_OPTIONS;
  if (nodeOptions) env.VIBECREW_USER_NODE_OPTIONS = nodeOptions;
  env.ELECTRON_RUN_AS_NODE = '1';
  env.VIBECREW_DESKTOP = '1';
  env.VIBECREW_PORT = String(port);
  return env;
}

// ---------------------------------------------------------------- server process

async function startServer(port) {
  const env = await serverEnv(port);
  let out = 'ignore';
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      /* no log yet */
    }
    out = fs.openSync(LOG_FILE, 'a');
  } catch (e) {
    // Without a writable log the server can still run.
    console.error(`[vibecrew] cannot open ${LOG_FILE}: ${e && e.message}`);
  }
  log(`starting server on port ${port}`);
  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: os.homedir(), env, stdio: ['ignore', out, out] });
  if (typeof out === 'number') fs.closeSync(out);
  child = proc;
  childPort = port;
  proc.on('exit', (code, signal) => {
    log(`server exited (${signal || `code ${code}`})`);
    // Exits of servers we stopped or replaced on purpose are not crashes.
    if (child !== proc) return;
    child = null;
    if (quitting) return;
    if (booting) lostDuringBoot = true;
    else void onServerLost();
  });
  proc.on('error', (e) => log(`server failed to start: ${e.message}`));
  return proc;
}

/** 'ours' once this very process answers on the port, 'exited' if it died, else 'timeout'. */
function waitForServer(proc, port, ms) {
  const until = Date.now() + ms;
  const gone = () => proc.exitCode !== null || proc.signalCode !== null;
  return new Promise((resolve) => {
    const tick = async () => {
      if (gone()) return resolve('exited');
      const found = await probe(port);
      if (found.kind === 'vibecrew' && found.pid === proc.pid) return resolve('ours');
      if (gone()) return resolve('exited');
      if (quitting || Date.now() > until) return resolve('timeout');
      setTimeout(tick, 250);
    };
    void tick();
  });
}

/** Stops the server this app started. Its exit is intentional, so it is not treated as a crash. */
function stopServer(timeoutMs = 8000) {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function onServerLost() {
  if (quitting) return;
  const now = Date.now();
  while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
  crashes.push(now);
  if (crashes.length > 3) {
    showError('VibeCrew 服务多次意外退出', logTail());
    return;
  }
  showLoading('服务意外退出，正在重新启动…');
  await boot();
}

/**
 * Shows the server's UI. A page already loaded from this same server is left alone (it
 * reconnects by itself); after a failed load or a switch to another server it is reloaded.
 */
async function loadUi(source) {
  updateTray();
  if (!win || win.isDestroyed()) return;
  const target = `${appOrigin()}/`;
  if (loadedFrom === source && win.webContents.getURL().startsWith(target)) return;
  try {
    await win.loadURL(target);
    loadedFrom = source;
  } catch (e) {
    loadedFrom = null;
    log(`could not load UI: ${e && e.message}`);
  }
}

async function boot() {
  if (booting || quitting) return;
  booting = true;
  lostDuringBoot = false;
  try {
    // Our own server may still be running (a retry, or a reload after a network hiccup).
    if (childAlive()) {
      const found = await probe(childPort);
      if (found.kind === 'vibecrew' && child && found.pid === child.pid) {
        attached = false;
        serverPort = childPort;
        await loadUi(`own:${found.pid}`);
        return;
      }
      await stopServer();
    }
    let port = configuredPort();
    let portRejected = false;
    for (let attempt = 0; attempt < 3 && !quitting; attempt++) {
      const found = await probe(port);
      if (found.kind === 'vibecrew') {
        attached = true;
        attachedMisses = 0;
        serverPort = port;
        log(`attached to running server on port ${port}`);
        await loadUi(`ext:${port}:${found.pid}`);
        return;
      }
      // A port the server could not bind although nothing answers on 127.0.0.1 (e.g. a
      // listener on a LAN address while 手机访问 binds 0.0.0.0) is treated as taken.
      if (found.kind === 'other' || found.kind === 'foreign' || portRejected) {
        const free = await findFreePort(port + 1);
        if (!free) {
          showError(`端口 ${port} 被其他程序占用，也没有找到可用的端口`, '');
          return;
        }
        log(`port ${port} is used by another program, using ${free}`);
        port = free;
      }
      if (!fs.existsSync(SERVER_ENTRY)) {
        showError('找不到 VibeCrew 服务文件', `缺少 ${SERVER_ENTRY}\n请先运行 npm run build:desktop`);
        return;
      }
      portRejected = false;
      const proc = await startServer(port);
      const result = await waitForServer(proc, port, 60_000);
      if (quitting) return;
      if (result === 'ours') {
        attached = false;
        serverPort = port;
        await loadUi(`own:${proc.pid}`);
        return;
      }
      if (result === 'timeout') {
        await stopServer();
        showError('VibeCrew 服务启动超时', logTail());
        return;
      }
      // It exited. Code 3 means the port could not be bound: look again, and if nothing
      // answers there, move on to another port.
      lostDuringBoot = false;
      if (proc.exitCode !== 3) {
        showError('VibeCrew 服务没能启动', logTail());
        return;
      }
      portRejected = true;
    }
    if (!quitting) showError('VibeCrew 服务没能启动', logTail());
  } catch (e) {
    log(`boot failed: ${e && e.stack}`);
    if (!quitting) showError('VibeCrew 服务没能启动', String((e && e.message) || e));
  } finally {
    booting = false;
    if (lostDuringBoot && !quitting && !attached && !childAlive()) {
      lostDuringBoot = false;
      void onServerLost();
    }
  }
}

/** An attached server may stop (its terminal closed); take over once it is really gone. */
setInterval(async () => {
  if (quitting || booting || !attached || !serverPort) return;
  const found = await probe(serverPort);
  // A refused connection or another program on the port counts; a restarting `tsx watch` is
  // back within a few seconds, and timeouts are not proof that it is gone.
  attachedMisses = found.kind === 'free' || found.kind === 'foreign' ? attachedMisses + 1 : 0;
  if (attachedMisses >= 3) {
    attachedMisses = 0;
    log('attached server went away, starting our own');
    attached = false;
    await boot();
  }
}, 5000).unref();

// ---------------------------------------------------------------- window

function isAppUrl(url) {
  if (url.startsWith('file://')) return url.startsWith(`file://${LOADING_PAGE}`) || url.startsWith(`file://${encodeURI(LOADING_PAGE)}`);
  return !!serverPort && (url.startsWith(`http://127.0.0.1:${serverPort}/`) || url.startsWith(`http://localhost:${serverPort}/`));
}

function showLoading(message) {
  if (!win || win.isDestroyed()) return;
  void win.loadFile(LOADING_PAGE, { query: { state: 'loading', msg: message } }).catch(() => {});
}

function showError(title, detail) {
  log(`error: ${title}`);
  if (!win || win.isDestroyed()) return;
  void win.loadFile(LOADING_PAGE, { query: { state: 'error', msg: title, detail: detail || '' } }).catch(() => {});
  showWindow();
}

/** Opens http(s) links in the user's browser, but not for pages acting on their own in the background. */
function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) return;
  const now = Date.now();
  if (now - lastExternalOpen < 1000) return;
  lastExternalOpen = now;
  void shell.openExternal(url);
}

/** Saved bounds if they still fit a connected display, otherwise a size that fits the screen. */
function initialBounds() {
  const b = state.bounds;
  if (b && b.width && b.height) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y < a.y + a.height - 100 && b.y + b.height > a.y;
    });
    if (visible) return b;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.min(1440, Math.round(area.width * 0.92)), height: Math.min(920, Math.round(area.height * 0.92)) };
}

function createWindow() {
  const b = initialBounds();
  shownOnce = false;
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: typeof b.x === 'number' ? b.x : undefined,
    y: typeof b.y === 'number' ? b.y : undefined,
    minWidth: 880,
    minHeight: 560,
    title: 'VibeCrew',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111114' : '#f4f4f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (!startHidden) showWindow();
  });

  let saveTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      state.maximized = win.isMaximized();
      if (!state.maximized && !win.isMinimized()) state.bounds = win.getBounds();
      saveState();
    }, 500);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);

  // Closing the window keeps VibeCrew running in the tray, like closing a chat app.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!state.trayNoticeShown && Notification.isSupported()) {
      state.trayNoticeShown = true;
      saveState();
      new Notification({
        title: 'VibeCrew 仍在后台运行',
        body: attached ? '窗口已隐藏，可以从托盘图标重新打开。' : '机器人和定时任务会继续工作。从托盘图标可以重新打开或退出。',
        icon: ICON,
      }).show();
    }
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.on('page-title-updated', (_e, title) => {
    const m = String(title).match(/^\((\d+)\)/);
    const unread = m ? Number(m[1]) : 0;
    app.setBadgeCount(unread);
    if (tray) tray.setToolTip(unread ? `VibeCrew · ${unread} 条未读` : 'VibeCrew');
  });
  wc.on('render-process-gone', (_e, details) => {
    log(`renderer gone: ${details.reason}`);
    if (!quitting && details.reason !== 'clean-exit') setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || quitting || code === -3) return;
    // The window now shows Chromium's error page at the app URL; make sure boot() reloads.
    loadedFrom = null;
    log(`load failed ${code} ${desc} ${url}`);
    if (url.startsWith('http')) setTimeout(() => void boot(), 1500);
  });
}

function showWindow() {
  if (quitting) return;
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  if (!shownOnce) {
    shownOnce = true;
    // maximize() also shows the window, so it waits until the window should appear.
    if (state.maximized) win.maximize();
  }
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- tray & autostart

/** True when this process runs from our own AppImage (APPIMAGE may be inherited from another one). */
function inOwnAppImage() {
  const appdir = process.env.APPDIR;
  return app.isPackaged && !!process.env.APPIMAGE && !!appdir && process.execPath.startsWith(`${appdir}/`);
}

function launchCommand() {
  const exe = inOwnAppImage() ? process.env.APPIMAGE : process.execPath;
  const args = app.isPackaged ? [] : [APP_ROOT];
  if (app.commandLine.hasSwitch('no-sandbox')) args.push('--no-sandbox');
  const quote = (s) => (/[\s"'\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s);
  return [exe, ...args].map(quote).join(' ');
}

function autostartEnabled() {
  try {
    const text = fs.readFileSync(AUTOSTART_FILE, 'utf8');
    // GNOME "Startup Applications" disables an entry without deleting it.
    return !/^\s*(X-GNOME-Autostart-enabled\s*=\s*(false|0)|Hidden\s*=\s*true)\s*$/im.test(text);
  } catch {
    return false;
  }
}

function setAutostart(on) {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(
        AUTOSTART_FILE,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=VibeCrew',
          'Comment=在后台启动 VibeCrew，机器人和定时任务开机即可工作',
          `Exec=${launchCommand()} --hidden`,
          'Icon=vibecrew',
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'),
      );
    } else {
      fs.rmSync(AUTOSTART_FILE, { force: true });
    }
  } catch (e) {
    dialog.showErrorBox('无法修改开机启动', String(e && e.message));
  }
  updateTray();
  return autostartEnabled();
}

function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开 VibeCrew', click: showWindow },
    { label: '在浏览器中打开', enabled: !!serverPort, click: () => void shell.openExternal(`${appOrigin()}/`) },
    { type: 'separator' },
    { label: '开机自动启动（后台运行）', type: 'checkbox', checked: autostartEnabled(), click: (item) => setAutostart(item.checked) },
    { label: '查看服务日志', click: () => void shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: attached ? '退出（服务由其他进程运行，会继续工作）' : '退出 VibeCrew（停止所有机器人）', click: () => void quitApp() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('VibeCrew');
  tray.on('click', showWindow);
  updateTray();
}

function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'VibeCrew',
        submenu: [
          { label: '隐藏窗口', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
          { label: '在浏览器中打开', click: () => serverPort && void shell.openExternal(`${appOrigin()}/`) },
          { type: 'separator' },
          { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => void quitApp() },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
    ]),
  );
}

// ---------------------------------------------------------------- lifecycle

async function quitApp() {
  if (quitting) return;
  quitting = true;
  log('quitting');
  if (win && !win.isDestroyed()) win.hide();
  saveState();
  if (!attached) await stopServer();
  if (tray) tray.destroy();
  // Someone reopened VibeCrew while it was shutting down: start again once we are gone.
  if (relaunchRequested) {
    app.relaunch({
      execPath: inOwnAppImage() ? process.env.APPIMAGE : process.execPath,
      args: process.argv.slice(1).filter((a) => a !== '--hidden' && a !== '--quit'),
    });
  }
  app.exit(0);
}

/** IPC is only for VibeCrew's own top-level page, never for previewed sites. */
function fromOwnPage(e) {
  const frame = e.senderFrame;
  if (!frame || !win || win.isDestroyed() || frame !== win.webContents.mainFrame) return false;
  return isAppUrl(frame.url || '');
}

function registerIpc() {
  ipcMain.on('vc:show', (e) => fromOwnPage(e) && showWindow());
  ipcMain.on('vc:retry', (e) => {
    if (!fromOwnPage(e)) return;
    crashes.length = 0;
    void boot();
  });
  ipcMain.on('vc:open-logs', (e) => fromOwnPage(e) && void shell.openPath(LOG_FILE));
  ipcMain.handle('vc:info', (e) => {
    if (!fromOwnPage(e)) return null;
    return {
      version: app.getVersion(),
      autostart: autostartEnabled(),
      attached,
      sandboxed: !app.commandLine.hasSwitch('no-sandbox'),
      logFile: LOG_FILE,
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle('vc:set-autostart', (e, on) => (fromOwnPage(e) ? setAutostart(!!on) : null));
}

function isOwnFrame(url, isMainFrame) {
  return isMainFrame !== false && isAppUrl(url || '');
}

function registerPermissions() {
  const ses = session.defaultSession;
  // Previewed sites run in iframes: like in Chrome they may write to the clipboard and go
  // fullscreen, but they never read the clipboard; only VibeCrew itself shows notifications.
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return cb(true);
    cb(permission === 'notifications' && isOwnFrame(details.requestingUrl, details.isMainFrame));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return true;
    if (permission !== 'notifications') return false;
    return isOwnFrame((details && details.requestingUrl) || `${origin}/`, details && details.isMainFrame);
  });
}

if (wantsQuit) {
  // `vibecrew --quit`: a running instance receives { quit: true } and shuts down.
  app.requestSingleInstanceLock({ quit: true });
  app.exit(0);
} else if (!app.requestSingleInstanceLock({ quit: false })) {
  app.exit(0);
} else {
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    if (data && data.quit) void quitApp();
    else if (quitting) relaunchRequested = true;
    else showWindow();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    void quitApp();
  });
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => void quitApp());

  app.whenReady().then(() => {
    registerPermissions();
    registerIpc();
    createMenu();
    createWindow();
    createTray();
    showLoading('正在启动 VibeCrew…');
    void boot();
  });
}
