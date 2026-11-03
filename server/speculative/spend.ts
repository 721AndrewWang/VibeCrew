// What speculative runs (ADR 008) cost today, read off their ledger and their Workers: for the
// daily budget gate, Settings, and the Watchdog, which shows it next to its own (ADR 011).

import type { SpeculativeSpend } from '../../shared/types';
import { projects, settings, speculationLog, workers } from '../store';
import { startOfDay } from '../time';

const IN_FLIGHT = new Set(['running', 'verifying']);

/** What today's runs cost: finished ones from their record, running ones from their Worker so far. */
export function spentToday(now = Date.now()): number {
  const from = startOfDay(now);
  return speculationLog.all().reduce((sum, s) => (s.at >= from && s.status !== 'skipped' ? sum + Math.max(s.costUsd, workers.get(s.workerId)?.costUsd || 0) : sum), 0);
}

/** Today's spend and runs in flight, or undefined while no project speculates and nothing ran today. */
export function speculativeSpend(now = Date.now()): SpeculativeSpend | undefined {
  const sa = settings.get().superAgent;
  const running = speculationLog.all().filter((s) => IN_FLIGHT.has(s.status)).length;
  const spent = spentToday(now);
  const anyProject = projects.all().some((p) => p.speculative?.enabled);
  if (!sa.enabled || (!anyProject && !running && !spent)) return undefined;
  return { running, spentTodayUsd: spent, dailyBudgetUsd: sa.speculative.dailyBudgetUsd };
}
