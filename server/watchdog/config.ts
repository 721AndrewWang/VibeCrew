// The Watchdog's settings (settings.superAgent.watchdog): defaults, and cleaning up what is stored.
// Pure, so the trigger settings can normalise it without pulling in the Watchdog.

import type { WatchdogSettings } from '../../shared/types';

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: false,
  // Judging progress from a compact snapshot: a lighter model is enough.
  model: 'claude-sonnet-5',
  everyMinutes: 15,
  maxTicksPerHour: 4,
  maxActionsPerTick: 3,
  dailyBudgetUsd: 1,
  stuckMinutes: 20,
};

export const WATCHDOG_BOUNDS = {
  everyMinutes: [1, 60],
  maxTicksPerHour: [1, 60],
  maxActionsPerTick: [0, 10],
  dailyBudgetUsd: [0, 100],
  stuckMinutes: [5, 240],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number, round = true) => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, round ? Math.round(n) : Math.round(n * 100) / 100));
};

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeWatchdog(raw: unknown): WatchdogSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WatchdogSettings>;
  const d = DEFAULT_WATCHDOG;
  const b = WATCHDOG_BOUNDS;
  return {
    enabled: r.enabled === true,
    model: typeof r.model === 'string' ? r.model.trim().slice(0, 200) : d.model,
    everyMinutes: clamp(r.everyMinutes, b.everyMinutes, d.everyMinutes),
    maxTicksPerHour: clamp(r.maxTicksPerHour, b.maxTicksPerHour, d.maxTicksPerHour),
    maxActionsPerTick: clamp(r.maxActionsPerTick, b.maxActionsPerTick, d.maxActionsPerTick),
    dailyBudgetUsd: clamp(r.dailyBudgetUsd, b.dailyBudgetUsd, d.dailyBudgetUsd, false),
    stuckMinutes: clamp(r.stuckMinutes, b.stuckMinutes, d.stuckMinutes),
  };
}

/** The timer's schedule: every N minutes, on the minute. */
export function cronExpr(everyMinutes: number): string {
  const n = Math.max(1, Math.min(60, Math.round(everyMinutes)));
  return n >= 60 ? '0 * * * *' : n === 1 ? '* * * * *' : `*/${n} * * * *`;
}
