// The hardening of Super-agent mode (ADR 105), where it is pure: summaries keep ids; what a restart
// hands the Router again, and how it reads; the Watchdog never restarts work someone else owns, and
// settles the ticks a restart cut off; a background command that outlived Crew is recognised; the
// Router's and the Watchdog's sessions are offered exactly their own tools.
import { describe, expect, it } from 'vitest';
import { NO_TOOL_SEARCH } from '../../server/agents/toolSearch';
import { etimeMs, startedWithJob } from '../../server/jobs/orphans';
import { type RouterEvent, renderBatch, resumedLine } from '../../server/layers/prompts';
import { REDO_MAX_AGE_MS, routerRedo } from '../../server/layers/recovery';
import { preview } from '../../server/orchestrator/chatLog';
import { budgetOf } from '../../server/recall/spill';
import { watchdogSessionConfig } from '../../server/watchdog';
import { CUT_BY_RESTART, restartConflict } from '../../server/watchdog/duplicates';
import { INTERRUPTED_QUESTION, INTERRUPTED_TICK, settleInterruptedTicks, watchesOnCutOff } from '../../server/watchdog/recovery';
import { watchdogTools } from '../../server/watchdog/tools';
import type { WatchdogTick, WatchdogWatch, Worker } from '../../shared/types';

const now = 1_800_000_000_000;

describe('summaries keep the ids they name', () => {
  it('drops Markdown marks but keeps underscores inside words', () => {
    expect(preview('Started **job_TMddPdPj** (_Demo build_) for wk_a1, see tg_x9 and `snake_case_name`')).toBe('Started job_TMddPdPj (Demo build) for wk_a1, see tg_x9 and snake_case_name');
    expect(preview('__bold__ and _italic_')).toBe('bold and italic');
  });
});

describe('what a restart hands the Router again', () => {
  const worker = (p: Partial<Worker> & { id: string }): Worker =>
    ({ chatId: 'c_1', botId: 'b_1', title: 'T', task: 'T', status: 'done', createdAt: now - 60_000, updatedAt: now - 10_000, projectId: 'p_1', turns: 1, costUsd: 0, related: [], ...p }) as Worker;
  const turn = (ts: number, batch: string[], interrupted?: boolean) => ({ role: 'bot' as const, ts, batch, interrupted });

  it('hands back a message a recent cut-off turn took, unless a Worker was dispatched for it or a later turn took it', () => {
    const r = routerRedo({
      turns: [
        turn(now - REDO_MAX_AGE_MS - 1, ['m_stale'], true),
        turn(now - 5000, ['m_taken']),
        turn(now - 3000, ['m_lost', 'm_dispatched', 'tg_env', 'm_again'], true),
        turn(now - 1000, ['m_again']),
      ],
      workers: [worker({ id: 'wk_1', related: ['m_dispatched', 'tg_1'] })],
      cutOff: new Set(),
      now,
    });
    expect(r.messages).toEqual(['m_lost']);
  });

  it('hands back a report no finished turn read, says whether a turn was cut off on it, and leaves the rest', () => {
    const r = routerRedo({
      turns: [turn(now - 9000, ['wk_read']), turn(now - 2000, ['wk_cut'], true)],
      workers: [
        worker({ id: 'wk_read', report: { at: now - 9500, status: 'done', text: 'ok' } }),
        // Reported again after the turn that read its earlier report.
        worker({ id: 'wk_reported_again', report: { at: now - 8000, status: 'done', text: 'ok' } }),
        worker({ id: 'wk_cut', report: { at: now - 2500, status: 'done', text: 'ok' } }),
        worker({ id: 'wk_unread', report: { at: now - 1000, status: 'error', text: 'boom' } }),
        worker({ id: 'wk_restart', report: { at: now, status: 'stopped', text: 'Interrupted' } }),
        worker({ id: 'wk_quiet', report: { at: now - 1000, status: 'stopped', text: 'stopped', quiet: true } }),
        worker({ id: 'wk_old', report: { at: now - REDO_MAX_AGE_MS - 1, status: 'done', text: 'ok' } }),
        worker({ id: 'wk_dismissed', dismissedAt: now - 10, report: { at: now - 1000, status: 'done', text: 'ok' } }),
        worker({ id: 'wk_before_stop', report: { at: now - 7000, status: 'done', text: 'ok' } }),
      ],
      cutOff: new Set(['wk_restart']),
      stoppedAt: now - 7000,
      now,
    });
    expect(r.reports).toEqual([
      { id: 'wk_cut', resumed: 'cut-off' },
      { id: 'wk_unread', resumed: 'unread' },
    ]);
  });

  it('tells the Router a re-handed event is one, inside the event, with and without the chain of recall', () => {
    const user: RouterEvent = { kind: 'user', id: 'm_1', at: now - 1000, seq: 4, text: 'Build a pricing page', resumed: 'cut-off' };
    const report: RouterEvent = { kind: 'worker', id: 'wk_1', at: now - 1000, bot: 'Chief', title: 'Footer', status: 'done', report: 'Done.', resumed: 'unread' };
    for (const text of [renderBatch([user, report], [], now), renderBatch([user, report], [], now, undefined, [], budgetOf(50))]) {
      const lines = text.split('\n');
      const at = (tag: string) => lines.findIndex((l) => l.startsWith(tag));
      expect(lines[at('<event id="m_1"') + 1]).toBe(resumedLine('cut-off')[0]);
      expect(lines[at('<event id="wk_1"') + 1]).toBe(resumedLine('unread')[0]);
      expect(text).toContain('Check list_workers before you dispatch anything for it');
    }
    expect(renderBatch([{ ...user, resumed: undefined }], [], now)).not.toContain('Crew restarted');
  });
});

describe('the Watchdog never restarts work someone else owns', () => {
  const w = (p: Partial<Worker> & { id: string }) => ({ chatId: 'c_1', status: 'error', createdAt: now - 60_000, updatedAt: now - 30_000, related: ['m_1', 'tg_1'], ...p }) as Worker;

  it('refuses a Worker a restart cut off, or the user stopped', () => {
    expect(restartConflict(w({ id: 'wk_1', status: 'stopped', detail: CUT_BY_RESTART }), [])).toMatch(/Router was told/);
    expect(restartConflict(w({ id: 'wk_1', status: 'stopped', detail: 'The user stopped the task' }), [])).toMatch(/user stopped/);
    expect(restartConflict(w({ id: 'wk_1', status: 'stopped', detail: 'The Watchdog stopped it: looping' }), [])).toBeNull();
  });

  it('refuses one the Router already replaced for the same request, not a sibling dispatched with it', () => {
    const failed = w({ id: 'wk_1', report: { at: now - 30_000, status: 'error', text: 'Overloaded' } });
    const sibling = w({ id: 'wk_2', status: 'running', createdAt: now - 60_000 });
    const again = w({ id: 'wk_3', status: 'running', createdAt: now - 10_000 });
    const elsewhere = w({ id: 'wk_4', chatId: 'c_2', status: 'running', createdAt: now - 10_000 });
    expect(restartConflict(failed, [failed, sibling, elsewhere])).toBeNull();
    expect(restartConflict(failed, [failed, sibling, again])).toMatch(/already dispatched wk_3/);
  });

  it('settles ticks a restart cut off so the next tick looks at the same window', () => {
    const t = (p: Partial<WatchdogTick>): WatchdogTick => ({ id: 'wt_1', at: now, kind: 'tick', outcome: 'ran', reason: 'flagged', flags: [], actions: 0, costUsd: 0, ...p });
    const settled = settleInterruptedTicks(
      [t({ id: 'wt_done', messageId: 'm_1' }), t({ id: 'wt_cut' }), t({ id: 'wt_q', kind: 'maintainer' }), t({ id: 'wt_skip', outcome: 'skipped' })],
      [{ tickId: 'wt_cut' }, { tickId: 'wt_cut', refused: 'limit' }],
    );
    expect(settled.map((x) => [x.id, x.outcome, x.reason, x.actions])).toEqual([
      ['wt_cut', 'skipped', INTERRUPTED_TICK, 1],
      ['wt_q', 'error', INTERRUPTED_QUESTION, 0],
    ]);
    const watch = (subject: string): WatchdogWatch => ({ id: `ww_${subject}`, subject, note: '', createdAt: now, nextAt: now, checks: 1, by: 'code' });
    const byId = (id: string) => (({ wk_cut: { status: 'stopped', detail: CUT_BY_RESTART }, wk_err: { status: 'error', detail: '529' } }) as Record<string, Pick<Worker, 'status' | 'detail'>>)[id];
    expect(watchesOnCutOff([watch('wk_cut'), watch('wk_err'), watch('deploy')], byId).map((x) => x.subject)).toEqual(['wk_cut']);
  });
});

describe('a background command that outlived Crew', () => {
  it("reads ps's elapsed time", () => {
    expect(etimeMs('00:07')).toBe(7_000);
    expect(etimeMs('12:34')).toBe(754_000);
    expect(etimeMs('01:02:03')).toBe(3_723_000);
    expect(etimeMs('2-01:00:00')).toBe(49 * 3_600_000);
    expect(etimeMs('soon')).toBeNull();
  });

  it('is the job only if it started when the job did (a process id can be handed out again)', () => {
    expect(startedWithJob(60_000, now - 61_000, now)).toBe(true);
    expect(startedWithJob(5_000, now - 61_000, now)).toBe(false);
  });
});

// That Crew's own MCP tools are never deferred (alwaysLoad) is checked against the real Claude Code:
// tests/integration/two-layer.test.ts and subscriptions.test.ts read the exact tool lists sent.
describe('the Router and the Watchdog are offered exactly their own tools', () => {
  it('turns off tool search for the Watchdog, whose only tools are its own', () => {
    const cfg = watchdogSessionConfig(watchdogTools(() => null, {} as never));
    expect(NO_TOOL_SEARCH).toEqual({ ENABLE_TOOL_SEARCH: 'false' });
    expect(cfg.env).toMatchObject(NO_TOOL_SEARCH);
  });
});
