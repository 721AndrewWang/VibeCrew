// The ablation bench end to end (ADR 101): `npm run bench -- --reduced` as CI runs it, and the same
// reduced run with every model call going over HTTP to the mock provider the other integration
// tests use, which must give exactly the in-process result.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BenchResult, REDUCED, runBench } from '../../server/bench/index';
import { httpClient, mockReply } from '../../server/bench/model';
import { scriptedPolicy, TOOLS } from '../../server/bench/policies';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';

const ROOT = path.resolve(__dirname, '../..');

describe('npm run bench -- --reduced', () => {
  let out: string;
  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-bench-'));
  });
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  it('runs the four configurations offline and writes bench.json and a self-contained report', () => {
    const started = Date.now();
    const res = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/bench.ts', '--reduced', '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      // Nothing from the developer's own setup reaches the bench, and it must not need it.
      env: { PATH: process.env.PATH, HOME: out, CREW_HOME: path.join(out, 'home') },
      timeout: 60_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(res.stdout).toContain('Crew ablation bench: 60 events');

    const result = JSON.parse(fs.readFileSync(path.join(out, 'bench.json'), 'utf8')) as BenchResult;
    expect(result.bench).toBe('crew-superagent-ablation');
    expect(result.summaries.map((s) => s.config)).toEqual(['super-agent', 'no-direct', 'single-neutral', 'single-delegate']);
    expect(result.sweep).toEqual([]);
    for (const s of result.summaries) {
      expect(s.requests).toMatchObject({ total: 5, unfinished: 0 });
      expect(s.completionMin.p50).toBeGreaterThan(0);
      expect(s.completionMin.p95!).toBeGreaterThanOrEqual(s.completionMin.p50!);
      expect(s.tokens.contextRead).toBeGreaterThan(s.tokens.injected);
    }
    const by = (id: string) => result.summaries.find((s) => s.config === id)!;
    expect(by('super-agent').coordinator.direct).toBeGreaterThan(0);
    expect(by('super-agent').coordinator.decided).toBeLessThan(by('no-direct').coordinator.decided);
    expect(result.batchByRate.map((b) => b.config)).toEqual(['super-agent', 'no-direct']);

    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    expect(html).toContain('Crew Super-agent ablation bench');
    expect((html.match(/<svg /g) || []).length).toBeGreaterThanOrEqual(10);
    expect(html).not.toContain('<script');
    // The bench never touched a Crew data folder.
    expect(fs.existsSync(path.join(out, 'home'))).toBe(false);
  });
});

describe('npm run bench -- --reduced --arms all (ADR 011)', () => {
  let out: string;
  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-bench-arms-'));
  });
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  it('runs speculation, the GitHub channel and per-channel output as extra arms of (a)', () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/bench.ts', '--reduced', '--arms', 'all', '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: out, CREW_HOME: path.join(out, 'home') },
      timeout: 60_000,
    });
    expect(res.status, res.stderr).toBe(0);
    for (const label of ['(a) + speculative runs', '(a) + GitHub channel', '(a) − per-channel output']) expect(res.stdout).toContain(label);
    const result = JSON.parse(fs.readFileSync(path.join(out, 'bench.json'), 'utf8')) as BenchResult;
    expect(result.summaries.map((s) => s.config)).toEqual(['super-agent', 'no-direct', 'single-neutral', 'single-delegate']);
    expect(result.arms.map((s) => s.arm)).toEqual(['speculative', 'github', 'no-channels']);
    expect(result.runs.filter((r) => r.arm)).toHaveLength(3);
    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    expect(html).toContain('Wave-2 arms');
    expect(html).not.toContain('<script');
    expect(fs.existsSync(path.join(out, 'home'))).toBe(false);
  });
});

describe('the reduced bench over HTTP, against the mock provider', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  beforeAll(async () => {
    mock = await startMockProvider({ token: TOKEN, reply: mockReply(scriptedPolicy) });
  });
  afterAll(async () => {
    await mock?.close();
  });

  it('gives exactly the in-process result, through real Anthropic-shaped requests', async () => {
    const opts = { ...REDUCED, configs: ['super-agent', 'single-delegate'] as const };
    // The speculative arm too: its run's calls go over HTTP like every other session's.
    const local = await runBench({ ...opts, configs: [...opts.configs], arms: ['speculative'] });
    const client = httpClient(mock.url, TOKEN);
    const remote = await runBench({ ...opts, configs: [...opts.configs], arms: ['speculative'] }, client);
    expect(JSON.stringify(remote)).toBe(JSON.stringify(local));

    const calls = [...local.summaries, ...local.arms].reduce((n, s) => n + s.tokens.calls, 0);
    expect(local.arms[0].tokens.byRole.speculative.calls).toBeGreaterThan(0);
    expect(mock.requests.some((r) => JSON.stringify(r.body.system || '').includes('You are a speculative background run'))).toBe(true);
    expect(client.calls).toBe(calls);
    expect(mock.requests).toHaveLength(calls);

    const system = (r: (typeof mock.requests)[number]) => JSON.stringify(r.body.system || '');
    const router = mock.requests.filter((r) => system(r).includes('coordinator of the group chat'));
    const workers = mock.requests.filter((r) => system(r).includes('You are working as a Worker'));
    const lead = mock.requests.filter((r) => system(r).includes('You lead this group'));
    expect(router.length).toBe(local.summaries[0].coordinator.calls + local.arms[0].coordinator.calls);
    expect(router[0].tools).toEqual(expect.arrayContaining([TOOLS.dispatch, TOOLS.message, TOOLS.stopWorker, TOOLS.reply]));
    expect(router.some((r) => JSON.stringify(r.body.messages).includes('<workers>'))).toBe(true);
    expect(workers[0].tools).toEqual(expect.arrayContaining([TOOLS.work, TOOLS.handBack]));
    expect(lead[0].tools).toEqual(expect.arrayContaining([TOOLS.start, TOOLS.stop, TOOLS.status]));
    // Direct routing reached a Worker's context between its steps.
    expect(workers.some((r) => JSON.stringify(r.body.messages).includes('arrived on threads you subscribe to'))).toBe(true);
  });
});
