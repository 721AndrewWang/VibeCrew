import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared/types';

const list: ChatMessage[] = [];
/** Two-layer mode's logs (the chat's Router turns and a Worker's), and a full-duplex sub-task's. */
const logs: Record<string, ChatMessage[]> = { rt_c1: [], wk_1: [], job_1: [], job_2: [] };
vi.mock('../../server/store', () => ({
  chats: { all: () => [{ id: 'c1' }] },
  workers: { all: () => [{ id: 'wk_1' }] },
  jobs: { all: () => [{ id: 'job_1', kind: 'task' }, { id: 'job_2', kind: 'command' }] },
  routerLogId: (id: string) => `rt_${id}`,
  messages: { sorted: (id: string) => (id === 'c1' ? list : logs[id] || []) },
}));

const { shareOfTurn, usageOf } = await import('../../server/usage');

const now = new Date(2026, 9, 8, 12);
let seq = 0;
const turn = (meta: ChatMessage['meta']): ChatMessage => {
  const m = { id: `m${++seq}`, chatId: 'c1', seq, ts: now.getTime() - 1000 + seq, role: 'bot', botId: 'b1', text: '', meta } as ChatMessage;
  list.push(m);
  return m;
};
const tokens = (cacheRead: number) => ({ input: 10, cacheRead, cacheWrite: 100, output: 5 });

describe('usage', () => {
  it('reads turns saved with the running total as their cost, and new turns by their own share', () => {
    // Saved before the fix: the session's running totals.
    turn({ costUsd: 0.1, trace: { sessionId: 's1', cwd: '/', from: 0, to: 0 } });
    turn({ costUsd: 0.25, trace: { sessionId: 's1', cwd: '/', from: 0, to: 0 } });
    // The first turn after the fix in the same session: its cost is the difference; tokens unknown.
    const a = turn({ sessionCostUsd: 0.4, sessionTokens: tokens(9_000), sessionId: 's1' });
    shareOfTurn(a);
    expect(a.meta!.costUsd).toBeCloseTo(0.15, 5);
    expect(a.meta!.tokens).toBeUndefined();
    const b = turn({ sessionCostUsd: 0.5, sessionTokens: tokens(15_000), sessionId: 's1' });
    shareOfTurn(b);
    expect(b.meta!.costUsd).toBeCloseTo(0.1, 5);
    expect(b.meta!.tokens).toEqual({ input: 0, cacheRead: 6_000, cacheWrite: 0, output: 0 });
    // A new session starts from nothing.
    const c = turn({ sessionCostUsd: 0.05, sessionTokens: tokens(4_000), sessionId: 's2' });
    shareOfTurn(c);
    expect(c.meta!.costUsd).toBeCloseTo(0.05, 5);
    expect(c.meta!.tokens).toEqual(tokens(4_000));

    const u = usageOf(now).b1.month;
    expect(u.turns).toBe(5);
    expect(u.costUsd).toBeCloseTo(0.55, 5);
    expect(u.tokenTurns).toBe(2);
    expect(u.tokens.cacheRead).toBe(10_000);
    expect(u.peak).toEqual({ chatId: 'c1', messageId: b.id, cacheRead: 6_000 });
  });

  it('counts a running total that went down (a reset session) whole', () => {
    const d = turn({ sessionCostUsd: 0.02, sessionTokens: tokens(1_000), sessionId: 's2' });
    shareOfTurn(d);
    expect(d.meta!.costUsd).toBeCloseTo(0.02, 5);
    expect(d.meta!.tokens).toEqual(tokens(1_000));
  });

  it("counts a Router's and a Worker's turns toward the bot they ran as", () => {
    const before = usageOf(now).b1.month;
    const log = (logId: string, costUsd: number) =>
      logs[logId].push({ id: `${logId}-${++seq}`, chatId: logId, seq, ts: now.getTime() - 500, role: 'bot', botId: 'b1', text: '', meta: { costUsd, sessionCostUsd: costUsd, sessionId: logId } });
    log('rt_c1', 0.01);
    log('wk_1', 0.2);
    const after = usageOf(now).b1.month;
    expect(after.turns).toBe(before.turns + 2);
    expect(after.costUsd).toBeCloseTo(before.costUsd + 0.21, 5);
  });

  it("counts a background sub-task's turn toward its bot", () => {
    const before = usageOf(now).b1.month;
    logs.job_1.push({ id: `job_1-${++seq}`, chatId: 'job_1', seq, ts: now.getTime() - 500, role: 'bot', botId: 'b1', text: '', meta: { costUsd: 0.05, sessionCostUsd: 0.05, sessionId: 'job_1' } });
    const after = usageOf(now).b1.month;
    expect(after.turns).toBe(before.turns + 1);
    expect(after.costUsd).toBeCloseTo(before.costUsd + 0.05, 5);
  });
});
