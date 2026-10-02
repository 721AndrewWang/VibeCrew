import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { PreviewInfo, Project } from '../shared/types';
import { bus, internal } from './bus';
import { INJECT_SCRIPT } from './config';
import { devServer } from './devserver';
import { devCommand, getProject, staticRoot } from './projects';
import { settings } from './store';
import { ensureWatch } from './watcher';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const INJECT_TAG = '<script src="/__crew/inject.js"></script>';

function injectHtml(html: string): string {
  if (html.includes('/__crew/inject.js')) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + INJECT_TAG);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + INJECT_TAG);
  return INJECT_TAG + html;
}

function page(title: string, body: string): string {
  return injectHtml(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,"PingFang SC","Noto Sans SC",sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#555;background:#fafafa}
@media (prefers-color-scheme:dark){body{background:#111;color:#aaa}}div{text-align:center;max-width:480px;padding:24px}h1{font-size:20px;color:inherit}code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:4px}ul{text-align:left;line-height:1.9}a{color:inherit;text-decoration:underline}</style>
</head><body><div>${body}</div></body></html>`);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

class PreviewServer {
  server: http.Server;
  port = 0;
  private sse = new Set<http.ServerResponse>();
  private onFiles = (projectId: string, paths: string[]) => {
    if (projectId !== this.projectId || this.target()) return;
    const data = `data: ${JSON.stringify({ type: 'change', paths })}\n\n`;
    for (const res of this.sse) res.write(data);
  };

  constructor(public projectId: string) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(e?.message || e));
      });
    });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
    internal.on('files', this.onFiles);
  }

  async listen(): Promise<number> {
    const host = settings.get().lanEnabled ? '0.0.0.0' : '127.0.0.1';
    for (let port = 4400; port < 4600; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        const onError = () => resolve(false);
        this.server.once('error', onError);
        this.server.listen(port, host, () => {
          this.server.off('error', onError);
          resolve(true);
        });
      });
      if (ok) {
        this.port = port;
        return port;
      }
    }
    throw new Error('没有可用的预览端口（4400-4599）');
  }

  /** The dev server URL when one is running. */
  target(): string | null {
    const s = devServer(this.projectId).state;
    return s.url && (s.status === 'running' || s.status === 'starting') ? s.url : null;
  }

  info(): PreviewInfo {
    const t = this.target();
    let project: Project | null;
    try {
      project = getProject(this.projectId);
    } catch {
      project = null;
    }
    return {
      projectId: this.projectId,
      mode: t ? 'proxy' : 'static',
      port: this.port,
      target: t || (project ? staticRoot(project) : ''),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://preview.local');
    if (url.pathname === '/__crew/inject.js') {
      const cfg = { liveReload: !this.target() };
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`window.__CREW_CFG__=${JSON.stringify(cfg)};\n${fs.readFileSync(INJECT_SCRIPT, 'utf8')}`);
      return;
    }
    if (url.pathname === '/__crew/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n');
      this.sse.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        this.sse.delete(res);
      });
      return;
    }
    const target = this.target();
    if (target) return this.proxy(req, res, target);
    return this.serveStatic(req, res, url);
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    let project: Project;
    try {
      project = getProject(this.projectId);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('项目不存在', '<h1>项目不存在</h1>'));
      return;
    }
    if (devCommand(project) && !this.target()) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page('开发服务器未运行', `<h1>开发服务器还没启动</h1><p>这个项目需要运行 <code>${escapeHtml(devCommand(project)!)}</code>。点上方的「启动」按钮，或让机器人帮你启动。</p>`));
      return;
    }
    const root = path.resolve(staticRoot(project));
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      rel = url.pathname;
    }
    let abs = path.resolve(root, '.' + rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const segs = path.relative(root, abs).split(path.sep);
    if (segs.some((s) => s.startsWith('.') && s !== '.well-known')) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('404', '<h1>404</h1><p>隐藏文件不会被预览。</p>'));
      return;
    }
    try {
      if (fs.statSync(abs).isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { location: url.pathname + '/' + url.search }).end();
          return;
        }
        const index = path.join(abs, 'index.html');
        if (fs.existsSync(index)) abs = index;
        else {
          const items = fs
            .readdirSync(abs, { withFileTypes: true })
            .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
            .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${escapeHtml(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`)
            .join('');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(page(rel, `<h1>${escapeHtml(rel)}</h1><p>这里还没有 index.html。</p><ul>${items || '<li>（空文件夹）</li>'}</ul>`));
          return;
        }
      }
    } catch {
      // Clean URLs: /about -> /about.html
      if (!path.extname(abs) && fs.existsSync(abs + '.html')) abs = abs + '.html';
      else {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page('404', `<h1>404</h1><p>找不到 <code>${escapeHtml(rel)}</code></p><p><a href="/">回到首页</a></p>`));
        return;
      }
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(injectHtml(fs.readFileSync(abs, 'utf8')));
      return;
    }
    const stat = fs.statSync(abs);
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(abs).pipe(res);
  }

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, target: string) {
    const t = new URL(target);
    const selfOrigin = `http://${req.headers.host}`;
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: t.host };
    delete headers['accept-encoding'];
    if (typeof headers.origin === 'string') headers.origin = t.origin;
    if (typeof headers.referer === 'string') headers.referer = headers.referer.replace(selfOrigin, t.origin);
    const upstream = http.request({ hostname: t.hostname, port: t.port || 80, path: req.url, method: req.method, headers }, (up) => {
      const h: http.OutgoingHttpHeaders = { ...up.headers };
      delete h['x-frame-options'];
      delete h['content-security-policy'];
      if (typeof h.location === 'string' && h.location.startsWith(t.origin)) h.location = h.location.slice(t.origin.length) || '/';
      const ct = String(up.headers['content-type'] || '');
      if (ct.includes('text/html')) {
        const chunks: Buffer[] = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const body = injectHtml(Buffer.concat(chunks).toString('utf8'));
          delete h['content-length'];
          delete h['content-encoding'];
          delete h['transfer-encoding'];
          h['cache-control'] = 'no-store';
          res.writeHead(up.statusCode || 200, h);
          res.end(body);
        });
        return;
      }
      res.writeHead(up.statusCode || 200, h);
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      if (res.headersSent) return res.end();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('连接失败', `<h1>连不上开发服务器</h1><p><code>${escapeHtml(target)}</code></p><p>${escapeHtml(e.message)}</p><p>它可能还在启动，稍后刷新试试。</p>`));
    });
    req.pipe(upstream);
  }

  private upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const target = this.target();
    if (!target) return socket.destroy();
    const t = new URL(target);
    const upstream = net.connect({ host: t.hostname, port: Number(t.port) || 80 }, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        let v = req.rawHeaders[i + 1];
        if (/^host$/i.test(k)) v = t.host;
        else if (/^origin$/i.test(k)) v = t.origin;
        raw += `${k}: ${v}\r\n`;
      }
      upstream.write(raw + '\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  close() {
    internal.off('files', this.onFiles);
    for (const res of this.sse) res.end();
    this.server.closeAllConnections?.();
    this.server.close();
  }
}

const previews = new Map<string, PreviewServer>();
const starting = new Map<string, Promise<PreviewServer>>();

export async function ensurePreview(projectId: string): Promise<PreviewInfo> {
  getProject(projectId);
  ensureWatch(projectId);
  let p = previews.get(projectId);
  if (!p) {
    let pending = starting.get(projectId);
    if (!pending) {
      pending = (async () => {
        const srv = new PreviewServer(projectId);
        await srv.listen();
        previews.set(projectId, srv);
        return srv;
      })();
      starting.set(projectId, pending);
    }
    try {
      p = await pending;
    } finally {
      starting.delete(projectId);
    }
  }
  return p.info();
}

export function previewInfos(): PreviewInfo[] {
  return [...previews.values()].map((p) => p.info());
}

export function previewUrl(projectId: string, pagePath = '/'): string | null {
  const p = previews.get(projectId);
  if (!p) return null;
  return `http://127.0.0.1:${p.port}${pagePath.startsWith('/') ? pagePath : '/' + pagePath}`;
}

/** Announces preview mode changes when a dev server starts or stops. */
bus.on((ev) => {
  if (ev.t !== 'devserver') return;
  const p = previews.get(ev.state.projectId);
  if (p) bus.emit({ t: 'preview', info: p.info() });
});

export async function restartPreviews() {
  const ids = [...previews.keys()];
  for (const id of ids) {
    previews.get(id)?.close();
    previews.delete(id);
  }
  for (const id of ids) {
    const info = await ensurePreview(id);
    bus.emit({ t: 'preview', info });
  }
}

/** Shuts down one project's preview server (its workspace was removed). */
export function closePreview(projectId: string) {
  previews.get(projectId)?.close();
  previews.delete(projectId);
}

export function closeAllPreviews() {
  for (const p of previews.values()) p.close();
  previews.clear();
}
