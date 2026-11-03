// The Watchdog (ADR 006), in demo mode: off by default and invisible; on, a tick looks at the
// Workers, redirects one that drifts, restarts one that failed on something transient and keeps
// watching it until it is healthy; a maintainer can ask it why something failed and accept or
// reject what it proposes; and its hard limits hold.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor } from '../helpers/server';

describe('the Watchdog in demo mode', () => {
  let crew: CrewServer;
  let group: any;

  const send = (text: string) => crew.api('POST', `/chats/${group.id}/messages`, { text });
  const overview = () => crew.api('GET', '/watchdog');
  const workersOf = async () => (await crew.api('GET', `/workers?chatId=${group.id}`)).items as any[];
  const workerWhere = (pred: (w: any) => boolean) => waitFor(async () => (await workersOf()).find(pred), 40_000);
  const idle = () => waitFor(async () => (await overview()).state === 'idle', 30_000);

  /** Asks for a tick once the Watchdog is idle, and waits for its turn (if it ran) to finish. */
  async function tickNow(): Promise<any> {
    await idle();
    const r = await crew.api('POST', '/watchdog/tick');
    expect(r.status).toBe(200);
    if (r.tick.outcome === 'ran')
      await waitFor(async () => {
        const o = await overview();
        const t = o.ticks.find((x: any) => x.id === r.tick.id);
        return o.state === 'idle' && t?.messageId ? t : null;
      }, 30_000);
    return r.tick;
  }

  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
  });
  afterAll(() => crew?.stop());

  it('is off by default: no timer, no folder, no turn, and the API says so', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.superAgent.watchdog).toEqual({ enabled: false, model: 'claude-sonnet-5', everyMinutes: 15, maxTicksPerHour: 4, maxActionsPerTick: 3, dailyBudgetUsd: 1, stuckMinutes: 20 });
    // The Super-agent alone does not switch it on.
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
    const o = await overview();
    expect(o).toMatchObject({ enabled: false, state: 'off', ticksLastHour: 0, spentTodayUsd: 0 });
    expect(o.nextTickAt).toBeUndefined();
    expect((await crew.api('POST', '/watchdog/tick')).status).toBe(409);
    expect((await crew.api('POST', '/watchdog/messages', { text: 'Hello?' })).status).toBe(409);
    expect(fs.existsSync(path.join(crew.home, 'watchdog'))).toBe(false);
    expect(fs.existsSync(path.join(crew.home, 'messages', 'watchdog.jsonl'))).toBe(false);
  });

  it('runs on a timer once on, and a tick asked for by hand calls its session', async () => {
    const s = await crew.api('PATCH', '/settings', { superAgent: { router: { enabled: true }, watchdog: { enabled: true } } });
    // A patch to the Watchdog keeps the rest of the Super-agent's settings.
    expect(s.settings.superAgent).toMatchObject({ enabled: true, router: { enabled: true }, watchdog: { enabled: true, everyMinutes: 15 } });
    const o = await overview();
    expect(o).toMatchObject({ enabled: true, state: 'idle' });
    expect(o.nextTickAt).toBeGreaterThan(Date.now());
    expect(o.nextTickAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);

    const t = await tickNow();
    expect(t).toMatchObject({ kind: 'manual', outcome: 'ran', reason: 'a maintainer asked for a tick' });
    const log = await crew.api('GET', '/watchdog/messages');
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toMatchObject({ role: 'bot', status: 'done', batch: [t.id] });
    expect(log.messages[0].text).toContain('nothing needs me');
  });

  it('stops a Worker that drifts from its task and redirects it; the Router hears it', async () => {
    await send('Build a slow drift page');
    const w = await workerWhere((x) => x.title.includes('drift') && x.status === 'running');
    const t = await tickNow();
    expect(t.outcome).toBe('ran');
    const o = await overview();
    const stop = o.actions.find((a: any) => a.kind === 'stop' && a.target === w.id);
    expect(stop).toMatchObject({ tickId: t.id, chatId: group.id });
    expect(stop.refused).toBeUndefined();
    expect(stop.text).toContain('Refocus on your task');
    // Stopped, then resumed with the note in a second turn, which finishes.
    const done = await workerWhere((x) => x.id === w.id && x.status === 'done' && x.turns === 2);
    expect(done.report.status).toBe('done');
    const log = await crew.api('GET', '/watchdog/messages');
    expect(log.messages.at(-1).parts.some((p: any) => p.type === 'tool' && p.name === 'mcp__crew_watchdog__stop_worker')).toBe(true);
    // The Router was told the Worker stopped, as for any stop.
    await waitFor(async () => {
      const msgs = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages;
      return msgs.some((m: any) => m.router && m.text.includes('ended (stopped)'));
    }, 30_000);
  });

  it('restarts a Worker that failed on something transient, and closes the watch once it is healthy', async () => {
    await send('Build a flaky page');
    const w = await workerWhere((x) => x.title.includes('flaky') && x.status === 'error');
    expect(w.detail).toMatch(/529 Overloaded/);
    const t = await tickNow();
    expect(t.flags).toContain(`failed-transient:${w.id}`);
    let o = await overview();
    // Crew opened the watch itself, before the model looked.
    expect(o.watches.find((x: any) => x.subject === w.id)).toMatchObject({ by: 'code' });
    expect(o.actions.find((a: any) => a.kind === 'restart' && a.target === w.id && !a.refused)).toBeTruthy();
    const ok = await workerWhere((x) => x.id === w.id && x.status === 'done');
    expect(ok.turns).toBe(2);
    // The next tick finds it healthy and resolves the watch in code; nothing is flagged.
    const t2 = await tickNow();
    o = await overview();
    expect(o.watches.find((x: any) => x.subject === w.id)).toMatchObject({ resolution: 'Healthy again: the Worker is done' });
    expect(t2.flags).toEqual([]);
  });

  it('holds the hourly tick limit', async () => {
    const o = await overview();
    expect(o.ticksLastHour).toBe(4);
    const t = await tickNow();
    expect(t).toMatchObject({ outcome: 'skipped' });
    expect(t.reason).toMatch(/^limit: 4 ticks in the last hour/);
  });

  it('answers a maintainer, and its proposals change nothing until accepted', async () => {
    const before = (await crew.api('GET', '/bootstrap')).settings.superAgent.policies;
    const asked = await crew.api('POST', '/watchdog/messages', { text: 'Why did the flaky Worker fail? Please propose a policy.' });
    expect(asked.status).toBe(200);
    const reply = await waitFor(async () => {
      const log = (await crew.api('GET', '/watchdog/messages')).messages;
      const r = log.find((m: any) => m.role === 'bot' && m.seq > asked.message.seq && m.status === 'done');
      return r ?? null;
    }, 30_000);
    expect(reply.text).toContain('Demo Watchdog');
    let o = await overview();
    const p = o.proposals.find((x: any) => x.status === 'pending');
    expect(p).toMatchObject({ target: 'policies', before });
    expect((await crew.api('GET', '/bootstrap')).settings.superAgent.policies).toBe(before);

    const accepted = await crew.api('POST', `/watchdog/proposals/${p.id}/accept`);
    expect(accepted.proposal.status).toBe('accepted');
    expect((await crew.api('GET', '/bootstrap')).settings.superAgent.policies).toBe(p.after);
    expect((await crew.api('POST', `/watchdog/proposals/${p.id}/accept`)).status).toBe(409);

    // A proposal whose target changed meanwhile is void.
    await crew.api('PATCH', '/settings', { superAgent: { policies: '- Stay quiet.' } });
    await idle();
    await crew.api('POST', '/watchdog/messages', { text: 'Propose a better policy, please.' });
    const p2 = await waitFor(async () => (await overview()).proposals.find((x: any) => x.status === 'pending'), 30_000);
    await crew.api('PATCH', '/settings', { superAgent: { policies: '- Changed by hand.' } });
    const stale = await crew.api('POST', `/watchdog/proposals/${p2.id}/accept`);
    expect(stale.status).toBe(409);
    o = await overview();
    expect(o.proposals.find((x: any) => x.id === p2.id).status).toBe('stale');
    expect((await crew.api('GET', '/bootstrap')).settings.superAgent.policies).toBe('- Changed by hand.');
  });

  it('refuses proposals during ticks, and stops at the daily budget', async () => {
    await idle();
    const spent = (await overview()).spentTodayUsd;
    expect(spent).toBeGreaterThan(0);
    await crew.api('PATCH', '/settings', { superAgent: { watchdog: { dailyBudgetUsd: 0.01, maxTicksPerHour: 60 } } });
    const t = await tickNow();
    expect(t.outcome).toBe('skipped');
    expect(t.reason).toMatch(/^budget/);
    const r = await crew.api('POST', '/watchdog/messages', { text: 'Still there?' });
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/budget/);
  });

  it('switches off cleanly', async () => {
    await crew.api('PATCH', '/settings', { superAgent: { watchdog: { enabled: false } } });
    const o = await overview();
    expect(o).toMatchObject({ enabled: false, state: 'off' });
    expect(o.nextTickAt).toBeUndefined();
    expect((await crew.api('POST', '/watchdog/tick')).status).toBe(409);
  });
});
