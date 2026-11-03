// Where each repository's polling stands (ADR 102), and which events of a poll are news. Pure.

import type { GhEvent } from './events';

/** Each poll reads back this far before the last one started: clock skew and slow polls lose nothing (seen ids keep it from repeating). */
export const OVERLAP_MS = 60_000;
/** Seen ids kept per repository. */
export const SEEN_MAX = 2000;

export interface GithubCursor {
  /** `<projectId>|<owner/repo>` */
  id: string;
  /** When the last poll started. */
  since: number;
  seen: string[];
}

/**
 * The events of one poll that are news, oldest first, and the cursor after it. With no cursor yet
 * the poll only sets one: history is not replayed as news.
 */
export function freshEvents(events: GhEvent[], cursor: GithubCursor | undefined, id: string, startedAt: number): { fresh: GhEvent[]; cursor: GithubCursor } {
  if (!cursor) return { fresh: [], cursor: { id, since: startedAt, seen: [] } };
  const from = cursor.since - OVERLAP_MS;
  const seen = new Set(cursor.seen);
  const fresh: GhEvent[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.at < from || seen.has(e.key)) continue;
    seen.add(e.key);
    fresh.push(e);
  }
  return { fresh, cursor: { id, since: Math.max(cursor.since, startedAt), seen: [...cursor.seen, ...fresh.map((e) => e.key)].slice(-SEEN_MAX) } };
}
