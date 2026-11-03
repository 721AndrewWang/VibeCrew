// When to speculate (ADR 008), by fixed rules read off the event, in autoChallenge's style: which
// signal it is, and whether a gate says no. Not by a model's judgment of whether a problem is worth
// fixing: spending a Worker session is a deterministic, budgeted decision. Also the rules a run's
// claim must pass before Crew spends time running the checks. Pure.

import type { ProjectSpeculative, Speculation, SpeculativeSettings, SpeculativeSignal } from '../../shared/types';
import { clip } from '../text';
import { isConsoleNoise } from '../triggers/fastPath';

/** A command that reads like a project check: tests, type checks, linters, builds. */
const CHECK_WORDS = /\b(test|tests|vitest|jest|mocha|ava|pytest|unittest|go test|cargo test|cargo check|tsc|typecheck|type-check|lint|eslint|biome|ruff|mypy|build|check)\b/i;

/** A user describing a problem. */
const BUG_WORDS =
  /\b(bugs?|broken|breaks|crash(es|ed|ing)?|errors?|exceptions?|fails?|failing|failed|failure|doesn'?t work|does not work|don'?t work|isn'?t working|not working|stopped working|no longer works|wrong|blank page|white screen|regression|undefined is not|cannot read|can'?t read|is not a function|is not defined|TypeError|ReferenceError|SyntaxError|500|404)\b/i;

/** A user asking for the fix: the bot the message went to is on it already. */
const FIX_ASK =
  /^\s*(please\s+)?(fix|repair|debug|solve|resolve|patch)\b|\b(can|could|would|will) you\s+(please\s+)?(fix|repair|debug|solve|resolve|patch|look into)\b|\bplease\s+(fix|repair|debug|solve|resolve|patch)\b|\b(fix|repair) (it|this|that)\b/i;

/** Rules the fast path settled an event by that mean nobody wants it looked at. */
const QUIET_RULES = new Set(['source-ignored', 'explicit-only', 'no-errors', 'known-noise']);

export type SignalInput =
  /** A background job ended (ADR 004). */
  | { source: 'job'; failed: boolean; command: string; checkCommand: string }
  /** Console errors in the preview, after the fast path. */
  | { source: 'preview-console'; filterRule: string; errors: string[] }
  /** A user's message. */
  | { source: 'user'; text: string }
  /** A check run GitHub reported on a pull request (ADR 102): its name, conclusion and `owner/repo#n`. */
  | { source: 'github'; check: string; conclusion: string; ref: string };

/** GitHub conclusions that mean the check found a problem (not cancelled, skipped or neutral). */
const GITHUB_FAILED = new Set(['failure', 'timed_out']);

export interface SignalMatch {
  signal: SpeculativeSignal;
  /** Which rules matched, in words for the user. */
  reasons: string[];
}

/** Whether the event is one of the three signals, and why; null when it is not. */
export function signalOf(input: SignalInput): SignalMatch | null {
  if (input.source === 'job') {
    if (!input.failed || !input.command.trim()) return null;
    const cmd = input.command.trim();
    const check = input.checkCommand.trim();
    if (check && (cmd === check || cmd.startsWith(`${check} `))) return { signal: 'failing-check', reasons: [`The project's check command failed: ${clip(cmd, 80)}`] };
    const word = cmd.match(CHECK_WORDS)?.[0];
    return word ? { signal: 'failing-check', reasons: [`A check failed: ${clip(cmd, 80)} (it reads like a check: "${word}")`] } : null;
  }
  if (input.source === 'github') {
    if (!GITHUB_FAILED.has(input.conclusion)) return null;
    return { signal: 'failing-check', reasons: [`GitHub check "${clip(input.check, 60)}" ${input.conclusion === 'timed_out' ? 'timed out' : 'failed'} on ${input.ref}`] };
  }
  if (input.source === 'preview-console') {
    if (QUIET_RULES.has(input.filterRule)) return null;
    const errors = input.errors.filter((e) => e.trim() && !isConsoleNoise(e));
    if (!errors.length) return null;
    return { signal: 'console-error', reasons: [`The preview logged ${errors.length === 1 ? 'an error' : `${errors.length} errors`}: ${clip(errors[0], 80)}`] };
  }
  const text = input.text.trim();
  if (text.split(/\s+/).length < 3) return null;
  const bug = text.match(BUG_WORDS)?.[0];
  if (!bug || FIX_ASK.test(text)) return null;
  return { signal: 'bug-report', reasons: [`The user describes a problem ("${bug}") without asking for a fix yet`] };
}

/** The project switch for each signal. */
export function signalOn(rules: ProjectSpeculative, signal: SpeculativeSignal): boolean {
  if (signal === 'failing-check') return rules.signals.failingChecks;
  if (signal === 'console-error') return rules.signals.consoleErrors;
  return rules.signals.bugReports;
}

/** De-duplication: the same fingerprint is not speculated on again within this long. */
export const SAME_SIGNAL_MS = 24 * 3600_000;

export interface GateInput {
  rules: ProjectSpeculative;
  settings: SpeculativeSettings;
  signal: SpeculativeSignal;
  checkCommand: string;
  /** The fast path sent the Trigger straight to subscribed Workers (ADR 003). */
  subscribed: boolean;
  chat: boolean;
  /** Why the member it would run as cannot, if it cannot. */
  bot: string | null;
  git: boolean;
  /**
   * A GitHub check's head commit (ADR 011): the state to reproduce, whether the local repository
   * has it, and if not, the remote it can be fetched from (ADR 110).
   */
  head?: { sha: string; present: boolean; fetchFrom?: string };
  /** A run on the same fingerprint within SAME_SIGNAL_MS: its id. */
  duplicateOf?: string;
  inFlight: number;
  inFlightHere: number;
  spentTodayUsd: number;
}

/** The first gate that says no, in words; null when a run may start. In order: cheapest and most telling first. */
export function gateRefusal(g: GateInput): string | null {
  if (!g.rules.enabled) return 'Speculative runs are off for this project';
  if (!signalOn(g.rules, g.signal)) return `This project does not speculate on ${g.signal === 'failing-check' ? 'failing checks' : g.signal === 'console-error' ? 'console errors' : 'bug reports'}`;
  if (!g.checkCommand) return "The project has no check command, so nothing could verify a fix (set one in the project's settings)";
  if (g.subscribed) return 'It went straight to Workers already working there';
  if (!g.chat) return 'No chat works on this project, so there is nowhere to surface a fix';
  if (g.bot) return g.bot;
  if (!g.git) return "The project isn't a git repository with a commit, so there is no throwaway workspace";
  // Not local, and no remote here reaches the pull request's repository: the user can fetch it.
  if (g.head && !g.head.present && !g.head.fetchFrom)
    return `The pull request's head commit ${g.head.sha.slice(0, 7)} is not in the local repository (fetch it), so the state the check failed in cannot be reproduced`;
  if (g.duplicateOf) return `The same signal was speculated on in the last 24 hours (${g.duplicateOf})`;
  if (g.inFlight >= g.settings.maxConcurrent) return `${g.inFlight} speculative run${g.inFlight === 1 ? ' is' : 's are'} already going (at most ${g.settings.maxConcurrent})`;
  if (g.inFlightHere) return 'A speculative run is already going in this project';
  if (g.spentTodayUsd >= g.settings.dailyBudgetUsd) return `Today's speculative budget of $${g.settings.dailyBudgetUsd.toFixed(2)} is used up`;
  return null;
}

/** Why the member cannot run a speculative fix, or null. */
export function botRefusal(b: { name: string; blindReview?: boolean; level: string; overBudget: boolean } | undefined): string | null {
  if (!b) return 'The chat has no member to run as';
  if (b.blindReview) return `${b.name} is a blind reviewer`;
  if (b.level === 'plan') return `${b.name} is read-only, so it could not fix anything`;
  if (b.level === 'ask') return `${b.name} asks before every step, and a speculative run cannot ask`;
  if (b.overBudget) return `${b.name} has used up this month's budget`;
  return null;
}

/** A fix may touch at most this many files. */
export const MAX_FIX_FILES = 10;

export type ChangedFile = Omit<NonNullable<Speculation['files']>[number], 'test'>;

/** A claimed path, as git names it from the repository's top: relative to the run's folder (prefix) unless it already starts there. */
export function repoPath(p: string, prefix: string, worktree: string): string {
  let rel = p.trim().replace(/\\/g, '/');
  const top = `${worktree.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  if (rel.startsWith(top)) return rel.slice(top.length);
  rel = rel.replace(/^\.\//, '').replace(/^\/+/, '');
  return prefix && !rel.startsWith(prefix) ? `${prefix}${rel}` : rel;
}

export type ClaimVerdict = { ok: true; testFiles: string[]; fixFiles: string[]; fixLines: number } | { ok: false; why: string };

/**
 * The claim's rules, before any check runs: it says it reproduced the problem, its changes split
 * into a reproduction (the test files it named) and a fix (the rest), and the fix is small.
 */
export function judgeClaim(claim: { reproduced: boolean; testFiles: string[] } | undefined, changed: ChangedFile[], maxFixLines: number, toRepo: (p: string) => string): ClaimVerdict {
  if (!claim) return { ok: false, why: 'It ended without reporting a result' };
  if (!claim.reproduced) return { ok: false, why: 'It could not reproduce the problem' };
  if (!changed.length) return { ok: false, why: 'It changed nothing' };
  const named = new Set(claim.testFiles.map(toRepo));
  const testFiles = changed.filter((f) => named.has(f.path)).map((f) => f.path);
  const fix = changed.filter((f) => !named.has(f.path));
  if (!fix.length) return { ok: false, why: 'It changed only the reproduction, no fix' };
  const fixLines = fix.reduce((n, f) => n + f.added + f.removed, 0);
  if (fix.length > MAX_FIX_FILES) return { ok: false, why: `The fix touches ${fix.length} files (at most ${MAX_FIX_FILES} are surfaced)` };
  if (fixLines > maxFixLines) return { ok: false, why: `The fix changes ${fixLines} lines (at most ${maxFixLines} are surfaced)` };
  return { ok: true, testFiles, fixFiles: fix.map((f) => f.path), fixLines };
}
