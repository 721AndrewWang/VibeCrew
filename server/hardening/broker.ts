// The key broker (ADR 104): agents use the model connection's key without being able to read it.
// While credentials are stripped and the gateway is off, a connection whose key lives in
// settings.json (an Anthropic API key, a provider token) is reached through this loopback listener:
// sessions get its address and a per-process token, and it forwards each request unchanged to the
// real endpoint with the real key added. With the gateway on, the gateway does the same with its
// scope tokens (ADR 009). It logs nothing and writes no file.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { upstream } from '../gateway/upstream';
import { logger } from '../log';
import { type Settings, settings } from '../store';

const log = logger('broker');

/** What sessions authenticate with; new on every start, as the sessions are. */
export const BROKER_TOKEN = `crew-broker-${crypto.randomBytes(24).toString('base64url')}`;

export interface BrokeredConnection {
  baseUrl: string;
  /** The header the endpoint expects, with the real key. */
  header: [name: string, value: string];
}

/** The connection the broker stands in for, or null when there is no settings-held key to keep from agents. */
export function brokerConnection(s: Settings): BrokeredConnection | null {
  if (s.gateway?.enabled || !s.safety?.stripCredentials) return null;
  if (s.authMode === 'api-key' && s.apiKey) return { baseUrl: s.baseUrl || 'https://api.anthropic.com', header: ['x-api-key', s.apiKey] };
  // A preset's default token (local servers that ignore it) is not a secret: nothing to broker.
  if (s.authMode === 'provider' && s.providerToken && s.provider.baseUrl) return { baseUrl: s.provider.baseUrl, header: ['authorization', `Bearer ${s.providerToken}`] };
  return null;
}

let server: http.Server | null = null;
let url: string | null = null;

export function brokerUrl(): string | null {
  return url;
}

/**
 * A session's model environment with the key replaced by the broker. While the listener is not up,
 * the address points nowhere, so calls fail rather than receive the key.
 */
export function brokered(env: Record<string, string | undefined>, s: Settings = settings.get()): Record<string, string | undefined> {
  if (!brokerConnection(s)) return env;
  return { ...env, ANTHROPIC_BASE_URL: url || 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: BROKER_TOKEN, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: undefined };
}

/** Request and response headers that belong to one connection, not to the request. */
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-connection', 'content-length', 'accept-encoding']);

function presented(req: http.IncomingMessage): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
  return (bearer || String(req.headers['x-api-key'] || '')).trim();
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function fail(res: http.ServerResponse, status: number, type: string, message: string) {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message: `Crew key broker: ${message}` } }));
}

function readAll(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) req.destroy(new Error('request too large'));
      else chunks.push(c);
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

/** One request: checked, forwarded with the real key, the answer streamed back as it arrives. */
export async function handleBroker(req: http.IncomingMessage, res: http.ServerResponse, s: Settings = settings.get()): Promise<void> {
  const conn = brokerConnection(s);
  if (!conn) return fail(res, 503, 'api_error', 'no connection to stand in for');
  if (!same(presented(req), BROKER_TOKEN)) return fail(res, 401, 'authentication_error', 'unknown credential');
  const body = await readAll(req);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP.has(k) || k === 'authorization' || k === 'x-api-key') continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers[conn.header[0]] = conn.header[1];
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  let up: http.IncomingMessage;
  try {
    up = await upstream({ url: `${conn.baseUrl.replace(/\/+$/, '')}${req.url || '/'}`, method: req.method || 'POST', headers, body, signal: abort.signal, headersTimeoutMs: 600_000 });
  } catch (e) {
    if (abort.signal.aborted) return;
    log.warn('upstream failed:', (e as Error).message);
    return fail(res, 502, 'api_error', `could not reach the model endpoint: ${(e as Error).message}`);
  }
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  res.writeHead(up.statusCode || 502, out);
  up.pipe(res);
  up.once('error', () => res.destroy());
}

/** Starts or stops the listener to match the settings. */
export async function syncBroker(): Promise<void> {
  if (!brokerConnection(settings.get())) return stopBroker();
  if (server) return;
  const srv = http.createServer((req, res) => {
    handleBroker(req, res).catch((e) => {
      log.error('request', e);
      fail(res, 500, 'api_error', (e as Error).message);
    });
  });
  // Claude Code holds a stream open as long as the model writes.
  srv.requestTimeout = 0;
  srv.headersTimeout = 60_000;
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (e) {
    log.error('could not listen:', (e as Error).message);
    return;
  }
  server = srv;
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  log.info(`listening on ${url}`);
}

export async function stopBroker(): Promise<void> {
  const srv = server;
  server = null;
  url = null;
  if (!srv) return;
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
    srv.closeAllConnections();
  });
}
