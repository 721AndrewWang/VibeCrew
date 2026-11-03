// The cost profile (ADR 108): per-role calls and prompt sizes on the bench's scenarios, and the
// Watchdog's tick fast path replayed over a run's Worker timeline.
import { describe, expect, it } from 'vitest';
import { type CostInputs, costTable, replayWatchdog, runCost, SCENARIOS, type StaticRole } from '../../server/bench/cost';
import { REDUCED } from '../../server/bench/index';
import type { RunResult } from '../../server/bench/sim';
import { estimateTokens } from '../../server/recall/spill';

const ROLES: StaticRole[] = ['router', 'router-recall', 'worker', 'worker-direct', 'worker-recall', 'speculative', 'watchdog', 'filter'];

function inputs(): CostInputs {
  const statics = Object.fromEntries(
    ROLES.map((r) => [
      r,
      {
        // The scripted model knows each agent by its system prompt, as with Crew's real ones.
        system: r.startsWith('router')
          ? `You are the coordinator of the group chat. Run at most 4 Workers at once. Reports go under Details. (${r})`
          : r === 'speculative'
            ? 'You are a speculative background run for Crew.'
            : `You are working as a Worker. (${r})`,
        tools: JSON.stringify([{ name: `mcp__crew__${r}`, description: 'x'.repeat(400) }]),
      },
    ]),
  ) as CostInputs['statics'];
  return { statics, claudeCodeTokens: 8000, watchdog: { everyMinutes: 15, stuckMinutes: 20, maxActionsPerTick: 3 } };
}

describe('the cost profile', () => {
  it('runs every scenario, deterministically, with the static text counted per call', async () => {
    const i = inputs();
    const a = await runCost(i, REDUCED);
    const b = await runCost(i, REDUCED);
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
    expect(a.result.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    const sa = a.result.scenarios.find((s) => s.id === 'super-agent')!;
    expect(sa.roles.router?.calls).toBeGreaterThan(0);
    expect(sa.roles.router?.staticTokens).toBe(estimateTokens(i.statics.router.system) + estimateTokens(i.statics.router.tools));
    expect(sa.roles.worker?.staticTokens).toBe(8000 + estimateTokens(i.statics['worker-direct'].system) + estimateTokens(i.statics['worker-direct'].tools));
    expect(sa.quality.completed).toBeGreaterThan(0);
    expect(a.result.scenarios.find((s) => s.id === 'speculative')?.roles.speculative?.calls).toBeGreaterThan(0);
    expect(a.result.scenarios.find((s) => s.id === 'recall')?.roles.router?.staticTokens).toBe(estimateTokens(i.statics['router-recall'].system) + estimateTokens(i.statics['router-recall'].tools));
    // The bench's Workers make progress every step: the Watchdog's fast path never calls its model.
    expect(sa.watchdog.ticks).toBeGreaterThan(0);
    expect(sa.watchdog.ran).toBe(0);
    expect(sa.watchdog.flaggedCallTokens).toBeGreaterThan(sa.watchdog.staticTokens);
    expect(costTable(a.result, b.result)).toContain('(+0%)');
  });

  it('replays the Watchdog: a Worker silent for longer than stuckMinutes costs one model turn per tick', () => {
    const MIN = 60_000;
    const run = {
      endMs: 60 * MIN,
      timeline: [
        { id: 'wk_1', title: 'T01: a', task: 'T01', createdAt: 0, activity: [MIN, 2 * MIN], status: 'running', turns: 1 },
        { id: 'wk_2', title: 'T02: b', task: 'T02', createdAt: 0, activity: [MIN, 50 * MIN], endedAt: 55 * MIN, status: 'done', turns: 1, report: 'Done.' },
      ],
    } as unknown as RunResult;
    const w = replayWatchdog(run, inputs());
    // Ticks at 15, 30, 45, 60 and 75 min: wk_1 is stuck from 30 on (last progress at 2 min).
    expect(w.ticks).toBe(5);
    expect(w.healthy).toBe(1);
    expect(w.ran).toBe(4);
  });
});
