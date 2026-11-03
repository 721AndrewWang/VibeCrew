// The Watchdog must never start work that is already being done (ADR 105). Its restart_worker gate
// in gates.ts checks the Worker alone; this one checks it against who else owns that work. Pure.

import type { Worker } from '../../shared/types';

/** The detail recoverWorkers gives a Worker a restart of Crew cut off. */
export const CUT_BY_RESTART = 'Crew restarted';

type W = Pick<Worker, 'id' | 'chatId' | 'status' | 'detail' | 'report' | 'updatedAt' | 'createdAt' | 'related' | 'dismissedAt'>;

/**
 * Why restarting `w` would duplicate or override someone else's decision, or null:
 * - a restart of Crew cut it off: its Router was told and decides whether to resume it;
 * - the user stopped it (or the whole chat);
 * - the Router already dispatched another Worker for the same request after this one ended.
 */
export function restartConflict(w: W, all: W[]): string | null {
  if (w.detail === CUT_BY_RESTART) return "A restart of Crew cut this Worker off; its Router was told and decides whether to resume it. Notify the chat if it needs the user's decision.";
  if (w.detail?.startsWith('The user stopped')) return 'The user stopped this Worker; only the user or the Router starts it again.';
  const ended = w.report?.at ?? w.updatedAt;
  const asks = new Set(w.related || []);
  const again = all.find((o) => o.id !== w.id && o.chatId === w.chatId && !o.dismissedAt && o.createdAt >= ended && (o.related || []).some((id) => asks.has(id)));
  if (again) return `The Router already dispatched ${again.id} for the same request after this one ended (it is ${again.status}); restarting this one would do the work twice.`;
  return null;
}
