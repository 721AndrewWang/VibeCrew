// What each bot's turns cost and how much they read, summed on demand from the messages in memory,
// so a bot's monthly budget can be checked before a turn and shown in the UI.
//
// Claude Code reports cost and tokens as running totals for the whole session (a resumed session
// continues from the total its transcript saved). A turn's own share is its total minus the one
// after the previous turn of the same session. Turns saved before Crew kept the totals apart stored
// the running total as their cost; they are told apart by the missing `sessionCostUsd`.

import type { BotUsage, ChatMessage, TurnTokens, UsageSummary } from '../shared/types';
import { chats, messages } from './store';

const noTokens = (): TurnTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const empty = (): BotUsage => ({ costUsd: 0, turns: 0, durationMs: 0, tokens: noTokens(), tokenTurns: 0 });

/** A running total minus the previous one; a total that went down (a reset session) counts whole. */
const less = (cur: number, prev: number) => (cur >= prev ? cur - prev : cur);

function lessTokens(cur: TurnTokens, prev: TurnTokens | undefined): TurnTokens {
  if (!prev) return cur;
  // Any total that went down means the session's totals were reset: the turn counts whole.
  if (cur.input < prev.input || cur.cacheRead < prev.cacheRead || cur.cacheWrite < prev.cacheWrite || cur.output < prev.output) return cur;
  return { input: less(cur.input, prev.input), cacheRead: less(cur.cacheRead, prev.cacheRead), cacheWrite: less(cur.cacheWrite, prev.cacheWrite), output: less(cur.output, prev.output) };
}

/** The bot's previous turn in the same session, before this one. */
function previousTurn(msg: ChatMessage, sessionId: string): ChatMessage | undefined {
  const list = messages.sorted(msg.chatId);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.seq >= msg.seq || m.role !== 'bot' || m.botId !== msg.botId) continue;
    if ((m.meta?.sessionId ?? m.meta?.trace?.sessionId) === sessionId) return m;
  }
  return undefined;
}

/** Sets the turn's own cost and tokens from the session totals it ended with. */
export function shareOfTurn(msg: ChatMessage) {
  const meta = msg.meta;
  if (!meta) return;
  const sid = meta.sessionId ?? meta.trace?.sessionId;
  const prev = sid ? previousTurn(msg, sid) : undefined;
  const prevCost = prev?.meta ? (prev.meta.sessionCostUsd ?? prev.meta.costUsd ?? 0) : 0;
  meta.costUsd = less(meta.sessionCostUsd ?? 0, prevCost);
  // A session that began before Crew kept token totals: this turn's share cannot be told.
  if (meta.sessionTokens && (!prev || prev.meta?.sessionTokens)) meta.tokens = lessTokens(meta.sessionTokens, prev?.meta?.sessionTokens);
}

function startOfToday(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
function startOfMonth(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** botId → spend and tokens today and this calendar month. */
export function usageOf(now = new Date()): Record<string, UsageSummary> {
  const day = startOfToday(now);
  const month = startOfMonth(now);
  const out: Record<string, UsageSummary> = {};
  for (const chat of chats.all()) {
    // Running totals seen so far per session, for turns saved with the total as their cost.
    const legacyTotal = new Map<string, number>();
    for (const m of messages.sorted(chat.id)) {
      if (m.role !== 'bot' || !m.botId || !m.meta) continue;
      const sid = m.meta.sessionId ?? m.meta.trace?.sessionId;
      let cost = m.meta.costUsd || 0;
      if (m.meta.sessionCostUsd === undefined && sid) {
        cost = less(cost, legacyTotal.get(sid) ?? 0);
        legacyTotal.set(sid, m.meta.costUsd || 0);
      } else if (sid && m.meta.sessionCostUsd !== undefined) legacyTotal.set(sid, m.meta.sessionCostUsd);
      if (m.ts < month) continue;
      out[m.botId] ??= { today: empty(), month: empty() };
      const u = out[m.botId];
      for (const bucket of m.ts >= day ? [u.today, u.month] : [u.month]) {
        bucket.costUsd += cost;
        bucket.turns += 1;
        bucket.durationMs += m.meta.durationMs || 0;
        const t = m.meta.tokens;
        if (!t) continue;
        bucket.tokenTurns += 1;
        bucket.tokens.input += t.input;
        bucket.tokens.cacheRead += t.cacheRead;
        bucket.tokens.cacheWrite += t.cacheWrite;
        bucket.tokens.output += t.output;
        if (!bucket.peak || t.cacheRead > bucket.peak.cacheRead) bucket.peak = { chatId: chat.id, messageId: m.id, cacheRead: t.cacheRead };
      }
    }
  }
  return out;
}

export function monthSpend(botId: string, now = new Date()): number {
  return usageOf(now)[botId]?.month.costUsd || 0;
}
