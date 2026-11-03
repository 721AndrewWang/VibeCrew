// The ablation bench's parts (ADR 101): seeded workload, virtual clock, scripted model, metrics,
// report. The whole reduced run is in tests/integration/bench.test.ts.
import { describe, expect, it } from 'vitest';
import { parseBenchArgs } from '../../server/bench/cli';
import { BENCH_EPOCH, VirtualClock } from '../../server/bench/clock';
import { REDUCED, runBench } from '../../server/bench/index';
import { batchByRate, directRoutingEffect, percentile, summarize } from '../../server/bench/metrics';
import { callLatency, DEFAULT_LATENCY, type Message, type ModelRequest, mockReply } from '../../server/bench/model';
import { intentOf, parseEvents, parseQueue, parseWorkers, queueBefore, queueText, scriptedPolicy, TOOLS } from '../../server/bench/policies';
import { filterSystem, leadSystem, leadTurnPrompt, workerSystem } from '../../server/bench/prompts';
import { barChart, esc, renderReport, ticks } from '../../server/bench/report';
import { rng } from '../../server/bench/rng';
import { simulate } from '../../server/bench/sim';
import { composition, generateWorkload } from '../../server/bench/workload';
import { renderBatch, routerSystemPrompt } from '../../server/layers/prompts';

describe('seeded generator', () => {
  it('gives the same sequence for the same seed, and another for another seed', () => {
    const a = rng(42);
    const b = rng(42);
    const c = rng(43);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
    for (let i = 0; i < 200; i++) {
      const n = a.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
    expect(a.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('virtual clock', () => {
  it('runs timers in time order, then in the order they were set, with promises settled in between', async () => {
    const clock = new VirtualClock();
    const seen: string[] = [];
    clock.after(20, () => seen.push('b'));
    clock.after(10, () => seen.push('a'));
    clock.after(20, () => seen.push('c'));
    void (async () => {
      await clock.sleep(15);
      seen.push(`slept@${clock.now - BENCH_EPOCH}`);
      await clock.sleep(10);
      seen.push(`slept@${clock.now - BENCH_EPOCH}`);
    })();
    await clock.run();
    expect(seen).toEqual(['a', 'slept@15', 'b', 'c', 'slept@25']);
    expect(clock.pending).toBe(0);
  });

  it('does not move while tracked outside work is in flight', async () => {
    const clock = new VirtualClock();
    const seen: number[] = [];
    clock.after(5, () => {
      void clock.track(new Promise((r) => setTimeout(r, 20))).then(() => {
        seen.push(clock.now - BENCH_EPOCH);
        clock.after(1, () => seen.push(clock.now - BENCH_EPOCH));
      });
    });
    clock.after(6, () => seen.push(clock.now - BENCH_EPOCH));
    await clock.run();
    // The external call settles at virtual 5, before the timer at 6.
    expect(seen).toEqual([5, 6, 6]);
  });
});

describe('workload', () => {
  it('splits 300 events into 20 requests, follow-ups, stops, CI results and chatter', () => {
    const w = generateWorkload();
    expect(w.counts).toEqual({ request: 20, 'follow-up': 40, stop: 4, ci: 90, chatter: 146 });
    expect(w.events).toHaveLength(300);
    const byKind = (k: string) => w.events.filter((e) => e.kind === k).length;
    expect(byKind('request')).toBe(20);
    expect(byKind('ci')).toBe(90);
    expect(w.events.map((e) => e.id)).toEqual(w.events.map((_, i) => `msg_${i + 1}`));
    for (let i = 1; i < w.events.length; i++) expect(w.events[i].at).toBeGreaterThanOrEqual(w.events[i - 1].at);
  });

  it('is the same for a seed and changes with it', () => {
    expect(generateWorkload({ seed: 3 })).toEqual(generateWorkload({ seed: 3 }));
    expect(generateWorkload({ seed: 3 }).events.map((e) => e.at)).not.toEqual(generateWorkload({ seed: 4 }).events.map((e) => e.at));
  });

  it('scales every time and every amount of work by timeScale', () => {
    const one = generateWorkload({ timeScale: 1 });
    const half = generateWorkload({ timeScale: 0.5 });
    expect(half.events.map((e) => e.kind)).toEqual(one.events.map((e) => e.kind));
    half.events.forEach((e, i) => {
      expect(Math.abs(e.at - one.events[i].at / 2)).toBeLessThanOrEqual(1);
      if (e.work !== undefined) expect(Math.abs(e.work - one.events[i].work! / 2)).toBeLessThanOrEqual(1);
    });
  });

  it('keeps follow-ups and stops after their request, and stopped tasks without follow-ups', () => {
    const w = generateWorkload({ seed: 11 });
    const requested = new Map(w.events.filter((e) => e.kind === 'request').map((e) => [e.task, e.at]));
    const stopped = new Set(w.events.filter((e) => e.kind === 'stop').map((e) => e.task));
    for (const e of w.events.filter((x) => x.kind === 'follow-up' || x.kind === 'stop')) expect(e.at).toBeGreaterThan(requested.get(e.task)!);
    for (const e of w.events.filter((x) => x.kind === 'follow-up')) expect(stopped.has(e.task)).toBe(false);
    // The scripted model reads the user's intent from these shapes.
    for (const e of w.events.filter((x) => x.kind !== 'ci')) expect(intentOf(e.text).kind).toBe(e.kind === 'chatter' ? 'chatter' : e.kind);
  });

  it('shrinks the mix for a small stream', () => {
    expect(composition(60, 5)).toEqual({ request: 5, 'follow-up': 9, stop: 1, ci: 18, chatter: 27 });
    const c = composition(10, 20);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(10);
  });
});

describe('model plumbing', () => {
  it('prices a call by what it reads, what is new and what it writes, per role', () => {
    const worker = callLatency(DEFAULT_LATENCY, 'worker', { read: 10_000, fresh: 400, out: 60 });
    expect(worker).toBe(Math.round(700 + 100 + 100 + 1500));
    expect(callLatency(DEFAULT_LATENCY, 'router', { read: 10_000, fresh: 400, out: 60 })).toBe(Math.round(worker * 0.6));
  });

  it('adapts a mock provider request to the policy', () => {
    const reply = mockReply(() => ({ text: 'ok' }));
    expect(reply({ tools: [], body: { system: [{ type: 'text', text: 'x' }], messages: [] } })).toEqual({ text: 'ok' });
  });
});

const user = (content: string): Message => ({ role: 'user', content });
const req = (system: string, messages: Message[], tools: string[] = []): ModelRequest => ({ model: 'm', system, messages, tools });
const ROUTER = routerSystemPrompt({ lead: 'Chief', leadTitle: 'Tech lead', chat: 'Bench', role: '', team: [{ name: 'Chief (you)', title: 'Tech lead', profile: '' }], maxWorkers: 2 });
const userEvent = (id: string, seq: number, text: string) => ({ kind: 'user' as const, id, at: BENCH_EPOCH, seq, text });

describe('scripted model', () => {
  it('reads intents, and writes and reads back the queue', () => {
    expect(intentOf('Please build the 404 page (task T03).')).toEqual({ kind: 'request', task: 'T03' });
    expect(intentOf('For T03: add a test for it.')).toEqual({ kind: 'follow-up', task: 'T03' });
    expect(intentOf('Stop T03, we do not need it anymore.')).toEqual({ kind: 'stop', task: 'T03' });
    expect(intentOf('Thanks!')).toEqual({ kind: 'chatter' });
    const q = [
      { task: 'T02', ids: ['msg_4', 'msg_9'] },
      { task: 'T05', ids: ['msg_12'] },
    ];
    expect(parseQueue(`${queueText(q)} Started T01.`)).toEqual(q);
    expect(parseQueue('Started T01.')).toBeNull();
    expect(queueText([])).toBe('');
  });

  it("parses Crew's own batch prompt: Workers and events", () => {
    const batch = renderBatch(
      [
        userEvent('msg_3', 3, 'Please build the 404 page (task T03).'),
        { kind: 'worker', id: 'wk_1', at: BENCH_EPOCH, bot: 'Chief', title: 'T01: Please build', status: 'done', report: 'Report: done.' },
      ],
      [{ id: 'wk_1', bot: 'Chief', status: 'done', title: 'T01: Please build' }],
      BENCH_EPOCH,
    );
    expect(parseWorkers(batch).get('T01')).toEqual({ id: 'wk_1', status: 'done' });
    expect(parseEvents(batch).map((e) => [e.id, e.kind, e.status ?? ''])).toEqual([
      ['msg_3', 'user', ''],
      ['wk_1', 'worker', 'done'],
    ]);
  });

  it('as the Router: dispatches within the limit, queues the rest, and says so in its reply', () => {
    const batch = renderBatch(
      [userEvent('msg_1', 1, 'Please build A (task T01).'), userEvent('msg_2', 2, 'Please build B (task T02).'), userEvent('msg_3', 3, 'Please build C (task T03).')],
      [],
      BENCH_EPOCH,
    );
    const messages: Message[] = [user(batch)];
    const first = scriptedPolicy(req(ROUTER, messages));
    expect('tool' in first && first.tool.name).toBe(TOOLS.dispatch);
    expect('tool' in first && first.tool.input.task).toContain('msg_1');
    // Play the turn out: every dispatch succeeds.
    for (let i = 0; i < 5; i++) {
      const r = scriptedPolicy(req(ROUTER, messages));
      if ('text' in r) break;
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', ...r.tool }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: r.tool.id, content: 'Started.' }] });
    }
    const calls = messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_use')));
    expect(calls.map((c) => (c.type === 'tool_use' ? c.name : ''))).toEqual([TOOLS.dispatch, TOOLS.dispatch, TOOLS.reply]);
    const reply = calls[2].type === 'tool_use' ? String(calls[2].input.text) : '';
    expect(reply).toContain('Queued: T03 [msg_3].');
    expect(reply).toContain('Started T01 and T02.');
    // The next turn knows the queue from that reply.
    expect(queueBefore([...messages, user('next')], messages.length, TOOLS.reply)).toEqual([{ task: 'T03', ids: ['msg_3'] }]);
  });

  it('as the Router: stops first, passes follow-ups on, and starts nothing from environment events', () => {
    const lines = [
      { id: 'wk_1', bot: 'Chief', status: 'running', title: 'T01: A' },
      { id: 'wk_2', bot: 'Chief', status: 'running', title: 'T02: B' },
    ];
    const batch = renderBatch([userEvent('msg_5', 5, 'For T01: add a test for it.'), userEvent('msg_6', 6, 'Stop T02, we do not need it anymore.')], lines, BENCH_EPOCH);
    const r1 = scriptedPolicy(req(ROUTER, [user(batch)]));
    expect('tool' in r1 && [r1.tool.name, r1.tool.input.id]).toEqual([TOOLS.stopWorker, 'wk_2']);
    const env = renderBatch([{ kind: 'environment', id: 'tg_1', at: BENCH_EPOCH, source: 'ci', summary: 'CI on crew/T01: 1 failed', reason: 'policy' }], lines, BENCH_EPOCH);
    expect(scriptedPolicy(req(ROUTER, [user(env)]))).toEqual({ text: 'Nothing needs the user.' });
  });

  it('as a Worker: works until the tool says the task is complete, then reports', () => {
    const sys = workerSystem(true);
    const messages: Message[] = [user('Your task from Chief (the chat\'s Router): "T04: thing"\n\nT04: build it (from msg_9).')];
    const r = scriptedPolicy(req(sys, messages));
    expect('tool' in r && r.tool).toMatchObject({ name: TOOLS.work, input: { task: 'T04' } });
    if (!('tool' in r)) return;
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', ...r.tool }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.tool.id, content: 'T04 is complete.' }] });
    expect(scriptedPolicy(req(sys, messages))).toMatchObject({ text: expect.stringContaining('T04 is done') });
  });

  it('as the classic lead: does the work itself with a neutral prompt, delegates with a delegate-first one', () => {
    const prompt = leadTurnPrompt([{ who: 'User', seq: 7, text: 'Please build A (task T01).' }]);
    expect(scriptedPolicy(req(leadSystem(false), [user(prompt)]))).toMatchObject({ tool: { name: TOOLS.work, input: { task: 'T01' } } });
    expect(scriptedPolicy(req(leadSystem(true), [user(prompt)]))).toMatchObject({ tool: { name: TOOLS.start, input: { title: 'T01', task: expect.stringContaining('msg_7') } } });
  });

  it('as the event filter: acts on a failing branch once per batch, never on a passing run', () => {
    const prompt = [
      '<event id="tg_1" source="ci" when="1s ago">',
      'CI on crew/T01: 1 failed (x).',
      '</event>',
      '<event id="tg_2" source="ci" when="1s ago">',
      'CI on crew/T01: 2 failed (y).',
      '</event>',
    ].join('\n');
    const r = scriptedPolicy(req(filterSystem(), [user(prompt)]));
    expect('text' in r && JSON.parse(r.text).decisions.map((d: { act: boolean }) => d.act)).toEqual([true, false]);
  });
});

describe('metrics', () => {
  it('interpolates percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([4, 1, 3, 2, 5], 100)).toBe(5);
  });

  it('bins Router turns by arrival rate', () => {
    const turns = [
      { at: 0, size: 1, explicit: true, ratePerMin: 0.5 },
      { at: 1, size: 1, explicit: true, ratePerMin: 0.6 },
      { at: 2, size: 4, explicit: true, ratePerMin: 4 },
    ];
    const bins = batchByRate(turns, 4);
    expect(bins[0]).toMatchObject({ meanBatch: 1, turns: 2 });
    expect(bins[bins.length - 1]).toMatchObject({ meanBatch: 4, turns: 1 });
    expect(batchByRate([])).toEqual([]);
  });
});

describe('report', () => {
  it('escapes text, picks round ticks, and draws bars from zero', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(ticks(9.5, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    const svg = barChart('T', 'min', [
      { config: 'super-agent', label: '(a)', value: 10 },
      { config: 'no-direct', label: '(b)', value: null },
    ]);
    expect(svg).toContain('class="f-a"');
    expect(svg).toContain('no data');
  });
});

describe('cli', () => {
  it('reads its options', () => {
    expect(parseBenchArgs(['--reduced', '--out', 'x']).options).toMatchObject({ ...REDUCED });
    expect(parseBenchArgs(['--no-sweep', '--configs', 'super-agent,no-direct', '--time-scale', '0.5']).options).toMatchObject({ sweep: [], configs: ['super-agent', 'no-direct'], timeScale: 0.5 });
    expect(() => parseBenchArgs(['--configs', 'nope'])).toThrow(/Unknown configuration/);
    expect(() => parseBenchArgs(['--messages=0'])).toThrow(/positive/);
  });
});

describe('a reduced run', () => {
  it('is deterministic, accounts for every request, and renders a self-contained report', async () => {
    const a = await runBench(REDUCED);
    const b = await runBench(REDUCED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const s of a.summaries) {
      expect(s.requests.total).toBe(5);
      expect(s.requests.completed + s.requests.stopped + s.requests.unfinished).toBe(5);
      expect(s.requests.unfinished).toBe(0);
      expect(s.ackSec.count).toBe(a.workload.counts.request + a.workload.counts['follow-up'] + a.workload.counts.stop + a.workload.counts.chatter);
    }
    const html = renderReport(a);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<svg');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('routes CI failures straight to Workers only with direct routing, and keeps the classic lead serial', async () => {
    const r = await runBench({ ...REDUCED, messages: 120, requests: 8 });
    const by = (id: string) => r.summaries.find((s) => s.config === id)!;
    expect(by('super-agent').coordinator.direct).toBeGreaterThan(0);
    expect(by('no-direct').coordinator.direct).toBe(0);
    expect(by('super-agent').coordinator.decided).toBeLessThan(by('no-direct').coordinator.decided);
    expect(by('super-agent').tokens.byRole.worker.injected).toBeGreaterThan(by('no-direct').tokens.byRole.worker.injected);
    // One session doing all the work answers late and finishes late.
    expect(by('single-neutral').ackSec.p50!).toBeGreaterThan(10 * by('super-agent').ackSec.p50!);
    expect(by('single-neutral').completionMin.p50!).toBeGreaterThan(by('super-agent').completionMin.p50!);
    expect(by('single-delegate').executors).toBeGreaterThan(0);
    expect(r.directRouting).toEqual(directRoutingEffect(by('super-agent'), by('no-direct')));
  });

  it('batches more events per Router turn when the chat is busier', async () => {
    const w = (timeScale: number) => generateWorkload({ seed: 7, messages: 120, requests: 8, durationMin: 60, timeScale });
    const client = { call: async (q: ModelRequest) => scriptedPolicy(q) };
    const calm = summarize(await simulate({ config: 'no-direct', workload: w(1), client }));
    const busy = summarize(await simulate({ config: 'no-direct', workload: w(0.01), client }));
    expect(busy.coordinator.meanBatch!).toBeGreaterThan(calm.coordinator.meanBatch!);
    expect(busy.tokens.coordinatorContextRead / busy.coordinator.decided).toBeLessThan(calm.tokens.coordinatorContextRead / calm.coordinator.decided);
  });
});
