import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { AuthStatus } from '../shared/types';
import { bus } from './bus';
import { cleanEnv, findClaudeExecutable } from './config';
import { providerPreset } from './data/providers';
import { type Settings, settings } from './store';

const run = promisify(execFile);

let cached: AuthStatus = { cliFound: false, loggedIn: false, method: 'unknown', ready: false, checkedAt: 0 };
let inflight: Promise<AuthStatus> | null = null;

export function authStatus(): AuthStatus {
  return cached;
}

/** A provider connection has what it needs: an address and a token (local servers may not need one). */
export function providerConfigured(s: Settings = settings.get()): boolean {
  return !!s.provider.baseUrl && !!(s.providerToken || providerPreset(s.provider.preset)?.defaultToken) && !!s.provider.model;
}

/**
 * Environment for the bots' Claude Code: which endpoint, credentials and models it uses.
 * undefined removes a variable; '' sets it empty.
 */
export function modelEnv(s: Settings = settings.get()): Record<string, string | undefined> {
  if (s.authMode === 'api-key' && s.apiKey) {
    return { ANTHROPIC_API_KEY: s.apiKey, CLAUDE_CODE_OAUTH_TOKEN: undefined, ...(s.baseUrl ? { ANTHROPIC_BASE_URL: s.baseUrl } : {}) };
  }
  if (s.authMode === 'provider') {
    const p = s.provider;
    const preset = providerPreset(p.preset);
    const fast = p.fastModel || p.model;
    return {
      ...preset?.env,
      ANTHROPIC_BASE_URL: p.baseUrl,
      // Sent as "Authorization: Bearer"; the API key must be empty or Claude Code sends that instead.
      ANTHROPIC_AUTH_TOKEN: s.providerToken || preset?.defaultToken || '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      // Every Claude tier maps to the provider's models.
      ANTHROPIC_MODEL: p.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: p.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
      CLAUDE_CODE_SUBAGENT_MODEL: preset?.subagentsUseMain ? p.model : fast,
      // No telemetry, error reports or update checks to Anthropic while using someone else's models.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }
  return {};
}

/** A bot's model setting, or undefined to use the connection's default. */
export function botModel(model: string | undefined): string | undefined {
  const s = settings.get();
  const m = model || s.defaultModel || undefined;
  // Claude model names mean nothing to another provider: its own model (ANTHROPIC_MODEL) applies.
  if (s.authMode === 'provider' && m && /^claude-|^(opus|sonnet|haiku|fable)$/i.test(m)) return undefined;
  return m;
}

/** Asks the Claude Code CLI whether it can make requests (no model call involved). */
export async function checkAuth(force = false): Promise<AuthStatus> {
  if (!force && Date.now() - cached.checkedAt < 60_000) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // A forced check (the Re-check button) also looks for a CLI installed since the last check.
    const cli = findClaudeExecutable(force);
    const s = settings.get();
    const next: AuthStatus = { cliFound: !!cli, cliPath: cli || undefined, loggedIn: false, method: 'none', ready: false, checkedAt: Date.now() };
    if (cli) {
      const env = cleanEnv(modelEnv(s));
      try {
        const { stdout } = await run(cli, ['--version'], { env, timeout: 15_000 });
        next.cliVersion = stdout.trim().split(/\s/)[0];
      } catch {
        /* version is informational */
      }
      if (s.authMode === 'provider') {
        next.loggedIn = providerConfigured(s);
        next.method = 'provider';
      } else if (s.authMode === 'api-key' && s.apiKey) {
        next.loggedIn = true;
        next.method = 'api-key';
      } else {
        try {
          const { stdout } = await run(cli, ['auth', 'status'], { env, timeout: 15_000 });
          const j = JSON.parse(stdout);
          next.loggedIn = !!j.loggedIn;
          next.method = String(j.authMethod || (j.loggedIn ? 'unknown' : 'none'));
        } catch (e) {
          // Older CLIs print text; a non-zero exit means "not logged in".
          const out = String((e as { stdout?: string }).stdout || '');
          try {
            const j = JSON.parse(out);
            next.loggedIn = !!j.loggedIn;
            next.method = String(j.authMethod || 'none');
          } catch {
            next.method = 'unknown';
          }
        }
      }
    }
    next.ready = next.cliFound && next.loggedIn;
    const changed = next.ready !== cached.ready || next.loggedIn !== cached.loggedIn || next.cliFound !== cached.cliFound || next.method !== cached.method;
    cached = next;
    if (changed) bus.emit({ t: 'auth', auth: next });
    return next;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface ConnectionTest {
  ok: boolean;
  /** The model's reply, or what went wrong. */
  text: string;
  /** Models that answered, as Claude Code reports them. */
  models?: string[];
  ms: number;
}

/**
 * One POST through curl, which honours the proxy variables (Node's fetch does not). The config,
 * key included, goes in on stdin so it never shows in the process list.
 */
function curlPost(url: string, headers: string[], body: unknown): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sS', '--max-time', '30', '-K', '-', '-w', '\n%{http_code}'], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ error: err.trim() || `curl exit ${code}` });
      const i = out.lastIndexOf('\n');
      resolve({ status: Number(out.slice(i + 1)) || 0, body: out.slice(0, i) });
    });
    const q = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    child.stdin.end([`url = ${q(url)}`, ...headers.map((h) => `header = ${q(h)}`), `data = ${q(JSON.stringify(body))}`].join('\n') + '\n');
  });
}

/**
 * A direct request to the endpoint: a wrong key, address or model fails here at once with the
 * provider's own message (Claude Code would keep retrying). null: nothing to check this way.
 */
async function probe(s: Settings): Promise<ConnectionTest | null> {
  let base: string;
  let auth: string;
  let model: string;
  if (s.authMode === 'provider') {
    base = s.provider.baseUrl;
    auth = `authorization: Bearer ${s.providerToken || providerPreset(s.provider.preset)?.defaultToken || ''}`;
    model = s.provider.model;
  } else if (s.authMode === 'api-key' && s.apiKey) {
    base = s.baseUrl || 'https://api.anthropic.com';
    auth = `x-api-key: ${s.apiKey}`;
    model = 'claude-haiku-4-5';
  } else {
    return null;
  }
  const t0 = Date.now();
  // "[1m]" only tells Claude Code about a 1M context window; it is not part of the model name.
  const body = { model: model.replace(/\[1m\]$/i, ''), max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  const r = await curlPost(`${base.replace(/\/+$/, '')}/v1/messages`, [auth, 'content-type: application/json', 'anthropic-version: 2023-06-01'], body);
  const ms = Date.now() - t0;
  if ('error' in r) {
    if (/ENOENT/.test(r.error)) return null; // no curl: let Claude Code tell
    return { ok: false, text: `Can't reach ${base}: ${r.error.replace(/^curl: \(\d+\)\s*/, '')} (you may need a proxy)`, ms };
  }
  if (r.status >= 200 && r.status < 300) return { ok: true, text: '', ms };
  let msg = r.body.slice(0, 300);
  try {
    const j = JSON.parse(r.body);
    msg = String(j.error?.message || j.message || j.error || msg);
  } catch {
    /* not JSON */
  }
  const why =
    r.status === 401 || r.status === 403
      ? 'Wrong key or no permission'
      : r.status === 404
        ? 'Wrong URL or model name'
        : r.status === 429
          ? 'Out of quota or too many requests'
          : r.status >= 500
            ? 'The provider had an error'
            : 'Request rejected';
  return { ok: false, text: `${why} (HTTP ${r.status}): ${msg}`, ms };
}

/**
 * Sends one tiny prompt through Claude Code with the given connection settings: the same path the
 * bots take (endpoint, credentials, model mapping, proxy), so a pass means the bots can work.
 */
export async function testConnection(s: Settings): Promise<ConnectionTest> {
  const cli = findClaudeExecutable();
  if (!cli) return { ok: false, text: 'Claude Code not found. Install it first: npm i -g @anthropic-ai/claude-code', ms: 0 };
  if (s.authMode === 'provider' && !providerConfigured(s)) return { ok: false, text: 'Fill in the URL, key and main model first', ms: 0 };
  const quick = await probe(s);
  if (quick && !quick.ok) return quick;
  const t0 = Date.now();
  let out = '';
  let err = '';
  try {
    ({ stdout: out } = await run(cli, ['-p', 'Reply with just the word "Connected" and nothing else.', '--output-format', 'json', '--max-turns', '1'], {
      env: cleanEnv(modelEnv(s)),
      cwd: os.tmpdir(),
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    out = String(x.stdout || '');
    err = x.killed ? 'No response after 2 minutes. Check the URL and your network (you may need a proxy).' : String(x.stderr || x.message || '').trim();
  }
  const ms = Date.now() - t0;
  try {
    const j = JSON.parse(out.trim().split('\n').pop() || '');
    const text = String(j.result ?? '').trim();
    const models = j.modelUsage ? Object.keys(j.modelUsage) : undefined;
    if (j.is_error || j.subtype !== 'success') return { ok: false, text: text || err || 'Request failed', models, ms };
    return { ok: true, text: text || '(the model replied with no text)', models, ms };
  } catch {
    return { ok: false, text: err.split('\n').slice(-3).join(' ') || 'Request failed: Claude Code returned no result', ms };
  }
}
