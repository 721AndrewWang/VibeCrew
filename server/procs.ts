// Long-running shell commands Crew starts itself (the dev server, a full-duplex bot's background
// jobs): each runs in a process group of its own, so stopping it reaches whatever it spawned.

import { type ChildProcess, spawn } from 'node:child_process';
import { cleanEnv } from './config';

export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** `bash -c command` in `cwd`, detached into its own process group, with the cleaned environment. */
export function spawnGroup(command: string, cwd: string, env: Record<string, string> = {}): ChildProcess {
  return spawn('bash', ['-c', command], { cwd, env: cleanEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** SIGTERM to the whole group, SIGKILL after `graceMs` if it has not exited. Resolves once it is gone (or given up on). */
export async function killGroup(child: ChildProcess, graceMs = 3000): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
