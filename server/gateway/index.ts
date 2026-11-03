// The model gateway (ADR 009): a local Anthropic Messages API endpoint, bound to 127.0.0.1, that
// every Claude Code session points ANTHROPIC_BASE_URL at while settings.gateway.enabled is on.
// Off, nothing listens and nothing here is used: modelEnv() and botModel() return what they did.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayCall, GatewayProvider, GatewayReport, GatewayTest, GatewayTotals } from '../../shared/types';
import { DATA } from '../config';
import { MODEL_OPTIONS } from '../data/catalog';
import { providerPreset } from '../data/providers';
import { logger } from '../log';
import { JsonlLog, type Settings, settings, uid } from '../store';
import { isAddress, normalizeGateway, PROVIDER_ID, routeFor, type Scope, scopeKey } from './config';
import { totalTokens } from './pricing';
import { handleGateway } from './proxy';
import { windowState } from './windows';

const log = logger('gateway');

/** Signs each scope's credential; new on every start, as the sessions are. */
const SECRET = crypto.randomBytes(32);

function scopeToken(scope: Scope): string {
  return `crew-gw-${crypto
    .createHmac('sha256', SECRET)
    .update(`${scope.role}/${scope.botId || '_'}`)
    .digest('base64url')}`;
}

function verify(scope: Scope, token: string): boolean {
  const want = Buffer.from(scopeToken(scope));
  const got = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

let calls: JsonlLog<GatewayCall> | null = null;
/** The usage log, opened on first use (its file appears with the first call). */
function callLog(): JsonlLog<GatewayCall> {
  calls ??= new JsonlLog<GatewayCall>(DATA.gatewayCalls, { max: 20_000, maxAgeMs: 35 * 86_400_000 });
  return calls;
}

let server: http.Server | null = null;
let listening: { url: string; port: number } | null = null;
let lastError: string | undefined;

export const gatewayOn = (s: Settings = settings.get()) => s.gateway.enabled;

const deps = {
  settings: () => settings.get().gateway,
  token: (id: string) => settings.get().gatewayTokens[id],
  verify,
  calls: () => callLog().all(),
  record: (c: GatewayCall) => callLog().append(c),
  // Stable across restarts, so a secret keeps its placeholder and resent history stays cacheable.
  maskSalt: () => `crew-mask:${settings.get().token}`,
  newId: () => uid('gc_'),
};

/** Starts, restarts (port changed) or stops the listener to match the settings. */
export async function syncGateway(): Promise<void> {
  const gw = settings.get().gateway;
  if (!gw.enabled) return stopGateway();
  if (listening && (gw.port === 0 || gw.port === listening.port)) return;
  await stopGateway();
  const srv = http.createServer((req, res) => {
    handleGateway(req, res, deps).catch((e) => {
      log.error('request', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Crew gateway: ${(e as Error).message}` } }));
    });
  });
  // Claude Code holds a stream open as long as the model writes.
  srv.requestTimeout = 0;
  srv.headersTimeout = 60_000;
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(gw.port, '127.0.0.1', () => resolve());
    });
  } catch (e) {
    lastError = `Could not listen on 127.0.0.1:${gw.port}: ${(e as Error).message}`;
    log.error(lastError);
    return;
  }
  const port = (srv.address() as AddressInfo).port;
  server = srv;
  listening = { url: `http://127.0.0.1:${port}`, port };
  lastError = undefined;
  log.info(`listening on ${listening.url}`);
}

export async function stopGateway(): Promise<void> {
  const srv = server;
  server = null;
  listening = null;
  if (!srv) return;
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
    srv.closeAllConnections();
  });
}

/** What a session asks for: the role's target, or undefined for no route. */
export function gatewayModel(scope: Scope, model: string | undefined): string | undefined {
  return routeFor(settings.get().gateway, scope, model);
}

/**
 * The session's environment: the gateway as its endpoint, with this scope's credential. While the
 * listener is not up (it failed to bind), the URL points nowhere, so calls fail rather than
 * bypassing the windows.
 */
export function gatewayEnv(scope: Scope, model?: string): Record<string, string | undefined> {
  const gw = settings.get().gateway;
  const target = gatewayModel(scope, model) || '';
  const base = listening?.url || 'http://127.0.0.1:9';
  return {
    ANTHROPIC_BASE_URL: `${base}/s/${scope.role}/${encodeURIComponent(scope.botId || '_')}`,
    ANTHROPIC_AUTH_TOKEN: scopeToken(scope),
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ...(target
      ? {
          ANTHROPIC_MODEL: target,
          ANTHROPIC_DEFAULT_OPUS_MODEL: target,
          ANTHROPIC_DEFAULT_SONNET_MODEL: target,
          ANTHROPIC_DEFAULT_FABLE_MODEL: target,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: isAddress(gw, gw.fastTarget) ? gw.fastTarget : target,
          CLAUDE_CODE_SUBAGENT_MODEL: target,
        }
      : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** Running, with at least one provider to send calls to. */
export function gatewayReady(s: Settings = settings.get()): boolean {
  return !!listening && s.gateway.providers.length > 0;
}

const emptyTotals = (): GatewayTotals => ({ calls: 0, costUsd: 0, tokens: 0, handedOn: 0, errors: 0 });

function add(t: GatewayTotals, c: GatewayCall) {
  t.calls++;
  t.costUsd = Math.round((t.costUsd + c.costUsd) * 1e6) / 1e6;
  t.tokens += totalTokens(c.tokens);
  t.handedOn += c.tries.filter((x) => x.outcome === 'handed-on').length;
  if (c.outcome !== 'ok') t.errors++;
}

export function gatewayReport(limit = 100, now = Date.now()): GatewayReport {
  const all = calls || listening ? callLog().all() : [];
  const week = now - 7 * 86_400_000;
  const byProvider: Record<string, GatewayTotals> = {};
  const byScope: Record<string, GatewayTotals> = {};
  for (const c of all) {
    if (c.at < week) continue;
    const scope = scopeKey({ role: c.role, botId: c.botId });
    byScope[scope] ??= emptyTotals();
    add(byScope[scope], c);
    if (c.provider) {
      byProvider[c.provider] ??= emptyTotals();
      add(byProvider[c.provider], c);
    }
  }
  const gw = settings.get().gateway;
  return {
    running: !!listening,
    url: listening?.url,
    error: lastError,
    calls: all.slice(-limit).reverse(),
    byProvider,
    byScope,
    windows: gw.windows.map((w) => windowState(w, all, now)),
  };
}

/** One tiny prompt through the running listener, as a background call would go. */
export async function testGateway(target: string): Promise<GatewayTest> {
  const t0 = Date.now();
  if (!listening) return { ok: false, text: lastError || 'The gateway is not running', status: 0, tries: [], ms: 0 };
  const scope: Scope = { role: 'oneshot' };
  let r: Response;
  try {
    r = await fetch(`${listening.url}/s/oneshot/_/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${scopeToken(scope)}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: target, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with just the word "Connected" and nothing else.' }] }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return { ok: false, text: (e as Error).message, status: 0, tries: [], ms: Date.now() - t0 };
  }
  const body = (await r.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
  const call = callLog().get(r.headers.get('x-crew-call'));
  const text = r.ok
    ? (body.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim() || '(no text)'
    : String(body.error?.message || `HTTP ${r.status}`);
  return { ok: r.ok, text, status: r.status, provider: call?.provider, model: call?.model, tries: call?.tries || [], ms: Date.now() - t0 };
}

/** Today's model connection as a gateway provider, key included (it never goes to the UI). */
export function importConnection(s: Settings = settings.get()): { provider: GatewayProvider; token: string } {
  if (s.authMode === 'provider' && s.provider.baseUrl) {
    const preset = providerPreset(s.provider.preset);
    const models = [...new Set([s.provider.model, s.provider.fastModel, ...(preset?.models || [])].filter(Boolean))];
    return {
      provider: { id: s.provider.preset || 'custom', name: preset?.name || 'Custom', baseUrl: s.provider.baseUrl, auth: 'bearer', models },
      token: s.providerToken || preset?.defaultToken || '',
    };
  }
  if (s.authMode === 'api-key' && s.apiKey) {
    const models = MODEL_OPTIONS.map((m) => m.id).filter(Boolean);
    return { provider: { id: 'anthropic', name: 'Anthropic API', baseUrl: s.baseUrl || 'https://api.anthropic.com', auth: 'x-api-key', models }, token: s.apiKey };
  }
  throw new Error("The current connection is Claude Code's own login, which the gateway cannot use. Add a provider with an API key instead.");
}

/** Adds the imported provider under a free id, and makes it the default when there is none. */
export function addImportedProvider(): GatewayProvider {
  const s = settings.get();
  const { provider, token } = importConnection(s);
  let id = PROVIDER_ID.test(provider.id) ? provider.id : 'imported';
  for (let i = 2; s.gateway.providers.some((p) => p.id === id); i++) id = `${provider.id}-${i}`;
  const p = { ...provider, id };
  const gateway = normalizeGateway({ ...s.gateway, providers: [...s.gateway.providers, p], defaultTarget: s.gateway.defaultTarget || (p.models[0] ? `${id}/${p.models[0]}` : '') });
  settings.update({ gateway, gatewayTokens: token ? { ...s.gatewayTokens, [id]: token } : s.gatewayTokens });
  return p;
}
