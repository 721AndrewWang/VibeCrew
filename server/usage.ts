// What each bot's turns cost, from the cost Claude Code reports per turn (0 under another
// provider, where Claude Code does not know the price). Summed on demand from the messages
// in memory, so a bot's monthly budget can be checked before a turn and shown in the UI.

import type { BotUsage, UsageSummary } from '../shared/types';
import { chats, messages } from './store';

const empty = (): BotUsage => ({ costUsd: 0, turns: 0, durationMs: 0 });

function startOfToday(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
function startOfMonth(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** botId → spend today and this calendar month. */
export function usageOf(now = new Date()): Record<string, UsageSummary> {
  const day = startOfToday(now);
  const month = startOfMonth(now);
  const out: Record<string, UsageSummary> = {};
  for (const chat of chats.all()) {
    for (const m of messages.sorted(chat.id)) {
      if (m.role !== 'bot' || !m.botId || !m.meta || m.ts < month) continue;
      out[m.botId] ??= { today: empty(), month: empty() };
      const u = out[m.botId];
      for (const bucket of m.ts >= day ? [u.today, u.month] : [u.month]) {
        bucket.costUsd += m.meta.costUsd || 0;
        bucket.turns += 1;
        bucket.durationMs += m.meta.durationMs || 0;
      }
    }
  }
  return out;
}

export function monthSpend(botId: string, now = new Date()): number {
  return usageOf(now)[botId]?.month.costUsd || 0;
}
