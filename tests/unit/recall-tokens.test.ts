// Injected tokens per turn before/after Inline & Spill on a fixed fixture (ADR 005). The numbers
// are logged so a change to the budgets shows what it costs; the asserts pin the direction.
import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, contextDelta } from '../../server/agents/prompts';
import { renderBatch } from '../../server/layers/prompts';
import { budgetOf, estimateTokens } from '../../server/recall/spill';
import { BATCH, BATCH_WORKERS, CONTEXT_FIRST, CONTEXT_NEXT, MESSAGES, NAMES } from '../fixtures/recallFixture';

const budget = budgetOf(50);
const chat = { kind: 'group', title: 'Web team' } as any;
const NOW = 1_700_000_000_000 + 60_000;

function measure() {
  const turn = (recall?: typeof budget) => buildTurnPrompt({ bot: { name: 'Probe' } as any, chat, unseen: MESSAGES, names: NAMES, context: [], trigger: { type: 'mention', by: 'b_chief' }, recall });
  const recap = (recall?: typeof budget) =>
    buildTurnPrompt({ bot: { id: 'b_chief', name: 'Chief' } as any, chat, unseen: MESSAGES, names: NAMES, context: [], trigger: { type: 'user' }, recap: { tokens: 80_000 }, recall });
  const batch = (recall?: typeof budget) => renderBatch(BATCH, BATCH_WORKERS, NOW, undefined, recall);
  const env = (spill?: string) => contextDelta(CONTEXT_FIRST, CONTEXT_NEXT, spill).join('\n');
  const rows = {
    'group-chat turn': [turn(), turn(budget)],
    'session recap': [recap(), recap(budget)],
    'Router batch': [batch(), batch(budget)],
    'environment, later turn': [env(), env('env')],
  };
  return Object.fromEntries(Object.entries(rows).map(([k, [off, on]]) => [k, { off: estimateTokens(off), on: estimateTokens(on), offText: off, onText: on }]));
}

describe('injected tokens on the fixture', () => {
  const m = measure();

  it('logs before/after per prompt', () => {
    const table = Object.entries(m).map(([k, v]) => `${k.padEnd(26)} off ~${String(v.off).padStart(5)}  on ~${String(v.on).padStart(5)}  (${Math.round((100 * (v.on - v.off)) / v.off)}%)`);
    console.info(`Inline & Spill, injected tokens (estimate):\n${table.join('\n')}`);
    expect(table).toHaveLength(4);
  });

  it('makes the group-chat turn at least 20% smaller, and the batch and the recap no bigger', () => {
    expect(m['group-chat turn'].on).toBeLessThan(m['group-chat turn'].off * 0.8);
    // The user's words are kept (about as much as before); the Worker reports are what shrink.
    expect(m['Router batch'].on).toBeLessThan(m['Router batch'].off);
    expect(m['session recap'].on).toBeLessThan(m['session recap'].off * 0.8);
  });

  it('keeps every spilled text followable: each cut names its handle', () => {
    for (const v of Object.values(m)) {
      for (const cut of v.onText.match(/… \(\+\d+ words?[^)]*\)/g) || []) expect(cut).toMatch(/recall id=\S+/);
    }
    expect(m['environment, later turn'].onText).toContain('recall id=env');
  });
});
