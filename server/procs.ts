// Long-running shell commands Crew starts itself (the dev server, a full-duplex bot's background
// jobs): each runs in a process group of its own, so stopping it reaches whatever it spawned.

import { type ChildProcess, spawn } from 'node:child_process';
import { type CleanEnvOptions, cleanEnv } from './config';

export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/**
 * `bash -c command` in `cwd`, detached into its own process group, with the cleaned environment.
 * An agent's command passes `envOptions` so it runs without the user's credentials (ADR 007).
 */
export function spawnGroup(command: string, cwd: string, env: Record<string, string> = {}, envOptions: CleanEnvOptions = {}): ChildProcess {
  return spawn('bash', ['-c', command], { cwd, env: cleanEnv(env, envOptions), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // The leader can be gone while others in its group are still on their way out (or ignore
  // SIGTERM): give them the rest of the grace period, then SIGKILL whatever is left.
  const groupAlive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = Date.now() + graceMs;
  while (groupAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  if (groupAlive()) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
