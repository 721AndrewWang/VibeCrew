// Deterministic checks on `start`, before the approval gate (ADR 004). Pure.

import type { PermissionLevel } from '../../shared/types';

/** Running jobs one chat may have at once. */
export const MAX_RUNNING = 4;
export const DEFAULT_TIMEOUT_MIN = 60;
export const MAX_TIMEOUT_MIN = 720;
/** Claude Code's Bash tool gives up after this long: the most a sandboxed command can run. */
export const SANDBOX_TIMEOUT_MIN = 10;

export interface StartRequest {
  command?: string;
  task?: string;
  timeoutMin?: number;
}

/** Why `start` is refused, or null. */
export function startRefusal(req: StartRequest, ctx: { level: PermissionLevel; running: number; hasProject: boolean }): string | null {
  const command = req.command?.trim();
  const task = req.task?.trim();
  if (!command && !task) return 'Give either command (a shell command) or task (a sub-task for a background session).';
  if (command && task) return 'Give either command or task, not both.';
  if (ctx.level === 'plan') return 'You are a read-only role: you cannot start commands or sub-tasks. Put what should be run in your reply.';
  if (command && command.length > 10_000) return 'The command is too long (at most 10,000 characters); put it in a script file first.';
  if (task && task.length > 20_000) return 'The task is too long (at most 20,000 characters).';
  if (req.timeoutMin !== undefined && !(req.timeoutMin >= 1 && req.timeoutMin <= MAX_TIMEOUT_MIN)) return `timeoutMin must be between 1 and ${MAX_TIMEOUT_MIN}.`;
  if (ctx.running >= MAX_RUNNING) return `This chat already has ${ctx.running} jobs running (at most ${MAX_RUNNING}). Wait for one to finish, or stop one.`;
  return null;
}

/** The timeout a job gets: what was asked (default 60 min), and no more than a sandboxed Bash call can run. */
export function timeoutFor(asked: number | undefined, sandboxed: boolean): number {
  const t = Math.round(asked ?? DEFAULT_TIMEOUT_MIN);
  return sandboxed ? Math.min(t, SANDBOX_TIMEOUT_MIN) : t;
}
