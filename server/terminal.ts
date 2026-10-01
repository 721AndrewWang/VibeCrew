import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { cleanEnv } from './config';
import { logger } from './log';
import { getProject } from './projects';

const log = logger('terminal');

const require = createRequire(import.meta.url);

type PtyModule = typeof import('node-pty');
let pty: PtyModule | null = null;
try {
  pty = require('node-pty') as PtyModule;
} catch (e) {
  log.warn('node-pty 不可用，终端将使用简化模式：', (e as Error).message);
}
export const hasPty = !!pty;

interface Term {
  id: string;
  projectId: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  buffer: string;
  exited: boolean;
  exitCode: number | null;
  title: string;
  send: ((data: string) => void) | null;
  onExit: ((code: number | null) => void) | null;
}

const terms = new Map<string, Term>();
const MAX_BUFFER = 100_000;

function shellPath(): string {
  return process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
}

export function openTerminal(id: string, projectId: string, cols: number, rows: number, send: (data: string) => void, onExit: (code: number | null) => void, command?: string): Term {
  const existing = terms.get(id);
  if (existing) {
    // Re-attach after a page reload: replay the scrollback.
    existing.send = send;
    existing.onExit = onExit;
    if (existing.buffer) send(existing.buffer);
    if (existing.exited) onExit(existing.exitCode);
    else existing.resize(cols, rows);
    return existing;
  }
  const project = getProject(projectId);
  const env = cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', CREW_TERMINAL: '1' });
  const term: Term = {
    id,
    projectId,
    buffer: '',
    exited: false,
    exitCode: null,
    title: command || 'shell',
    send,
    onExit,
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
  const emit = (data: string) => {
    term.buffer += data;
    if (term.buffer.length > MAX_BUFFER) term.buffer = term.buffer.slice(-MAX_BUFFER / 2);
    term.send?.(data);
  };
  const exit = (code: number | null) => {
    term.exited = true;
    term.exitCode = code;
    term.onExit?.(code);
  };

  if (pty) {
    const file = command ? '/bin/bash' : shellPath();
    const args = command ? ['-lc', command] : [];
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols: Math.max(cols, 20), rows: Math.max(rows, 5), cwd: project.path, env });
    p.onData(emit);
    p.onExit(({ exitCode }) => exit(exitCode));
    term.write = (d) => p.write(d);
    term.resize = (c, r) => {
      try {
        p.resize(Math.max(c, 20), Math.max(r, 5));
      } catch {
        /* exited */
      }
    };
    term.kill = () => {
      try {
        p.kill();
      } catch {
        /* exited */
      }
    };
  } else {
    // Without node-pty: `script` allocates a pseudo-terminal for us on Linux/macOS.
    const inner = command || shellPath();
    const args = os.platform() === 'darwin' ? ['-q', '/dev/null', 'bash', '-lc', inner] : ['-qfc', inner, '/dev/null'];
    const child = spawn('script', args, { cwd: project.path, env: { ...env, COLUMNS: String(cols), LINES: String(rows) } });
    child.stdout.on('data', (b: Buffer) => emit(b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => emit(b.toString('utf8')));
    child.on('exit', (code) => exit(code));
    term.write = (d) => child.stdin.write(d);
    term.kill = () => child.kill('SIGHUP');
  }
  terms.set(id, term);
  return term;
}

export function terminalInput(id: string, data: string) {
  terms.get(id)?.write(data);
}

export function terminalResize(id: string, cols: number, rows: number) {
  terms.get(id)?.resize(cols, rows);
}

export function closeTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  t.kill();
  terms.delete(id);
}

/** Detaches a disconnected browser; the shell keeps running for a later re-attach. */
export function detachTerminals(send: (data: string) => void) {
  for (const t of terms.values()) {
    if (t.send === send) {
      t.send = null;
      t.onExit = null;
    }
  }
}

export function listTerminals(projectId: string) {
  return [...terms.values()].filter((t) => t.projectId === projectId).map((t) => ({ id: t.id, title: t.title, exited: t.exited }));
}

export function closeProjectTerminals(projectId: string) {
  for (const t of [...terms.values()]) if (t.projectId === projectId) closeTerminal(t.id);
}

export function closeAllTerminals() {
  for (const id of [...terms.keys()]) closeTerminal(id);
}
