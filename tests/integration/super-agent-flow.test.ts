// The whole Super-agent flow with every switch on (ADR 105), walked in one server as a user would:
// a user's message and a failing test run arrive as Triggers and pass the two-stage filter; the
// Router dispatches a Worker, which subscribes to the folder's Thread and reads the failing test
// straight from the bus; a console error with no Worker listening goes through the slow path to
// the Router, which may tell the user but not start work; a long command starts and stops; recall
// walks the reference graph without a dead end; the Watchdog notices a stuck Worker and redirects
// it; the model gateway fails over. Demo mode, plus the real Claude Code with a mock provider for
// the gateway, where every role's calls are handed on past an account that is out of quota.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider, startOutOfQuota } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

/** The ids a recall result offers as next hops: its neighbours, its links and its read-more handles. */
function nextHops(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|\n)- [\w ]+? (#\d+|(?:tg|th|wk|job|wa|wt|ww)_[A-Za-z0-9]+|watchdog|env|chat):/g)) out.add(m[1]);
  for (const m of text.matchAll(/recall id=([#\w]+)/g)) out.add(m[1]);
  return [...out];
}

const KEY = 'key-of-account-b';

describe('the Super-agent flow, every switch on (demo mode)', () => {
  let crew: CrewServer;
  let quota: Awaited<ReturnType<typeof startOutOfQuota>>;
  let b: MockProvider;
  let siteDir: string;
  let site: any;
  let group: any;
  let dm: any;
  const seen: { message?: any; worker?: any; failing?: any; onWorkspace?: any } = {};

  const send = (chat: any, text: string) => crew.api('POST', `/chats/${chat.id}/messages`, { text });
  const workersOf = async (): Promise<any[]> => (await crew.api('GET', `/workers?chatId=${group.id}`)).items;
  const workerWhere = (pred: (w: any) => boolean): Promise<any> => waitFor(async () => (await workersOf()).find(pred), 40_000);
  const jobsOf = async (): Promise<any[]> => (await crew.api('GET', `/jobs?chatId=${dm.id}`)).items;
  const triggers = async (q = ''): Promise<any[]> => (await crew.api('GET', `/triggers?limit=200${q}`)).triggers;
  const routerTurns = async (): Promise<any[]> => (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages;
  const settle = () =>
    waitFor(async () => {
      const boot = await crew.api('GET', '/bootstrap');
      const r = boot.routers.find((x: any) => x.chatId === group.id);
      const busy = boot.workers.some((w: any) => w.chatId === group.id && ['starting', 'running', 'waiting'].includes(w.status));
      return !busy && (!r || (r.state !== 'thinking' && r.queued === 0));
    }, 40_000);

  beforeAll(async () => {
    quota = await startOutOfQuota();
    b = await startMockProvider({ token: KEY });
    crew = await startServer({ clock: true });
    // A folder without git: the group's Workers work in it and subscribe to its Thread, which a direct chat shares.
    siteDir = tempDir('crew-flow-site');
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<h1>Site</h1>\n');
    site = await crew.api('POST', '/projects', { mode: 'open', path: siteDir });
    const boot = await crew.api('GET', '/bootstrap');
    group = boot.chats.find((c: any) => c.kind === 'group');
    const chief = boot.bots.find((x: any) => x.name === 'Chief');
    dm = boot.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    await crew.api('PATCH', `/chats/${group.id}`, { projectId: site.id, permission: 'auto' });
    await crew.api('PATCH', `/chats/${dm.id}`, { projectId: site.id, permission: 'auto' });
    await crew.api('PATCH', `/bots/${chief.id}`, { fullDuplex: true });
    await crew.api('PATCH', '/settings', {
      superAgent: { enabled: true, router: { enabled: true, subscriptions: true }, recall: { enabled: true }, watchdog: { enabled: true, stuckMinutes: 5 } },
      safety: { audit: true },
      gateway: {
        enabled: true,
        providers: [
          { id: 'acct-a', baseUrl: quota.url, models: ['model-a'] },
          { id: 'acct-b', baseUrl: b.url, models: ['model-b'] },
        ],
        groups: [{ id: 'all', members: ['acct-a/model-a', 'acct-b/model-b'] }],
        defaultTarget: 'all',
      },
      gatewayTokens: { 'acct-a': 'key-of-account-a', 'acct-b': KEY },
    });
  });
  afterAll(async () => {
    await crew?.stop();
    await quota?.close();
    await b?.close();
    fs.rmSync(siteDir, { recursive: true, force: true });
  });

  it('takes a user message as an explicit Trigger, and the Router dispatches a Worker that subscribes to the folder', async () => {
    seen.message = await send(group, 'Make a slow change to the footer');
    seen.worker = await workerWhere((w) => w.related.includes(seen.message.id) && w.status === 'running' && w.threads?.length === 1);
    const t = (await triggers('&source=user')).find((x) => x.ref.messageId === seen.message.id);
    // The fast path settled it: no model was asked about an explicit request.
    expect(t).toMatchObject({ explicit: true, filter: { verdict: 'act', stage: 'fast', rule: 'explicit-request' } });
    expect(seen.worker.related).toEqual([seen.message.id, t.id]);
    expect((await routerTurns()).find((m) => m.batch?.includes(seen.message.id))).toBeTruthy();
    const thread = (await crew.api('GET', `/triggers/${t.id}`)).thread;
    expect(thread.kind).toBe('chat');
    // The Worker's subscription is the folder's workspace Thread, not the chat's.
    expect(seen.worker.threads[0]).not.toBe(thread.id);
  });

  it('hands a failing test run to that Worker straight from the bus, and to the bot that ran it', async () => {
    await send(dm, 'Run `echo "FAIL footer.test.js: expected 2, got 3"; exit 1` in the background');
    seen.failing = await waitFor(async () => (await jobsOf()).find((j) => j.status === 'failed' && j.triggerId), 30_000);
    expect(seen.failing).toMatchObject({ exitCode: 1, detail: 'Exit code 1' });
    seen.onWorkspace = await waitFor(async () => (await triggers('&source=job')).find((x) => !x.explicit && x.related.includes(seen.failing.id)));
    expect(seen.onWorkspace).toMatchObject({ threadId: seen.worker.threads[0], filter: { verdict: 'act', stage: 'fast', rule: 'subscribed', direct: [seen.worker.id] } });
    expect(seen.onWorkspace.summary).toContain(`${seen.failing.id} · command · failed · exit 1`);
    expect((await triggers('&source=job')).find((x) => x.id === seen.failing.triggerId)?.filter.rule).toBe('job-result');
    const done = await workerWhere((w) => w.id === seen.worker.id && w.status === 'done');
    expect(done.report.text).toContain(`Read 1 event sent to me directly: ${seen.onWorkspace.id}`);
    await settle();
    // The Router observed it without deciding on it.
    expect((await routerTurns()).flatMap((m) => m.batch || [])).not.toContain(seen.onWorkspace.id);
    // A summary keeps the ids it names, so an agent can recall them (ADR 105).
    const said = (await triggers('&source=turn')).find((x) => x.chatId === dm.id && x.summary.includes('background job is over'));
    expect(said.summary).toContain(seen.failing.id);
  });

  it('sends a console error nobody listens for through the slow path to the Router, which cannot start work from it', async () => {
    const workersBefore = (await workersOf()).length;
    const r = await crew.api('POST', '/triggers/preview-console', {
      projectId: site.id,
      chatId: group.id,
      page: '/',
      entries: [{ level: 'error', text: 'TypeError: footer is undefined', ts: Date.now() }],
    });
    const t = await waitFor(async () => (await triggers('&source=preview-console')).find((x) => x.id === r.trigger.id && x.filter.verdict !== 'candidate'), 30_000);
    expect(t.filter).toMatchObject({ verdict: 'act', stage: 'slow' });
    await waitFor(async () => (await routerTurns()).some((m) => m.batch?.includes(t.id)), 30_000);
    await settle();
    expect((await workersOf()).length).toBe(workersBefore);
  });

  it('starts a long command in the background and stops it, and the bot hears how it ended', async () => {
    await send(dm, 'Run `echo started; sleep 60` in the background');
    const long = await waitFor(async () => (await jobsOf()).find((j) => j.status === 'running' && j.lines >= 1), 30_000);
    const stopped = await crew.api('POST', `/jobs/${long.id}/stop`);
    expect(stopped).toMatchObject({ status: 200, detail: 'Stopped by the user' });
    const j = await waitFor(async () => (await jobsOf()).find((x) => x.id === long.id && x.status === 'stopped' && x.resultMessageId), 20_000);
    expect(() => process.kill(-j.pid, 0)).toThrow();
    const result = (await crew.api('GET', `/chats/${dm.id}/messages?limit=100`)).messages.find((m: any) => m.id === j.resultMessageId);
    expect(result.text).toContain('Stopped by the user');
    expect((await waitTurn(crew.api, dm.id, result.seq)).text).toContain(j.id);
  });

  it('lets recall walk the reference graph from the Worker without a dead end', async () => {
    const status = new Map<string, number>();
    const queue = [seen.worker.id, 'chat', 'watchdog', 'env'];
    while (queue.length && status.size < 120) {
      const id = queue.shift()!;
      if (status.has(id)) continue;
      const r = await crew.api('GET', `/recall/${encodeURIComponent(id)}?chatId=${group.id}`);
      status.set(id, r.status);
      if (r.status === 200) queue.push(...nextHops(r.text));
    }
    const dead = [...status.entries()].filter(([, s]) => s !== 200);
    expect(dead).toEqual([]);
    // It reached the failing test's job, its Trigger and the thread they share.
    for (const id of [seen.onWorkspace.id, seen.failing.id, seen.worker.threads[0]]) expect(status.get(id)).toBe(200);
  });

  it('notices a stuck Worker and stops it with a note it resumes from', async () => {
    const sent = await send(group, 'Make a slow change to the header');
    const w = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'running');
    // Past its first step (a finished tool call) it goes quiet; then its last progress is minutes ago, by the server's clock.
    await waitFor(async () => {
      const log = await crew.api('GET', `/workers/${w.id}/messages`);
      return log.worker?.status === 'running' && log.messages.some((m: any) => (m.parts || []).some((p: any) => p.type === 'tool' && p.status !== 'running'));
    }, 30_000);
    await crew.shiftClock(10 * 60_000);
    const tick = (await crew.api('POST', '/watchdog/tick')).tick;
    expect(tick).toMatchObject({ outcome: 'ran' });
    expect(tick.flags).toContain(`stuck:${w.id}`);
    const done = await workerWhere((x) => x.id === w.id && x.status === 'done' && x.turns === 2);
    const o = await crew.api('GET', '/watchdog');
    const stop = o.actions.find((a: any) => a.kind === 'stop' && a.target === w.id && !a.refused);
    expect(stop.tickId).toBe(tick.id);
    expect(done.report.status).toBe('done');
    // Its first turn was cut short by the stop; the second one, from the Watchdog's note, finished.
    const log = (await crew.api('GET', `/workers/${w.id}/messages`)).messages;
    expect(log.map((m: any) => m.status)).toEqual(['stopped', 'done']);
    expect(stop.text).toContain('Refocus on your task');
    await crew.shiftClock(0);
    await settle();
  });

  it('fails over past an account that is out of quota, and logs who answered', async () => {
    const before = quota.hits;
    const t = await crew.api('POST', '/gateway/test', { target: 'all' });
    expect(t).toMatchObject({ ok: true, provider: 'acct-b' });
    expect(t.tries.map((x: any) => [x.member, x.outcome])).toEqual([
      ['acct-a/model-a', 'handed-on'],
      ['acct-b/model-b', 'answered'],
    ]);
    expect(quota.hits).toBe(before + 1);
    expect((await crew.api('GET', '/gateway')).calls[0]).toMatchObject({ provider: 'acct-b', outcome: 'ok' });
  });
});

describe.skipIf(!claudeCli())('every role through the gateway, past an account out of quota (real Claude Code)', () => {
  let quota: Awaited<ReturnType<typeof startOutOfQuota>>;
  let mock: MockProvider;
  let crew: CrewServer;
  let group: any;
  const ROUTER = 'coordinator of the group chat';
  const WORKER = 'You are working as a Worker';
  const FILTER = 'You filter events for Crew';

  beforeAll(async () => {
    quota = await startOutOfQuota();
    mock = await startMockProvider({
      token: KEY,
      reply: (r) => {
        const system = JSON.stringify(r.body.system || '');
        const messages = JSON.stringify(r.body.messages || []);
        if (messages.includes(FILTER)) {
          const id = messages.match(/<event id=\\"(tg_[A-Za-z0-9]+)\\"/)?.[1] ?? 'tg_none';
          return { text: JSON.stringify({ decisions: [{ id, act: true, reason: 'A console error the user should know about.' }] }) };
        }
        if (system.includes(ROUTER)) {
          if (messages.includes('toolu_dispatch_1') || !messages.includes('kind=\\"user\\"')) return { text: 'Handled.' };
          return { tool: { id: 'toolu_dispatch_1', name: 'mcp__crew_router__dispatch_worker', input: { title: 'Header', task: 'Make the header blue.', bot: 'Pixel' } } };
        }
        if (system.includes(WORKER)) return { text: 'Report: made the header blue.' };
        return { text: 'Looked at the snapshot; nothing needs me.' };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      gateway: {
        enabled: true,
        providers: [
          { id: 'acct-a', baseUrl: quota.url, models: ['model-a'] },
          { id: 'acct-b', baseUrl: mock.url, models: ['model-b'] },
        ],
        groups: [{ id: 'all', members: ['acct-a/model-a', 'acct-b/model-b'] }],
        defaultTarget: 'all',
        roles: { router: 'all', worker: 'all', watchdog: 'all', oneshot: 'all', bot: 'all' },
      },
      gatewayTokens: { 'acct-a': 'key-of-account-a', 'acct-b': KEY },
    });
    await crew.api('PATCH', '/settings', {
      superAgent: { enabled: true, router: { enabled: true, subscriptions: true }, recall: { enabled: true }, watchdog: { enabled: true } },
      safety: { audit: true },
    });
    group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
  });
  afterAll(async () => {
    await crew?.stop();
    await quota?.close();
    await mock?.close();
  });

  it('hands every call on to the next account, and no agent sees the refusal', async () => {
    await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Make the header blue' });
    const w = await waitFor(async () => (await crew.api('GET', `/workers?chatId=${group.id}`)).items.find((x: any) => x.status === 'done'), 120_000);
    expect(w.report.text).toContain('made the header blue');
    // A console error goes through the slow path: its model call is the gateway's oneshot role.
    const project = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === group.id).projectId;
    const r = await crew.api('POST', '/triggers/preview-console', {
      projectId: project,
      chatId: group.id,
      page: '/',
      entries: [{ level: 'error', text: 'TypeError: header is undefined', ts: Date.now() }],
    });
    const t = await waitFor(async () => {
      const { trigger } = await crew.api('GET', `/triggers/${r.trigger.id}`);
      return trigger.filter.verdict !== 'candidate' && trigger;
    }, 120_000);
    expect(t.filter).toMatchObject({ verdict: 'act', stage: 'slow' });
    const tick = await crew.api('POST', '/watchdog/tick');
    expect(tick.tick.outcome).toBe('ran');
    await waitFor(async () => {
      const o = await crew.api('GET', '/watchdog');
      return o.state !== 'thinking' && o.ticks.find((x: any) => x.id === tick.tick.id)?.messageId;
    }, 120_000);

    const g = await crew.api('GET', '/gateway');
    const roles = new Set(g.calls.map((c: any) => c.role));
    for (const role of ['router', 'worker', 'watchdog', 'oneshot']) expect(roles).toContain(role);
    const real = g.calls.filter((c: any) => c.outcome !== 'limited');
    // Every call was refused by the account out of quota, then answered by the next one.
    for (const c of real) {
      expect(c).toMatchObject({ provider: 'acct-b', outcome: 'ok' });
      expect(c.tries.map((x: any) => x.outcome)).toEqual(['handed-on', 'answered']);
    }
    expect(quota.hits).toBeGreaterThanOrEqual(real.length);
    // No session saw an error: no failed Worker, Router or Watchdog turn.
    expect((await crew.api('GET', `/workers?chatId=${group.id}`)).items.every((x: any) => x.status !== 'error')).toBe(true);
    expect((await crew.api('GET', '/bootstrap')).routers.every((x: any) => x.state !== 'error')).toBe(true);
    expect((await crew.api('GET', '/watchdog')).ticks.every((x: any) => x.outcome !== 'error')).toBe(true);
  });
});
