// The Watchdog's settings (settings.superAgent.watchdog): defaults, and cleaning up what is stored.
// Pure, so the trigger settings can normalise it without pulling in the Watchdog.

import { DEFAULT_WATCHDOG } from '../../shared/defaults';
import type { WatchdogSettings } from '../../shared/types';
import { bounded, fields, modelName } from '../normalize';

/** Defined in shared/ for the settings forms; re-exported where the tests read it. */
export { DEFAULT_WATCHDOG };

export const WATCHDOG_BOUNDS = {
  everyMinutes: [1, 60],
  maxTicksPerHour: [1, 60],
  maxActionsPerTick: [0, 10],
  dailyBudgetUsd: [0, 100],
  stuckMinutes: [5, 240],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number, step: 1 | 0.01 = 1) => bounded(v, lo, hi, fallback, { step, blank: 'fallback' });

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeWatchdog(raw: unknown): WatchdogSettings {
  const r = fields<WatchdogSettings>(raw);
  const d = DEFAULT_WATCHDOG;
  const b = WATCHDOG_BOUNDS;
  return {
    enabled: r.enabled === true,
    model: modelName(r.model, d.model),
    everyMinutes: clamp(r.everyMinutes, b.everyMinutes, d.everyMinutes),
    maxTicksPerHour: clamp(r.maxTicksPerHour, b.maxTicksPerHour, d.maxTicksPerHour),
    maxActionsPerTick: clamp(r.maxActionsPerTick, b.maxActionsPerTick, d.maxActionsPerTick),
    dailyBudgetUsd: clamp(r.dailyBudgetUsd, b.dailyBudgetUsd, d.dailyBudgetUsd, 0.01),
    stuckMinutes: clamp(r.stuckMinutes, b.stuckMinutes, d.stuckMinutes),
  };
}

/** The timer's schedule: every N minutes, on the minute. */
export function cronExpr(everyMinutes: number): string {
  const n = Math.max(1, Math.min(60, Math.round(everyMinutes)));
  return n >= 60 ? '0 * * * *' : n === 1 ? '* * * * *' : `*/${n} * * * *`;
}
