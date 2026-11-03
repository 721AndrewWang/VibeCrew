// The Watchdog after a restart of Crew (ADR 105). A tick that called the model is recorded as `ran`
// before its turn starts and gets its `messageId` when the turn ends; a restart in between left it
// `ran` for good, so the next tick's window (it starts at the last tick that looked) skipped
// whatever that tick was about to read, and a maintainer's question stayed unanswered with no word.
// Open watches on Workers a restart cut off were re-checked, and flagged, until they gave up.

import type { ChatMessage, WatchdogAction, WatchdogTick, WatchdogWatch, Worker } from '../../shared/types';
import { nextSeq } from '../layers/turn';
import { logger } from '../log';
import { messages, uid, WATCHDOG_LOG, watchdogActions, watchdogTicks, watchdogWatches, workers } from '../store';
import { CUT_BY_RESTART } from './duplicates';

const log = logger('watchdog');

export const INTERRUPTED_TICK = "interrupted: Crew restarted before the Watchdog's turn finished; the next tick looks at the same window";
export const INTERRUPTED_QUESTION = 'interrupted: Crew restarted before the Watchdog answered';

/**
 * Ticks a restart cut off, settled. Pure. A timer or manual tick becomes `skipped`, so the next one
 * looks from where it would have and nothing it was about to see is missed; a maintainer's turn
 * becomes `error`. Actions it took before the restart stay in the ledger and are counted.
 */
export function settleInterruptedTicks(ticks: WatchdogTick[], actions: Pick<WatchdogAction, 'tickId' | 'refused'>[]): WatchdogTick[] {
  return ticks
    .filter((t) => t.outcome === 'ran' && !t.messageId)
    .map((t) => ({
      ...t,
      outcome: t.kind === 'maintainer' ? ('error' as const) : ('skipped' as const),
      reason: t.kind === 'maintainer' ? INTERRUPTED_QUESTION : INTERRUPTED_TICK,
      actions: actions.filter((a) => a.tickId === t.id && !a.refused).length,
    }));
}

/** Open watches on Workers a restart cut off: their Router decides now, so the Watchdog stops re-checking them. Pure. */
export function watchesOnCutOff(watches: WatchdogWatch[], byId: (id: string) => Pick<Worker, 'detail' | 'status'> | undefined): WatchdogWatch[] {
  return watches.filter((x) => {
    if (x.resolvedAt || !x.subject.startsWith('wk_')) return false;
    const w = byId(x.subject);
    return w?.status === 'stopped' && w.detail === CUT_BY_RESTART;
  });
}

/** On start, before the timer: settles what a restart cut off. Writes nothing when there is nothing to settle. */
export function recoverWatchdog(now = Date.now()) {
  const settled = settleInterruptedTicks(watchdogTicks.all(), watchdogActions.all());
  for (const t of settled) watchdogTicks.append(t);
  if (settled.some((t) => t.kind === 'maintainer')) {
    const note: ChatMessage = {
      id: uid('m_'),
      chatId: WATCHDOG_LOG,
      seq: nextSeq(WATCHDOG_LOG),
      ts: now,
      role: 'system',
      text: 'Crew restarted before the Watchdog answered your last question. Nothing was lost but the answer; ask again to get one.',
    };
    messages.put(note);
  }
  for (const x of watchesOnCutOff(watchdogWatches.all(), (id) => workers.get(id))) {
    watchdogWatches.set({ ...x, resolvedAt: now, resolution: 'A restart of Crew cut the Worker off; its Router decides whether to resume it' });
  }
  if (settled.length) log.info(`${settled.length} tick${settled.length === 1 ? '' : 's'} a restart cut off settled`);
}
