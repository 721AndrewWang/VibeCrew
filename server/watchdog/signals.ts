// What can be read off a Worker's transcript without a model: when it last made progress, which
// tool calls it repeats, and whether an error is the kind a retry fixes. Pure.

import type { ChatMessage, ToolPart } from '../../shared/types';

/** A tool call in a few words: the tool and its most telling argument. */
export function callSignature(p: Pick<ToolPart, 'name' | 'input'>): string {
  const i = (p.input && typeof p.input === 'object' ? p.input : {}) as Record<string, unknown>;
  const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.prompt ?? '';
  const name = p.name.replace(/^mcp__crew__/, '');
  const text = typeof arg === 'string' ? arg.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return text ? `${name} ${text}` : name;
}

export interface Progress {
  /** The last moment something happened: a tool call starting or ending, text, the turn starting. */
  lastAt: number;
  /** The latest calls, oldest first, consecutive repeats collapsed ("Bash npm test ×6"). */
  recent: string[];
  /** How often the most repeated call appears among the latest ones, and which it is. */
  repeats: number;
  repeated?: string;
  /** Tool calls in the latest turn. */
  calls: number;
}

const RECENT = 20;

/** Progress over a Worker's log (its turns, oldest first). */
export function progressOf(turns: ChatMessage[], fallbackAt: number): Progress {
  const last = turns.at(-1);
  if (!last) return { lastAt: fallbackAt, recent: [], repeats: 0, calls: 0 };
  const tools = (last.parts || []).filter((p): p is ToolPart => p.type === 'tool');
  let lastAt = Math.max(last.ts, fallbackAt);
  for (const t of tools) lastAt = Math.max(lastAt, t.endedAt ?? t.startedAt ?? 0);
  const sigs = tools.slice(-RECENT).map(callSignature);
  const counts = new Map<string, number>();
  for (const s of sigs) counts.set(s, (counts.get(s) || 0) + 1);
  let repeats = 0;
  let repeated: string | undefined;
  for (const [s, n] of counts)
    if (n > repeats) {
      repeats = n;
      repeated = s;
    }
  const recent: string[] = [];
  for (let i = 0; i < sigs.length; ) {
    let j = i;
    while (j < sigs.length && sigs[j] === sigs[i]) j++;
    recent.push(j - i > 1 ? `${sigs[i]} ×${j - i}` : sigs[i]);
    i = j;
  }
  return { lastAt, recent: recent.slice(-8), repeats, repeated: repeats > 1 ? repeated : undefined, calls: tools.length };
}

/** The same call this many times among the latest ones reads as a loop. */
export const LOOP_REPEATS = 4;

const TRANSIENT = [
  /overloaded/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /\b(429|500|502|503|504|529)\b/,
  /timed? ?out|timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network/i,
  /No response after/i,
  /temporarily unavailable|try again later/i,
];

/** The error reads like something outside Crew that a retry later is likely to fix. */
export function isTransient(error: string | undefined): boolean {
  return !!error && TRANSIENT.some((re) => re.test(error));
}

export const WATCH_MAX_CHECKS = 8;
const WATCH_MAX_DELAY_MS = 2 * 3600_000;

/** When a watch is next due: `minutes`, doubling with every check, at most two hours. */
export function nextCheck(now: number, minutes: number, checks: number): number {
  return now + Math.min(WATCH_MAX_DELAY_MS, Math.max(1, minutes) * 60_000 * 2 ** Math.min(checks, 10));
}
