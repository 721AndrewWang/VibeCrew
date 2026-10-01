// A real Crew server for tests: its own data folder, projects folder, git identity and port, so
// tests never touch ~/.crew or each other. The demo agent (CREW_FAKE_AGENT) answers instead of a
// model unless a test asks for the real Claude Code.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** A fresh temporary folder (removed by the server's stop(), or by the caller). */
export function tempDir(prefix = 'crew-test'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** A port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Git settings for a test: a throwaway identity, no system or user config. */
export function gitEnv(dir: string): Record<string, string> {
  const file = path.join(dir, 'gitconfig');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[user]\n\tname = Crew Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

/** Runs git in `dir` with the test identity; returns trimmed stdout. */
export function git(dir: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A git repository with the given files, committed once. */
export function initRepo(dir: string, env: Record<string, string>, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, env, 'init', '-q');
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-qm', 'init');
  return dir;
}

export type Api = <T = any>(method: string, url: string, body?: unknown) => Promise<T & { status: number }>;

export interface CrewServer {
  /** http://127.0.0.1:<port> */
  base: string;
  port: number;
  /** The temporary root: home/ (CREW_HOME), projects/, gitconfig. */
  dir: string;
  home: string;
  /** The server's environment (git identity included), for helpers that run git or the CLI. */
  env: Record<string, string>;
  api: Api;
  /** stdout + stderr so far. */
  log(): string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** The demo agent instead of Claude Code (default true). */
  fakeAgent?: boolean;
  /** Extra environment, applied last. */
  env?: Record<string, string | undefined>;
  /** Use this folder as the temporary root (kept by stop()). */
  dir?: string;
  /** false: no CREW_HOME / CREW_PROJECTS, e.g. to test the data-folder migration under a fake HOME. */
  isolate?: boolean;
}

/** Variables of the shell running the tests that must not reach the server (Claude Code's own session). */
const LEAKY = /^(CLAUDE|ANTHROPIC_|CREW_|VIBECREW_)/;

export async function startServer(opts: StartOptions = {}): Promise<CrewServer> {
  const owned = !opts.dir;
  const dir = opts.dir ?? tempDir();
  const port = await freePort();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !LEAKY.test(k)) env[k] = v;
  Object.assign(env, gitEnv(dir), { CREW_PORT: String(port) });
  if (opts.isolate !== false) Object.assign(env, { CREW_HOME: path.join(dir, 'home'), CREW_PROJECTS: path.join(dir, 'projects') });
  if (opts.fakeAgent !== false) env.CREW_FAKE_AGENT = '1';
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc: ChildProcess = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;

  const api: Api = async (method, url, body) => {
    const r = await fetch(`${base}/api${url}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    return { ...(Array.isArray(json) ? { items: json } : json), status: r.status };
  };

  const stop = async () => {
    if (proc.exitCode === null && proc.pid) {
      const exited = new Promise((r) => proc.once('exit', r));
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    if (owned && !process.env.CREW_TEST_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  };

  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null || i > 120) {
      await stop();
      throw new Error(`Crew server did not start:\n${out.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, port, dir, home: env.CREW_HOME ?? path.join(env.HOME ?? os.homedir(), '.crew'), env, api, log: () => out, stop };
}

/** Polls `fn` until it returns something truthy (or throws after `ms`). */
export async function waitFor<T>(fn: () => Promise<T> | T, ms = 20_000, every = 250): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/**
 * Waits until every bot reply after `sinceSeq` has finished and the chat is idle again; returns the
 * last reply. A reply reads `done` a moment before its turn is over: the auto-commit, notes and the
 * chat's lock come after, so the bots' statuses are waited for too.
 */
export async function waitTurn(api: Api, chatId: string, sinceSeq: number, ms = 60_000): Promise<any> {
  const last = await waitFor(async () => {
    const { messages } = await api<{ messages: any[] }>('GET', `/chats/${chatId}/messages?limit=30`);
    const bot = messages.filter((m) => m.role === 'bot' && m.seq > sinceSeq);
    return bot.length && bot.every((m) => ['done', 'error', 'stopped'].includes(m.status)) ? bot[bot.length - 1] : null;
  }, ms);
  await waitFor(async () => {
    const { statuses } = await api<{ statuses: Record<string, { state: string; chatId?: string }> }>('GET', '/bootstrap');
    return !Object.values(statuses || {}).some((s) => s.chatId === chatId && s.state !== 'idle' && s.state !== 'error');
  }, ms);
  return last;
}

/** The Claude Code CLI, when installed (tests that drive it skip otherwise). */
export function claudeCli(): string | null {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
