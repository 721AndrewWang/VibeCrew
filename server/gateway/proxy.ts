// The gateway's request handler (ADR 009): Anthropic Messages API in, the same out. It checks the
// scope's token and spend windows, resolves the target to its members, and asks them in order: a
// member that refuses (quota, rate limit, outage) hands on to the next, before anything was sent to
// the client, so failover is transparent for streams too. Every call is logged, attributed to the
// member that answered. Settings, keys and the log come in through `deps`, so tests can drive it.

import type http from 'node:http';
import type { GatewayCall, GatewayRole, GatewaySettings, GatewayTry, TurnTokens } from '../../shared/types';
import { GATEWAY_ROLES, membersOf, routeFor, type Scope, splitAddress } from './config';
import { Masker, restoreMessage, StreamRestorer } from './mask';
import { estimateCost, mergeTokens, priceOf, tokensOf } from './pricing';
import { formatEvent, type SseEvent, SseParser } from './sse';
import { readBody, upstream } from './upstream';
import { describeWindow, spentWindow } from './windows';

export interface GatewayDeps {
  settings(): GatewaySettings;
  /** A provider's key ('' or undefined: none, e.g. a local server). */
  token(providerId: string): string | undefined;
  /** Is this the credential for this scope? */
  verify(scope: Scope, token: string): boolean;
  /** The usage log, oldest first (for the spend windows). */
  calls(): GatewayCall[];
  record(call: GatewayCall): void;
  /** Key for the masking placeholders' HMAC. */
  maskSalt(): string;
  newId(): string;
  now?(): number;
  /** Per try: no response headers by then counts as the provider being down. */
  headersTimeoutMs?: number;
}

const REQUEST_LIMIT = 64 * 1024 * 1024;
/** Request headers not passed on: hop-by-hop, credentials (each provider gets its own), and encoding (we read the stream). */
const DROP_REQUEST = new Set([
  'host',
  'authorization',
  'x-api-key',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'accept-encoding',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'upgrade',
]);
const DROP_RESPONSE = new Set(['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'content-encoding']);

/** What a provider says when an account or key ran out, rather than the request being wrong. */
const QUOTA = /quota|balance|credit|billing|payment|overloaded|rate[\s_-]?limit|too many requests/i;

/** A refusal the next member should get a chance at: rate limits, outages, quota. */
export function shouldHandOn(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 400 || status === 402 || status === 403) return QUOTA.test(body);
  return false;
}

/** A stream whose very first event is one of these is a refusal, not an answer. */
const RETRYABLE_STREAM_ERRORS = new Set(['overloaded_error', 'rate_limit_error', 'api_error']);

const apiError = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } });

function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(body);
}

/** /s/<role>/<botId>/v1/messages[/count_tokens] */
export function parsePath(url: string): { scope: Scope; endpoint: 'messages' | 'count_tokens'; search: string } | null {
  const u = new URL(url, 'http://gateway');
  const m = /^\/s\/([a-z]+)\/([^/]+)\/v1\/messages(\/count_tokens)?\/?$/.exec(u.pathname);
  if (!m || !GATEWAY_ROLES.includes(m[1] as GatewayRole)) return null;
  const bot = decodeURIComponent(m[2]);
  return { scope: { role: m[1] as GatewayRole, botId: bot === '_' ? undefined : bot }, endpoint: m[3] ? 'count_tokens' : 'messages', search: u.search };
}

function credential(req: http.IncomingMessage): string {
  const auth = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function forwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_REQUEST.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out['accept-encoding'] = 'identity';
  out['content-type'] = 'application/json';
  return out;
}

function responseHeaders(res: http.IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !DROP_RESPONSE.has(k)) out[k] = v;
  return out;
}

const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);

function errorText(body: string): string {
  try {
    const j = JSON.parse(body);
    return short(String(j.error?.message || j.message || j.error || body));
  } catch {
    return short(body);
  }
}

export async function handleGateway(req: http.IncomingMessage, res: http.ServerResponse, deps: GatewayDeps): Promise<void> {
  const now = () => deps.now?.() ?? Date.now();
  const t0 = now();
  const route = req.method === 'POST' && req.url ? parsePath(req.url) : null;
  if (!route) return send(res, 404, apiError('not_found_error', 'The Crew gateway serves POST /v1/messages only'));
  const { scope } = route;
  if (!deps.verify(scope, credential(req))) return send(res, 401, apiError('authentication_error', 'Not a Crew gateway credential for this scope'));

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req, REQUEST_LIMIT);
    body = JSON.parse(raw.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch (e) {
    return send(res, 400, apiError('invalid_request_error', `The request body is not valid JSON: ${(e as Error).message}`));
  }

  const gw = deps.settings();
  const requested = typeof body.model === 'string' ? body.model : '';
  const target = routeFor(gw, scope, requested);
  if (!target) return send(res, 400, apiError('invalid_request_error', `No gateway route for "${requested || '(no model)'}": set a default target in Settings → Model gateway`));
  const stream = body.stream === true && route.endpoint === 'messages';
  const call: GatewayCall = { id: deps.newId(), at: t0, role: scope.role, botId: scope.botId, requested, target, outcome: 'error', status: 0, tries: [], costUsd: 0, latencyMs: 0, stream };
  res.setHeader('x-crew-call', call.id);
  const log = route.endpoint === 'messages';
  const finish = (patch: Partial<GatewayCall>) => {
    Object.assign(call, patch, { latencyMs: now() - t0 });
    if (log) deps.record(call);
  };

  if (log) {
    const spent = spentWindow(gw.windows, scope, deps.calls(), t0);
    if (spent) {
      const retry = String(spent.state.retryAfterSec ?? 60);
      finish({ outcome: 'limited', status: 429, window: spent.window.id });
      return send(
        res,
        429,
        apiError('rate_limit_error', `Crew spend window "${spent.window.id}" is used up (${describeWindow(spent.window)}); it reopens in about ${Math.ceil(Number(retry) / 60)} min.`),
        {
          'retry-after': retry,
          // The Anthropic SDK inside Claude Code would otherwise sleep and retry for hours.
          'x-should-retry': 'false',
        },
      );
    }
  }

  const masker = gw.masking ? new Masker(deps.maskSalt()) : null;
  const prompt = masker ? masker.request(body) : body;
  if (masker?.count) call.masked = masker.count;

  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  let lastRefusal: { status: number; headers: Record<string, string | string[]>; body: string } | null = null;

  for (const member of membersOf(gw, target, requested)) {
    if (abort.signal.aborted) return;
    const tStart = now();
    const attempt = (t: Omit<GatewayTry, 'member' | 'ms'>) => call.tries.push({ member, ...t, ms: now() - tStart });
    const a = splitAddress(member);
    const provider = a && gw.providers.find((p) => p.id === a.provider);
    if (!a || !provider) {
      attempt({ outcome: 'skipped', detail: 'unknown provider' });
      continue;
    }
    if (a.model === '*') {
      attempt({ outcome: 'skipped', detail: 'no model to pass through' });
      continue;
    }
    const key = deps.token(provider.id) || '';
    const headers = forwardHeaders(req);
    if (provider.auth === 'x-api-key') headers['x-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
    const url = `${provider.baseUrl}/v1/messages${route.endpoint === 'count_tokens' ? '/count_tokens' : ''}${route.search}`;
    let up: http.IncomingMessage;
    try {
      up = await upstream({ url, method: 'POST', headers, body: Buffer.from(JSON.stringify({ ...prompt, model: a.model })), signal: abort.signal, headersTimeoutMs: deps.headersTimeoutMs });
    } catch (e) {
      if (abort.signal.aborted) return;
      attempt({ outcome: 'handed-on', detail: short((e as Error).message) });
      continue;
    }
    const status = up.statusCode || 502;

    if (status < 200 || status >= 300) {
      const text = (await readBody(up, 1024 * 1024).catch(() => Buffer.alloc(0))).toString('utf8');
      if (shouldHandOn(status, text)) {
        attempt({ outcome: 'handed-on', status, detail: errorText(text) });
        lastRefusal = { status, headers: responseHeaders(up), body: text };
        continue;
      }
      attempt({ outcome: 'failed', status, detail: errorText(text) });
      finish({ outcome: 'error', status, provider: provider.id, model: a.model, detail: errorText(text) });
      if (!res.headersSent) res.writeHead(status, responseHeaders(up));
      return void res.end(text);
    }

    const isStream = /text\/event-stream/i.test(String(up.headers['content-type'] || ''));
    if (!isStream) {
      const raw = (await readBody(up).catch(() => null))?.toString('utf8');
      if (raw === undefined) {
        attempt({ outcome: 'handed-on', status, detail: 'the answer was cut off' });
        continue;
      }
      let out = raw;
      let tokens: TurnTokens | undefined;
      try {
        let j = JSON.parse(raw) as Record<string, unknown>;
        tokens = tokensOf(j.usage);
        if (masker?.map.size) {
          j = restoreMessage(j, masker.map);
          out = JSON.stringify(j);
        }
      } catch {
        /* not JSON: pass it on as it is */
      }
      attempt({ outcome: 'answered', status });
      finish(answered(provider, a.model, status, tokens));
      const h = responseHeaders(up);
      return void res.writeHead(status, h).end(out);
    }

    // A stream: hold back the first event until it is known not to be a refusal.
    const parser = new SseParser();
    const held: Buffer[] = [];
    const first = await new Promise<SseEvent[] | null>((resolve) => {
      const onData = (c: Buffer) => {
        held.push(c);
        const evs = parser.push(c.toString('utf8'));
        if (evs.length) {
          cleanup();
          resolve(evs);
        }
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        up.off('data', onData);
        up.off('end', onEnd);
        up.off('error', onEnd);
        up.pause();
      };
      up.on('data', onData);
      up.once('end', onEnd);
      up.once('error', onEnd);
    });
    if (!first) {
      attempt({ outcome: 'handed-on', status, detail: 'the stream ended before its first event' });
      continue;
    }
    const e0 = first[0];
    const e0Type = (e0.data as { error?: { type?: string } } | undefined)?.error?.type;
    if (e0.event === 'error' && e0Type && RETRYABLE_STREAM_ERRORS.has(e0Type)) {
      up.destroy();
      attempt({ outcome: 'handed-on', status, detail: `${e0Type}: ${errorText(JSON.stringify(e0.data))}` });
      lastRefusal = { status: e0Type === 'overloaded_error' ? 529 : e0Type === 'rate_limit_error' ? 429 : 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify(e0.data) };
      continue;
    }

    attempt({ outcome: 'answered', status });
    res.writeHead(status, responseHeaders(up));
    const usage = new StreamUsage();
    const rewriter = masker?.map.size ? new StreamRewriter(masker.map) : null;
    const emit = (evs: SseEvent[]) => {
      for (const ev of evs) {
        usage.see(ev);
        if (rewriter) res.write(rewriter.rewrite(ev));
      }
    };
    emit(first);
    if (!rewriter) for (const c of held) res.write(c);
    await new Promise<void>((resolve) => {
      // The whole answer may have come in the first chunk: then the stream can end while it is
      // paused above (Node 24 emits 'end' there), before these listeners exist. 'close' covers it too.
      if (up.readableEnded || up.destroyed) return resolve();
      up.once('close', () => resolve());
      up.on('data', (c: Buffer) => {
        const evs = parser.push(c.toString('utf8'));
        if (rewriter) emit(evs);
        else {
          for (const ev of evs) usage.see(ev);
          res.write(c);
        }
      });
      up.once('end', () => resolve());
      up.once('error', () => resolve());
      up.once('aborted', () => resolve());
      up.resume();
    });
    if (rewriter) res.write(parser.rest());
    res.end();
    finish({ ...answered(provider, a.model, status, usage.tokens), ...(usage.error ? { outcome: 'error' as const, detail: usage.error } : {}) });
    return;
  }

  // Every member refused: pass on the last refusal, so Claude Code's own retry sees what it said.
  if (abort.signal.aborted) return;
  const status = lastRefusal?.status ?? 503;
  finish({ outcome: 'error', status, detail: 'every member refused' });
  if (lastRefusal) {
    res.writeHead(status, lastRefusal.headers);
    return void res.end(lastRefusal.body);
  }
  send(res, 503, apiError('overloaded_error', `No member of "${target}" could be reached: ${call.tries.map((t) => `${t.member} ${t.detail || t.outcome}`).join('; ')}`));

  function answered(provider: { id: string; price?: { input: number; output: number } }, model: string, status: number, tokens: TurnTokens | undefined): Partial<GatewayCall> {
    return { outcome: 'ok', status, provider: provider.id, model, tokens, costUsd: tokens ? estimateCost(tokens, priceOf(provider, model)) : 0 };
  }
}

/** The fields Crew reads off a stream event's data; the rest passes through as it came. */
interface StreamData {
  type?: string;
  index: number;
  message?: { usage?: unknown };
  usage?: unknown;
  error?: { message?: string; type?: string };
  content_block?: { type: string; text?: string };
  delta?: { type: string; text?: string; partial_json?: string };
}

/** Tokens from a stream's message_start and message_delta; an error event after the start. */
class StreamUsage {
  tokens: TurnTokens | undefined;
  error: string | undefined;
  see(ev: SseEvent) {
    const d = ev.data as StreamData | undefined;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'message_start') this.tokens = mergeTokens(this.tokens, tokensOf(d.message?.usage));
    else if (d.type === 'message_delta') this.tokens = mergeTokens(this.tokens, tokensOf(d.usage));
    else if (d.type === 'error' || ev.event === 'error') this.error = short(String(d.error?.message || d.error?.type || 'stream error'));
  }
}

/** Restores placeholders in a masked stream, per content block; thinking goes as it came. */
class StreamRewriter {
  private blocks = new Map<number, { restorer: StreamRestorer; kind: 'text_delta' | 'input_json_delta' }>();
  constructor(private map: Map<string, string>) {}

  rewrite(ev: SseEvent): string {
    const d = ev.data as StreamData | undefined;
    if (!d || typeof d !== 'object') return ev.raw;
    if (d.type === 'content_block_start' && d.content_block) {
      const b = d.content_block;
      if (b.type === 'text') {
        const r = new StreamRestorer(this.map);
        this.blocks.set(d.index, { restorer: r, kind: 'text_delta' });
        if (b.text) return formatEvent(ev.event, { ...d, content_block: { ...b, text: r.push(b.text) } });
      } else if (b.type === 'tool_use') this.blocks.set(d.index, { restorer: new StreamRestorer(this.map, true), kind: 'input_json_delta' });
      return ev.raw;
    }
    if (d.type === 'content_block_delta' && d.delta) {
      const blk = this.blocks.get(d.index);
      if (blk && d.delta.type === 'text_delta') return formatEvent(ev.event, { ...d, delta: { ...d.delta, text: blk.restorer.push(String(d.delta.text ?? '')) } });
      if (blk && d.delta.type === 'input_json_delta') return formatEvent(ev.event, { ...d, delta: { ...d.delta, partial_json: blk.restorer.push(String(d.delta.partial_json ?? '')) } });
      return ev.raw;
    }
    if (d.type === 'content_block_stop') {
      const blk = this.blocks.get(d.index);
      this.blocks.delete(d.index);
      const rest = blk?.restorer.flush();
      if (blk && rest) {
        const delta = blk.kind === 'text_delta' ? { type: 'text_delta', text: rest } : { type: 'input_json_delta', partial_json: rest };
        return formatEvent('content_block_delta', { type: 'content_block_delta', index: d.index, delta }) + ev.raw;
      }
    }
    return ev.raw;
  }
}
