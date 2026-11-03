// Verifying a speculative run (ADR 008): Crew, not the model, runs the project's check command
// twice in the run's throwaway worktree. After: at the run's last commit, it must pass. Before:
// with the fix files put back as they were in the observed state and the reproduction kept, it
// must fail. The checks run like a background job's command (jobs/runner.ts): inside Claude Code's
// sandbox while it is on, else in a process group with a credential-stripped environment.

import fs from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SpeculativeCheck } from '../../shared/types';
import type { CleanEnvOptions } from '../config';
import { runDirect, runSandboxed } from '../jobs/runner';
import { gitIn } from '../projects';

/** One check run at most this long (a sandboxed Bash call cannot run longer). */
export const CHECK_TIMEOUT_MIN = 10;
const TAIL_CHARS = 3000;
const TAIL_LINES = 30;

export interface CheckEnv {
  /** The member's sandbox options; set: the check runs as a sandboxed Bash call. */
  sandbox?: NonNullable<Options['sandbox']>;
  denyRules: string[];
  deniedReason(tool: string, input: unknown): string | null;
  env: Record<string, string>;
  envOptions: CleanEnvOptions;
  /** The sandboxed helper session's environment. */
  agentEnv: Record<string, string>;
}

/** Runs the check command once in `cwd`; never throws. */
export function runCheck(command: string, cwd: string, ce: CheckEnv, timeoutMin = CHECK_TIMEOUT_MIN): Promise<SpeculativeCheck> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let done = false;
    const hooks = {
      onOutput: (text: string) => {
        out = (out + text).slice(-TAIL_CHARS * 2);
      },
      onExit: (r: { exitCode: number | null; signal: string | null; error?: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (r.error) out += `\n${r.error}`;
        if (timedOut) out += `\n(Crew stopped it after ${timeoutMin} min)`;
        const tail = out.trim().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
        resolve({ ok: !timedOut && !r.error && r.exitCode === 0, exitCode: r.exitCode, secs: Math.round((Date.now() - started) / 1000), tail });
      },
    };
    const run = ce.sandbox
      ? runSandboxed(command, { cwd, title: 'Speculative check', timeoutMin, sandbox: ce.sandbox, denyRules: ce.denyRules, deniedReason: ce.deniedReason, env: ce.agentEnv }, hooks)
      : runDirect(command, cwd, ce.env, hooks, ce.envOptions);
    const timer = setTimeout(() => {
      timedOut = true;
      void run.stop();
    }, timeoutMin * 60_000);
    timer.unref();
  });
}

export interface VerifyInput {
  /** The worktree's top, where git runs. */
  worktree: string;
  /** The run's folder inside it, where the check runs. */
  cwd: string;
  base: string;
  head: string;
  /** Repository paths of the fix (everything it changed but the reproduction). */
  fixFiles: string[];
  checkCommand: string;
  env: CheckEnv;
}

export type VerifyResult = { ok: true; after: SpeculativeCheck; before: SpeculativeCheck } | { ok: false; why: string; after?: SpeculativeCheck; before?: SpeculativeCheck };

/** After first (a fix that breaks the checks needs no second run), then before. */
export async function verifyFix(v: VerifyInput): Promise<VerifyResult> {
  const after = await runCheck(v.checkCommand, v.cwd, v.env);
  if (!after.ok) return { ok: false, why: `The checks fail with the fix (${exitText(after)})`, after };
  let before: SpeculativeCheck;
  try {
    await revertFix(v);
    before = await runCheck(v.checkCommand, v.cwd, v.env);
  } finally {
    await gitIn(v.worktree, ['reset', '-q', '--hard', v.head]).catch(() => {});
  }
  if (before.ok) return { ok: false, why: 'The checks pass without the fix too, so the reproduction does not show the problem', after, before };
  return { ok: true, after, before };
}

const exitText = (c: SpeculativeCheck) => (c.exitCode === null ? 'it did not finish' : `exit code ${c.exitCode}`);

/** Puts the fix files back as they were at base: restored where they existed, removed where the run added them. */
async function revertFix(v: VerifyInput) {
  for (const f of v.fixFiles) {
    const existed = await gitIn(v.worktree, ['cat-file', '-e', `${v.base}:${f}`]).then(
      () => true,
      () => false,
    );
    if (existed) await gitIn(v.worktree, ['checkout', v.base, '--', f]);
    else fs.rmSync(path.join(v.worktree, f), { force: true });
  }
}
