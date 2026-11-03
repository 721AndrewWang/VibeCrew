// One HTTP(S) request to a provider. Node's http/https ignore the proxy variables, so a request to
// a host the user's proxy should carry goes through it: a CONNECT tunnel for https, an absolute URL
// for http. Loopback and NO_PROXY hosts are reached directly.

import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import tls from 'node:tls';

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  signal?: AbortSignal;
  /** No response headers by then: the try fails (a provider that is down, not a slow answer). */
  headersTimeoutMs?: number;
}

const env = (k: string) => process.env[k] ?? process.env[k.toLowerCase()];

function bypassProxy(host: string): boolean {
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true;
  const list = (env('NO_PROXY') || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const h = host.toLowerCase();
  return list.some((n) => n === '*' || h === n.replace(/^\./, '') || h.endsWith(n.startsWith('.') ? n : `.${n}`));
}

export function proxyFor(target: URL): URL | null {
  if (bypassProxy(target.hostname)) return null;
  const raw = target.protocol === 'https:' ? env('HTTPS_PROXY') || env('ALL_PROXY') : env('HTTP_PROXY') || env('ALL_PROXY');
  if (!raw) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const proxyAuth = (p: URL) => (p.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {});

/** A TLS socket to the target through the proxy's CONNECT. */
function tunnel(proxy: URL, target: URL, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const port = Number(target.port) || 443;
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}`, ...proxyAuth(proxy) },
      signal,
    });
    req.once('connect', (res, socket: net.Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT ${res.statusCode}`));
      }
      const s = tls.connect({ socket, servername: target.hostname });
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

/** Resolves with the response once its headers are in; the body streams from it. */
export async function upstream(r: UpstreamRequest): Promise<http.IncomingMessage> {
  const target = new URL(r.url);
  const proxy = proxyFor(target);
  const headers = { ...r.headers, 'content-length': String(r.body.length) };
  const opts: https.RequestOptions = { method: r.method, headers, signal: r.signal };
  let mod: typeof http | typeof https = target.protocol === 'https:' ? https : http;
  if (proxy && target.protocol === 'https:') {
    const socket = await tunnel(proxy, target, r.signal);
    opts.createConnection = () => socket;
    Object.assign(opts, { host: target.hostname, port: Number(target.port) || 443, path: target.pathname + target.search, servername: target.hostname });
  } else if (proxy) {
    mod = proxy.protocol === 'https:' ? https : http;
    Object.assign(opts, { host: proxy.hostname, port: Number(proxy.port) || 80, path: target.href, headers: { ...headers, host: target.host, ...proxyAuth(proxy) } });
  } else {
    Object.assign(opts, { host: target.hostname, port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search });
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    const timer = setTimeout(() => req.destroy(new Error(`no answer after ${Math.round((r.headersTimeoutMs ?? 0) / 1000)}s`)), r.headersTimeoutMs ?? 600_000);
    req.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(r.body);
  });
}

export function readBody(res: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    res.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) res.destroy(new Error('response too large'));
      else chunks.push(c);
    });
    res.once('end', () => resolve(Buffer.concat(chunks)));
    res.once('error', reject);
    res.once('aborted', () => reject(new Error('aborted')));
  });
}
