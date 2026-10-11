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

// The favicon follows the logo chosen in Settings → Appearance; it is drawn here, built UI or not.
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
        '<meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>Crew server is running</h2><p>The UI hasn\'t been built yet: run <code>npm run build</code> and restart, or use <code>npm run dev</code> for dev mode (the UI is on port 5173).</p></body>',
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
      send({ t: 'notify', title: 'Action failed', body: (e as Error).message, level: 'error' });
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
    if (!a.cliFound) console.warn('⚠️  Claude Code CLI (claude) not found. Install it first: npm i -g @anthropic-ai/claude-code');
    else if (!a.ready && a.method === 'provider') console.warn("⚠️  The model provider isn't set up yet: fill in the URL, key and model in Crew under Settings → Model connection.");
    else if (!a.ready)
      console.warn("⚠️  Claude Code isn't logged in. Run `claude auth login` in a terminal, or enter an API key or pick another model provider in Crew under Settings → Model connection.");
  });

  const s = settings.get();
  const port = Number(process.env.CREW_PORT) || s.port;
  const host = s.lanEnabled ? '0.0.0.0' : '127.0.0.1';
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`❌ Port ${port} is already in use. Crew may already be running (open http://localhost:${port}), or use CREW_PORT=<another port> npm start.`);
      // The desktop app reads exit code 3 as "port taken".
      process.exit(3);
    }
    log.error(e);
    process.exit(1);
  });
  server.listen(port, host, () => {
    if (port !== s.port) settings.update({ port });
    const local = `http://localhost:${port}`;
    console.log(`\n  🤖 ${APP_NAME} ${APP_VERSION} is running\n`);
    console.log(`  Local:       ${local}`);
    const lan = lanUrl();
    if (lan) console.log(`  Phone:       ${lan}`);
    const ts = tailscaleUrl();
    if (ts) console.log(`  Tailscale:   ${ts}`);
    else if (lanAddress()) console.log('  Phone:       off (turn it on in Settings → Phone access)');
    console.log(`  Data dir:    ${HOME_DIR}`);
    console.log(`  Claude:      ${findClaudeExecutable() || 'not found'}`);
    console.log(`  Browser:     ${findChrome() || 'not found (screenshots/browser tests unavailable)'}`);
    if (!hasWeb) console.log("\n  ⚠️  The UI isn't built yet. Run npm run build and restart.");
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
  console.log('\nShutting down…');
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
