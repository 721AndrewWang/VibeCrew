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

/**
 * A port nothing listens on right now. Only for processes that cannot be told to take any free port
 * themselves: between this check and their bind, anything else may take it. Crew servers bind port 0.
 */
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
  /**
   * Ends the server at once, as a crash would, and keeps the folder for a restart. Like a real crash,
   * it takes down the server's process group (its Claude Code sessions) but not the commands Crew
   * started in groups of their own: a restarted server must find and stop those itself.
   */
  kill(): Promise<void>;
  /**
   * With StartOptions.clock: moves the server's Date.now() this many ms ahead of real time. Resolves
   * once the server has taken the new offset, so the next request already sees the moved clock.
   */
  shiftClock(ms: number): Promise<void>;
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
  /** Preload the test clock (helpers/clock.ts), so shiftClock() can move the server's time forward. */
  clock?: boolean;
}

/** Variables of the shell running the tests that must not reach the server (Claude Code's own session). */
const LEAKY = /^(CLAUDE|ANTHROPIC_|CREW_|VIBECREW_)/;

/** The line Crew prints once it listens, with the port it bound. */
const LISTENING = /Local:\s+http:\/\/localhost:(\d+)/;

/**
 * How long a server may take to start. Below vitest's hookTimeout (60 s), so a slow start fails here,
 * with the server's output, and the process is cleaned up, instead of the hook timing out around it.
 */
const START_MS = 50_000;

/**
 * Set in each server's environment to its temporary root. Crew passes it on to everything it starts
 * (it is neither a CREW_ variable nor a credential, which cleanEnv drops), so a Claude Code session,
 * a background job or a dev server in its own process group can still be told apart as this
 * server's, even after the server is gone and they were handed to init.
 */
const MARKER = 'CREWTEST_ROOT';

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
}

/** Every process on the machine (Linux /proc), or null where there is no /proc. */
function processes(): Proc[] | null {
  let ids: string[];
  try {
    ids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  const out: Proc[] = [];
  for (const id of ids) {
    try {
      // "pid (comm) state ppid pgrp …": comm may hold spaces and parentheses, so split after the last ')'.
      const stat = fs.readFileSync(`/proc/${id}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out.push({ pid: Number(id), ppid: Number(f[1]), pgid: Number(f[2]), zombie: f[0] === 'Z' || f[0] === 'X' });
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

const marked = (pid: number, mark: string) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(mark);
  } catch {
    return false;
  }
};

/**
 * The live processes that belong to a server: its process group, everything started with its marker,
 * and their children. Zombies are left out: they have exited and write nothing. Null without /proc.
 */
function processesOf(pgid: number, mark: string): number[] | null {
  const all = processes();
  if (!all) return null;
  const mine = new Set(all.filter((p) => !p.zombie && (p.pgid === pgid || marked(p.pid, mark))).map((p) => p.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!p.zombie && !mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid);
        grew = true;
      }
    }
  }
  mine.delete(process.pid);
  return [...mine];
}

/** Whether anything of the process group still runs (any platform; a zombie counts here). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Servers started by this test file and not stopped yet: killed when the file's worker exits. */
const running = new Set<() => void>();
process.once('exit', () => {
  for (const killNow of running) killNow();
});

export async function startServer(opts: StartOptions = {}): Promise<CrewServer> {
  const owned = !opts.dir;
  const dir = opts.dir ?? tempDir();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !LEAKY.test(k)) env[k] = v;
  // Port 0: the server takes any free port as it binds, so servers, mock providers and gateways
  // started side by side by parallel test files can never be handed the same one.
  Object.assign(env, gitEnv(dir), { CREW_PORT: '0', [MARKER]: dir });
  if (opts.isolate !== false) {
    // Claude Code's own config too: a test must never reach the developer's real Claude login.
    Object.assign(env, { CREW_HOME: path.join(dir, 'home'), CREW_PROJECTS: path.join(dir, 'projects'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude') });
    fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  }
  if (opts.fakeAgent !== false) env.CREW_FAKE_AGENT = '1';
  const clockFile = path.join(dir, 'clock');
  if (opts.clock) env.CREW_TEST_CLOCK_FILE = clockFile;
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const mark = `${MARKER}=${env[MARKER]}`;

  // tsx as a loader rather than its CLI: the CLI opens a Unix socket for IPC, which sandboxes refuse.
  const preload = opts.clock ? ['--import', './tests/helpers/clock.ts'] : [];
  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', ...preload, 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const pgid = proc.pid ?? 0;
  const exited = new Promise<void>((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once('exit', () => r())));
  const isRunning = () => proc.exitCode === null && proc.signalCode === null;
  let out = '';
  // Resolves with the port once the server says where it listens; rejects if it exits first.
  const listening = new Promise<number>((resolve, reject) => {
    const onData = (d: Buffer) => {
      out += d;
      const m = LISTENING.exec(out);
      if (m) resolve(Number(m[1]));
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('error', reject);
    void exited.then(() => reject(new Error(`exited with ${proc.exitCode ?? proc.signalCode}`)));
  });
  listening.catch(() => {});
  // Known once the server says where it listens (below), before anything uses it.
  let port = 0;
  let base = '';

  const api: Api = async (method, url, body) => {
    const r = await fetch(`${base}/api${url}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    return { ...(Array.isArray(json) ? { items: json } : json), status: r.status };
  };

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      if (pgid) process.kill(-pgid, sig);
    } catch {
      /* already gone */
    }
  };
  const killNow = () => {
    signalGroup('SIGKILL');
    for (const pid of processesOf(pgid, mark) ?? []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone meanwhile */
      }
    }
  };
  running.add(killNow);

  /** Until the server's process group is empty (a crash: its own-group children live on, as in real life). */
  const groupGone = async () => {
    const end = Date.now() + 10_000;
    while (pgid && Date.now() < end) {
      const left = processes();
      if (left ? !left.some((p) => p.pgid === pgid && !p.zombie) : !groupAlive(pgid)) return;
      await sleep(20);
    }
  };

  const kill = async () => {
    if (isRunning()) signalGroup('SIGKILL');
    await exited;
    signalGroup('SIGKILL');
    await groupGone();
  };

  /**
   * Shuts the server down as the user would (SIGTERM, so it stops its sessions, jobs and dev servers
   * itself), then kills whatever of it is left, wherever it runs, and waits until all of it has
   * exited: only then is nothing writing into the folder that is removed.
   */
  const stop = async () => {
    if (isRunning()) {
      signalGroup('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
    }
    const end = Date.now() + 15_000;
    for (;;) {
      killNow();
      await exited;
      const left = processesOf(pgid, mark);
      if (left ? left.length === 0 : !groupAlive(pgid)) break;
      if (Date.now() > end) throw new Error(`processes of the test server in ${dir} would not exit: ${left?.join(', ') ?? `group ${pgid}`}`);
      await sleep(20);
    }
    running.delete(killNow);
    if (owned && !process.env.CREW_TEST_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    port = await Promise.race([listening, sleep(START_MS).then(() => Promise.reject(new Error(`not listening after ${START_MS / 1000} s`)))]);
    base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 10_000, 20);
  } catch (e) {
    await stop().catch(() => {});
    throw new Error(`Crew server did not start (${(e as Error).message}):\n${out.slice(-2000)}`);
  }

  /** Writes a file whole (rename), so the server never reads it half-written. */
  const writeWhole = (file: string, text: string) => {
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  };
  const shiftClock = async (ms: number) => {
    if (!opts.clock) throw new Error('start the server with { clock: true } to shift its clock');
    writeWhole(clockFile, String(ms));
    // The server takes the offset within 50 ms and acknowledges it (helpers/clock.ts).
    await waitFor(
      () => {
        try {
          return fs.readFileSync(`${clockFile}.ack`, 'utf8') === String(ms);
        } catch {
          return false;
        }
      },
      10_000,
      10,
    );
  };
  return { base, port, dir, home: env.CREW_HOME ?? path.join(env.HOME ?? os.homedir(), '.crew'), env, api, log: () => out, stop, kill, shiftClock };
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
