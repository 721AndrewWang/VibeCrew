import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { type WebSocket, WebSocketServer } from 'ws';
import { appIconSvg } from '../shared/logos';
import type { ClientEvent } from '../shared/types';
import { apiRouter, lanUrl, tailscaleUrl } from './api';
import { closeBrowser } from './browser';
import { bus } from './bus';
import { checkAuth } from './claudeAuth';
import { APP_NAME, APP_VERSION, findChrome, findClaudeExecutable, HOME_DIR, lanAddress, WEB_DIST } from './config';
import { stopAllDevServers } from './devserver';
import { initIfNeeded } from './entities';
import { logger } from './log';
import { closeAllSessions } from './orchestrator';
import { startOutsideEditNotes } from './outsideEdits';
import { closeAllPreviews } from './preview';
import { startRoutines } from './routines';
import { guard, wsAllowed } from './security';
import { flushAll, settings } from './store';
import { closeAllTerminals, closeTerminal, detachTerminals, openTerminal, terminalInput, terminalResize } from './terminal';
import { stopAllWatches } from './watcher';
import { reconcileWorkspaces } from './workspaces';

const log = logger('server');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(guard);
app.use('/api', apiRouter());

// The favicon follows the logo chosen in Settings → 外观; it is drawn here, built UI or not.
app.get('/icon.svg', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('image/svg+xml').send(appIconSvg(settings.get().logo));
});

const hasWeb = fs.existsSync(path.join(WEB_DIST, 'index.html'));
if (hasWeb) {
  // The web app's PNG icons are rendered at build time.
  app.get(['/icon-192.png', '/icon-512.png'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(`logos/${settings.get().logo}-${req.path.includes('192') ? 192 : 512}.png`, { root: WEB_DIST }, (err) => err && next());
  });
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile('index.html', { root: WEB_DIST });
  });
} else {
  app.get('/', (_req, res) => {
    res
      .type('html')
      .send(
        '<meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>Crew 服务已启动</h2><p>还没有构建界面：请运行 <code>npm run build</code> 后重启，或用 <code>npm run dev</code> 进入开发模式（界面在 5173 端口）。</p></body>',
      );
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname !== '/ws' || !wsAllowed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  const send = (data: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  };
  const off = bus.on(send);
  const termSend = new Map<string, (d: string) => void>();

  ws.on('message', (raw) => {
    let ev: ClientEvent;
    try {
      ev = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      switch (ev.t) {
        case 'term_open': {
          const fn = (data: string) => send({ t: 'term_data', id: ev.id, data });
          termSend.set(ev.id, fn);
          openTerminal(ev.id, ev.projectId, ev.cols, ev.rows, fn, (code) => send({ t: 'term_exit', id: ev.id, code }), ev.command);
          break;
        }
        case 'term_input':
          terminalInput(ev.id, ev.data);
          break;
        case 'term_resize':
          terminalResize(ev.id, ev.cols, ev.rows);
          break;
        case 'term_close':
          closeTerminal(ev.id);
          termSend.delete(ev.id);
          break;
        case 'ping':
          send({ t: 'pong' });
          break;
      }
    } catch (e) {
      send({ t: 'notify', title: '操作失败', body: (e as Error).message, level: 'error' });
    }
  });

  ws.on('close', () => {
    off();
    for (const fn of termSend.values()) detachTerminals(fn);
  });
});

async function main() {
  await initIfNeeded();
  await reconcileWorkspaces().catch((e) => log.warn('reconcile workspaces:', e));
  startRoutines();
  startOutsideEditNotes();
  void checkAuth(true).then((a) => {
    if (!a.cliFound) console.warn('⚠️  没有找到 Claude Code 命令行（claude）。请先安装：npm i -g @anthropic-ai/claude-code');
    else if (!a.ready && a.method === 'provider') console.warn('⚠️  模型服务商还没配置好：请在 Crew「设置 → 模型连接」里填写地址、Key 和模型。');
    else if (!a.ready) console.warn('⚠️  Claude Code 还没有登录。请在终端运行 `claude auth login`，或在 Crew「设置 → 模型连接」里填写 API Key、选择其他模型服务商。');
  });

  const s = settings.get();
  const port = Number(process.env.CREW_PORT) || s.port;
  const host = s.lanEnabled ? '0.0.0.0' : '127.0.0.1';
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${port} 已被占用。Crew 可能已经在运行（打开 http://localhost:${port}），或用 CREW_PORT=其他端口 npm start。`);
      // The desktop app reads exit code 3 as "port taken".
      process.exit(3);
    }
    log.error(e);
    process.exit(1);
  });
  server.listen(port, host, () => {
    if (port !== s.port) settings.update({ port });
    const local = `http://localhost:${port}`;
    console.log(`\n  🤖 ${APP_NAME} ${APP_VERSION} 已启动\n`);
    console.log(`  本机访问：  ${local}`);
    const lan = lanUrl();
    if (lan) console.log(`  手机访问：  ${lan}`);
    const ts = tailscaleUrl();
    if (ts) console.log(`  Tailscale： ${ts}`);
    else if (lanAddress()) console.log('  手机访问：  未开启（可在「设置 → 手机访问」中打开）');
    console.log(`  数据目录：  ${HOME_DIR}`);
    console.log(`  Claude：    ${findClaudeExecutable() || '未找到'}`);
    console.log(`  浏览器：    ${findChrome() || '未找到（截图/浏览器测试不可用）'}`);
    if (!hasWeb) console.log('\n  ⚠️  界面尚未构建，运行 npm run build 后重启。');
    console.log('');
    if (process.argv.includes('--open') && !process.env.CREW_DESKTOP) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [local], { stdio: 'ignore', detached: true })
        .on('error', () => {})
        .unref();
    }
  });
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n正在退出…');
  flushAll();
  closeAllSessions();
  closeAllTerminals();
  closeAllPreviews();
  await Promise.race([Promise.all([stopAllDevServers(), closeBrowser(), stopAllWatches()]), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log.error('uncaught exception', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

void main();
