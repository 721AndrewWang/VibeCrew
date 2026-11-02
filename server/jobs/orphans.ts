// A command Crew runs itself lives in a process group of its own (procs.ts), so a crash of Crew
// does not take it down: before this, a restart marked the job stopped while the command went on
// running (and writing) with nobody reading it. The job records its group (`pid`); on start, a
// group still alive is stopped before the job is reported (ADR 105).

import { execFileSync } from 'node:child_process';
import type { BackgroundJob } from '../../shared/types';
import { logger } from '../log';

const log = logger('jobs');

/** `ps -o etime=` ("[[dd-]hh:]mm:ss") in ms, or null. Pure. */
export function etimeMs(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, min, s] = m.map((x) => Number(x || 0));
  return (((d * 24 + h) * 60 + min) * 60 + s) * 1000;
}

/**
 * Whether a live group leader is the job's own process, and not an unrelated one given the same id
 * later: it started when the job did. (Its command line does not tell: bash execs the last command.) Pure.
 */
export function startedWithJob(elapsedMs: number, startedAt: number, now: number, toleranceMs = 10_000): boolean {
  return Math.abs(now - elapsedMs - startedAt) <= toleranceMs;
}

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** How long the process has run, or null when it is gone (or ps cannot say). */
function elapsedOf(pid: number): number | null {
  try {
    return etimeMs(execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }));
  } catch {
    return null;
  }
}

/**
 * Stops what is left of a job's command after a restart: SIGTERM to its group now, SIGKILL in 3 s.
 * A group whose leader is gone but which still has members is the job's: an id is not handed out
 * again while a group uses it. A live leader must have started with the job. Returns whether it was running.
 */
export function reapOrphan(j: Pick<BackgroundJob, 'id' | 'pid' | 'startedAt'>, now = Date.now()): boolean {
  const pgid = j.pid;
  if (!pgid || !alive(pgid)) return false;
  const elapsed = elapsedOf(pgid);
  if (elapsed !== null && !startedWithJob(elapsed, j.startedAt, now)) return false;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return false;
  }
  setTimeout(() => {
    if (!alive(pgid)) return;
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* gone meanwhile */
    }
  }, 3000).unref();
  log.info(`${j.id}: its command was still running after a restart; stopped it`);
  return true;
}
