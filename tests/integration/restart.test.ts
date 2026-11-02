// Crew is killed mid-run with every Super-agent switch on, and started again (ADR 105). What was in
// flight recovers or fails cleanly, and nothing is done twice: the user's message a Router turn was
// handling when Crew died is handed to the Router again (it was never acted on), a Worker's report
// that waited in the Router's inbox is read, a background command that outlived Crew is stopped,
// the Watchdog's cut-off tick and question are settled, and subscriptions work for new Workers.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, tempDir, waitFor } from '../helpers/server';

const alive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('a restart of Crew mid-run, every switch on (demo mode)', () => {
  const dir = tempDir('crew-restart');
  const siteDir = tempDir('crew-restart-site');
  let crew: CrewServer;
  let group: any;
  let dm: any;
  /** Before the restart. */
  const before: { footer?: any; held?: any; workerA?: any; longJob?: any; failing?: any } = {};

  const workersOf = async (): Promise<any[]> => (await crew.api('GET', `/workers?chatId=${group.id}`)).items;
  const jobsOf = async (): Promise<any[]> => (await crew.api('GET', `/jobs?chatId=${dm.id}`)).items;
  const routerTurns = async (): Promise<any[]> => (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages;
  const router = async () => (await crew.api('GET', '/bootstrap')).routers.find((r: any) => r.chatId === group.id);
  const send = (chat: any, text: string) => crew.api('POST', `/chats/${chat.id}/messages`, { text });

  beforeAll(async () => {
    crew = await startServer({ dir });
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<h1>Site</h1>\n');
    const site = await crew.api('POST', '/projects', { mode: 'open', path: siteDir });
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    await crew.api('PATCH', `/chats/${group.id}`, { projectId: site.id, permission: 'auto' });
    await crew.api('PATCH', `/chats/${dm.id}`, { projectId: site.id, permission: 'auto' });
    await crew.api('PATCH', `/bots/${chief.id}`, { fullDuplex: true });
    await crew.api('PATCH', '/settings', {
      superAgent: { enabled: true, router: { enabled: true, subscriptions: true }, recall: { enabled: true }, watchdog: { enabled: true } },
      safety: { audit: true },
    });
  });
  afterAll(async () => {
    await crew?.stop();
    if (before.longJob?.pid && alive(before.longJob.pid)) process.kill(-before.longJob.pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(siteDir, { recursive: true, force: true });
  });

  it('is killed while the Router thinks, a Worker’s report waits for it, and a long command runs', async () => {
    before.footer = await send(group, 'Make a slow change to the footer');
    before.workerA = await waitFor(async () => (await workersOf()).find((w) => w.related.includes(before.footer.id) && w.status === 'running' && w.threads?.length), 40_000);
    // The demo Router "holds on" for a while: Crew dies during this turn.
    before.held = await send(group, 'Hold on, then build a pricing page');
    await waitFor(async () => (await routerTurns()).some((m) => m.batch?.includes(before.held.id) && m.status === 'streaming'), 20_000);

    // A test run fails in the folder Worker A works in: the result reaches A, which finishes and reports.
    await send(dm, 'Run `echo "FAIL footer.test.js: expected 2, got 3"; exit 1` in the background');
    before.failing = await waitFor(async () => (await jobsOf()).find((j) => j.status === 'failed'), 30_000);
    await waitFor(async () => (await workersOf()).find((w) => w.id === before.workerA.id && w.status === 'done'), 40_000);
    // A's report waits in the inbox: the Router is still on the held turn.
    expect((await router()).state).toBe('thinking');
    expect((await routerTurns()).some((m) => m.batch?.includes(before.workerA.id))).toBe(false);

    await send(dm, `Run \`sleep 120; touch ${path.join(siteDir, 'late.txt')}\` in the background`);
    before.longJob = await waitFor(async () => (await jobsOf()).find((j) => j.status === 'running' && j.pid), 30_000);
    expect(alive(before.longJob.pid)).toBe(true);

    await crew.kill();
    // What a crash leaves of the Watchdog in the middle of a tick and of a maintainer's question.
    const wd = path.join(crew.home, 'watchdog');
    fs.mkdirSync(wd, { recursive: true });
    const at = Date.now();
    const tick = { id: 'wt_cutoff1', at, kind: 'tick', outcome: 'ran', reason: 'flagged: stuck:wk_gone', flags: ['stuck:wk_gone'], actions: 0, costUsd: 0 };
    const asked = { id: 'wt_cutoff2', at: at + 1, kind: 'maintainer', outcome: 'ran', reason: 'a maintainer wrote', flags: [], actions: 0, costUsd: 0 };
    fs.appendFileSync(path.join(wd, 'ticks.jsonl'), `${JSON.stringify(tick)}\n${JSON.stringify(asked)}\n`);
    fs.appendFileSync(
      path.join(crew.home, 'messages', 'watchdog.jsonl'),
      `${JSON.stringify({ id: 'm_askedwd1', chatId: 'watchdog', seq: 1, ts: at, role: 'user', text: 'Why did the footer fail?' })}\n`,
    );
    crew = await startServer({ dir });
  });

  it('stops the command that outlived Crew, and reports the job once', async () => {
    const j = (await jobsOf()).find((x) => x.id === before.longJob.id);
    expect(j).toMatchObject({ status: 'stopped', detail: 'Crew restarted; its command was still running and was stopped' });
    await waitFor(() => !alive(before.longJob.pid), 10_000);
    const notes = (await crew.api('GET', `/chats/${dm.id}/messages?limit=100`)).messages.filter((m: any) => m.notice === 'job' && m.jobId === j.id);
    expect(notes).toHaveLength(1);
    expect(fs.existsSync(path.join(siteDir, 'late.txt'))).toBe(false);
  });

  it('hands the Router the message its cut-off turn never acted on, and the report it never read, once each', async () => {
    const turns = await routerTurns();
    const cut = turns.find((m) => m.batch?.includes(before.held.id) && m.interrupted);
    expect(cut).toBeTruthy();
    // The held message gets exactly one Worker, from the turn after the restart.
    const forHeld = await waitFor(async () => {
      const ws = (await workersOf()).filter((w) => w.related.includes(before.held.id));
      return ws.length && ws.every((w) => w.status === 'done') ? ws : null;
    }, 40_000);
    expect(forHeld).toHaveLength(1);
    const redo = (await routerTurns()).filter((m) => !m.interrupted && m.batch?.includes(before.held.id));
    expect(redo).toHaveLength(1);
    // Worker A's report, which waited in the inbox, is read after the restart; A itself is not redone.
    await waitFor(async () => (await routerTurns()).some((m) => !m.interrupted && m.batch?.includes(before.workerA.id)), 20_000);
    expect((await workersOf()).filter((w) => w.related.includes(before.footer.id))).toHaveLength(1);
    expect((await workersOf()).find((w) => w.id === before.workerA.id)).toMatchObject({ status: 'done' });
    await waitFor(async () => (await router())?.state === 'idle' && (await router())?.queued === 0, 20_000);
    // Each once: the user's messages and the report were not handed over a second time.
    const all = (await routerTurns()).filter((m) => !m.interrupted).flatMap((m) => m.batch || []);
    for (const id of [before.held.id, before.workerA.id, before.footer.id]) expect(all.filter((x: string) => x === id)).toHaveLength(1);
  });

  it('settles the Watchdog’s cut-off tick and question instead of leaving them half-done', async () => {
    const o = await crew.api('GET', '/watchdog');
    expect(o.ticks.find((t: any) => t.id === 'wt_cutoff1')).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/^interrupted: Crew restarted/) });
    expect(o.ticks.find((t: any) => t.id === 'wt_cutoff2')).toMatchObject({ outcome: 'error', reason: expect.stringMatching(/^interrupted: Crew restarted/) });
    const log = (await crew.api('GET', '/watchdog/messages')).messages;
    expect(log.at(-1)).toMatchObject({ role: 'system', text: expect.stringContaining('Crew restarted before the Watchdog answered') });
    // The timer runs again, and a tick looks from where the cut-off one would have.
    expect(o.state).toBe('idle');
    expect(o.nextTickAt).toBeGreaterThan(Date.now());
  });

  it('delivers to Workers subscribed after the restart, straight from the bus', async () => {
    const sent = await send(group, 'Make a slow change to the nav');
    const w = await waitFor(async () => (await workersOf()).find((x) => x.related.includes(sent.id) && x.status === 'running' && x.threads?.length), 40_000);
    await send(dm, 'Run `echo nav-check-ok` in the background');
    const t = await waitFor(async () => (await crew.api('GET', '/triggers?source=job')).triggers.find((x: any) => !x.explicit && x.filter.direct?.includes(w.id)), 30_000);
    expect(t.filter).toMatchObject({ rule: 'subscribed', direct: [w.id] });
    const done = await waitFor(async () => (await workersOf()).find((x) => x.id === w.id && x.status === 'done'), 40_000);
    expect(done.report.text).toContain(`Read 1 event sent to me directly: ${t.id}`);
  });
});
