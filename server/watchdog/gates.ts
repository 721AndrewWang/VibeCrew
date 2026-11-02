// The Watchdog's output is probabilistic; these checks are not. Each returns why a tick or an
// action is refused (the model reads it as the tool's error), or null. Pure.

import { wordCount } from '../layers/prompts';
import { NOTE_WORDS } from './prompts';

export { NOTE_WORDS };
export const NUDGES_PER_WORKER_PER_DAY = 2;
export const RESTARTS_PER_WORKER_PER_DAY = 3;
export const NOTICES_PER_CHAT_PER_DAY = 4;
export const MAX_OPEN_WATCHES = 10;
export const MAX_PENDING_PROPOSALS = 3;

/** Why a tick must not call the model now, or null. "Tick now" is held to the same limits. */
export function tickRefusal(c: { ticksLastHour: number; maxTicksPerHour: number; spentToday: number; dailyBudgetUsd: number; busy: boolean }): string | null {
  if (c.busy) return 'busy: the Watchdog is still on the previous turn';
  if (c.spentToday >= c.dailyBudgetUsd) return `budget: $${c.spentToday.toFixed(3)} spent today of $${c.dailyBudgetUsd.toFixed(2)}`;
  if (c.ticksLastHour >= c.maxTicksPerHour) return `limit: ${c.ticksLastHour} ticks in the last hour (at most ${c.maxTicksPerHour})`;
  return null;
}

/** Every action but inspect: the per-turn limit. */
export function actionRefusal(c: { used: number; max: number }): string | null {
  if (c.used >= c.max) return `This turn already took ${c.used} action${c.used === 1 ? '' : 's'}, the limit (${c.max}). Say what else you would do in your summary; a maintainer can act on it.`;
  return null;
}

export function noteRefusal(text: string): string | null {
  if (!text.trim()) return 'The text is empty.';
  const n = wordCount(text);
  if (n > NOTE_WORDS) return `The text has ${n} words; at most ${NOTE_WORDS}. Keep it to what to do next.`;
  return null;
}

type WorkerState = { status: string; dismissed: boolean } | null;
const ACTIVE = new Set(['starting', 'running', 'waiting']);

export function nudgeRefusal(w: WorkerState, nudgesToday: number): string | null {
  if (!w) return 'No such Worker. Use the ids from the snapshot.';
  if (w.dismissed) return 'That Worker was dismissed.';
  if (!ACTIVE.has(w.status)) return `That Worker is not active (${w.status}). A failed or stopped Worker can be restarted instead; a finished one needs nothing.`;
  if (nudgesToday >= NUDGES_PER_WORKER_PER_DAY) return `That Worker was already nudged ${nudgesToday} times today. Stop it, or notify its chat.`;
  return null;
}

export function stopRefusal(w: WorkerState): string | null {
  if (!w) return 'No such Worker. Use the ids from the snapshot.';
  if (w.dismissed || !ACTIVE.has(w.status)) return `That Worker is not running (${w.dismissed ? 'dismissed' : w.status}).`;
  return null;
}

export function restartRefusal(w: WorkerState, restartsToday: number): string | null {
  if (!w) return 'No such Worker. Use the ids from the snapshot.';
  if (w.dismissed) return 'That Worker was dismissed.';
  if (w.status !== 'error' && w.status !== 'stopped') return `Only a failed or stopped Worker can be restarted; this one is ${w.status}.`;
  if (restartsToday >= RESTARTS_PER_WORKER_PER_DAY) return `That Worker was already restarted ${restartsToday} times today. Notify its chat instead.`;
  return null;
}

export function notifyRefusal(chatExists: boolean, noticesToday: number): string | null {
  if (!chatExists) return 'No such chat. Use the chat ids from the snapshot.';
  if (noticesToday >= NOTICES_PER_CHAT_PER_DAY) return `That chat already got ${noticesToday} notices from you today.`;
  return null;
}

export function watchRefusal(open: number): string | null {
  return open >= MAX_OPEN_WATCHES ? `${open} watches are open, the limit. Resolve one first.` : null;
}

export function proposeRefusal(c: { maintainer: boolean; pending: number; changed: boolean }): string | null {
  if (!c.maintainer) return 'Changes are proposed only when a maintainer asks, in the Watchdog chat. Mention it in your summary instead.';
  if (c.pending >= MAX_PENDING_PROPOSALS) return `${c.pending} proposals are already waiting for a maintainer.`;
  if (!c.changed) return 'The proposal is the same as the current value.';
  return null;
}
