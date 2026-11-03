// What a restart of Crew cut off between a Router and its Workers (ADR 105), read off what is on
// disk: the Router's own log (each turn names the events it took, `batch`, and a turn a restart cut
// off is marked `interrupted`) and the Workers' records. Pure.
//
// The Router's queue lives in memory, and its cursor moves when a turn takes a user's message, so
// before this two things were lost silently: a user message whose Router turn was cut off before it
// dispatched anything, and a Worker's report that waited in the queue (or was in a cut-off turn).
// Both are handed to the Router again, marked as such. Anything a Worker was already dispatched for
// is not: that Worker's own interruption is reported instead, so no work is started twice.

import type { ChatMessage, Worker } from '../../shared/types';

/** Nothing older than this is handed over again: Workers that old are swept anyway (6 idle hours), and a request that old is stale. */
export const REDO_MAX_AGE_MS = 6 * 3600_000;

export interface RouterRedo {
  /** User messages and routine runs a cut-off Router turn took, with no Worker dispatched for them; oldest first as taken. */
  messages: string[];
  /** Workers whose latest report no Router turn finished taking: in a cut-off turn, or never read. */
  reports: { id: string; resumed: 'cut-off' | 'unread' }[];
}

export function routerRedo(o: {
  /** The Router's turns (its log), oldest first. */
  turns: Pick<ChatMessage, 'batch' | 'interrupted' | 'ts' | 'role'>[];
  /** The chat's Workers. */
  workers: Pick<Worker, 'id' | 'related' | 'report' | 'dismissedAt'>[];
  /** Workers this restart cut off: their interruption is reported on its own. */
  cutOff: Set<string>;
  /** When the user last stopped the chat: its Router's inbox was dropped on purpose then. */
  stoppedAt?: number;
  now: number;
}): RouterRedo {
  const turns = o.turns.filter((t) => t.role === 'bot' && t.batch?.length);
  const finished = turns.filter((t) => !t.interrupted);
  const takenByFinished = new Set(finished.flatMap((t) => t.batch || []));
  const dispatchedFor = new Set(o.workers.flatMap((w) => w.related || []));

  const messages: string[] = [];
  for (const t of turns) {
    if (!t.interrupted || o.now - t.ts > REDO_MAX_AGE_MS) continue;
    for (const id of t.batch || []) {
      // Message ids only: environment events (tg_, wa_) are stale after a restart, and Workers' reports are below.
      if (!id.startsWith('m_') || takenByFinished.has(id) || dispatchedFor.has(id) || messages.includes(id)) continue;
      messages.push(id);
    }
  }

  const reports: RouterRedo['reports'] = [];
  for (const w of o.workers) {
    const r = w.report;
    if (!r || w.dismissedAt || o.cutOff.has(w.id) || r.quiet) continue;
    if (o.now - r.at > REDO_MAX_AGE_MS || (o.stoppedAt !== undefined && r.at <= o.stoppedAt)) continue;
    const took = (t: (typeof turns)[number]) => t.ts >= r.at && !!t.batch?.includes(w.id);
    if (finished.some(took)) continue;
    reports.push({ id: w.id, resumed: turns.some((t) => t.interrupted && took(t)) ? 'cut-off' : 'unread' });
  }
  return { messages, reports };
}
