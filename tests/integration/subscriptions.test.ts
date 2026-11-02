// Thread subscriptions and direct routing (ADR 003), in demo mode: with the switch on, a Worker
// subscribes to the threads it works on, and later events there go straight to it, with no Router
// decision; the Router only observes. A demo Worker on a "slow" task stops when an event reaches it
// and lists the events it read in its report, which is how these tests see delivery.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitFor } from '../helpers/server';

describe.skipIf(!claudeCli())('with Claude Code and a mock model', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let group: any;
  let fired = false;

  /** Mid-turn: the console error is published while the Worker's first tool (a 2 s sleep) runs. */
  const publishWhileItWorks = () => {
    if (fired) return;
    fired = true;
    void (async () => {
      const b = await crew.api('GET', '/bootstrap');
      const projectId = b.chats.find((c: any) => c.id === group.id).workspaceId;
      await crew.api('POST', '/triggers/preview-console', { projectId, chatId: group.id, page: '/', entries: [{ level: 'error', text: 'TypeError: header is undefined', ts: Date.now() }] });
    })();
  };

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        const system = JSON.stringify(r.body.system || '');
        const messages = JSON.stringify(r.body.messages || []);
        if (system.includes('coordinator of the group chat')) {
          if (messages.includes('toolu_dispatch_1') || !messages.includes('kind=\\"user\\"')) return { text: 'Handled.' };
          return { tool: { id: 'toolu_dispatch_1', name: 'mcp__crew_router__dispatch_worker', input: { title: 'Header', task: 'Make the header blue.', bot: 'Pixel' } } };
        }
        if (system.includes('You are working as a Worker')) {
          if (messages.includes('toolu_sleep_1')) return { text: 'Report: made the header blue.' };
          publishWhileItWorks();
          return { tool: { id: 'toolu_sleep_1', name: 'Bash', input: { command: 'sleep 2', description: 'Wait' } } };
        }
        return { text: 'OK.' };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true, subscriptions: true, model: 'mock-router', workerModel: 'mock-worker' } } });
    group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
    // Full auto, so the Worker's sleep needs no approval.
    await crew.api('PATCH', `/chats/${group.id}`, { permission: 'auto' });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('puts an event that arrives while a Worker works into its context after its next tool call, with the thread tools on offer', async () => {
    await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Make the header blue' });
    const w = await waitFor(async () => (await crew.api('GET', `/workers?chatId=${group.id}`)).items.find((x: any) => x.status === 'done'), 60_000);
    const t = (await crew.api('GET', '/triggers?source=preview-console')).triggers[0];
    expect(t.filter).toMatchObject({ rule: 'subscribed', direct: [w.id] });
    const worker = mock.requests.filter((r) => JSON.stringify(r.body.system || '').includes('You are working as a Worker'));
    expect(worker[0].tools).toEqual(expect.arrayContaining(['mcp__crew__hand_back', 'mcp__crew__unsubscribe_thread']));
    const after = worker.find((r) => JSON.stringify(r.body.messages).includes('toolu_sleep_1'));
    expect(JSON.stringify(after?.body.messages)).toContain(`<event id=\\"${t.id}\\" thread=\\"${t.threadId}\\"`);
    expect(JSON.stringify(after?.body.messages)).toContain('TypeError: header is undefined');
    expect(w.received).toBe(1);
    expect(w.inbox ?? []).toEqual([]);
  });
});

describe('direct routing to subscribed Workers (demo mode)', () => {
  let crew: CrewServer;
  let group: any;

  const send = (text: string) => crew.api('POST', `/chats/${group.id}/messages`, { text });
  const workers = async (): Promise<any[]> => (await crew.api('GET', `/workers?chatId=${group.id}`)).items;
  const workerWhere = (pred: (w: any) => boolean): Promise<any> => waitFor(async () => (await workers()).find(pred), 40_000);
  const routerBatches = async (): Promise<string[][]> => (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages.map((m: any) => m.batch || []);
  const chat = async () => (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === group.id);
  const chatWorkspace = async () => {
    const b = await crew.api('GET', '/bootstrap');
    return b.projects.find((p: any) => p.id === b.chats.find((c: any) => c.id === group.id).workspaceId);
  };
  const consoleError = async (text: string) =>
    (await crew.api('POST', '/triggers/preview-console', { projectId: (await chatWorkspace()).id, chatId: group.id, page: '/', entries: [{ level: 'error', text, ts: Date.now() }] })).trigger;
  const trigger = async (id: string) => (await crew.api('GET', `/triggers/${id}`)).trigger;
  /** No Worker of the chat is active and its Router has nothing to do. */
  const settle = () =>
    waitFor(async () => {
      const b = await crew.api('GET', '/bootstrap');
      const r = b.routers.find((x: any) => x.chatId === group.id);
      const busy = b.workers.some((w: any) => w.chatId === group.id && ['starting', 'running', 'waiting'].includes(w.status));
      return !busy && (!r || (r.state !== 'thinking' && r.queued === 0));
    }, 40_000);

  beforeAll(async () => {
    crew = await startServer();
    group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true } } });
  });
  afterAll(() => crew?.stop());

  it('subscribes nobody and routes as before while the switch is off', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.superAgent.router.subscriptions).toBe(false);
    const sent = await send('Build a pricing page');
    const w = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'done');
    expect(w.threads).toBeUndefined();
    await settle();
    const { triggers, stats } = await crew.api('GET', '/triggers');
    expect(triggers.some((t: any) => t.source === 'landing')).toBe(false);
    expect(stats.direct).toBe(0);
    expect((await chat()).router.direct).toBeUndefined();
  });

  it("sends a routine's next run straight to the Worker the Router gave the first one to", async () => {
    await crew.api('PATCH', '/settings', { superAgent: { router: { subscriptions: true } } });
    const r = await crew.api('POST', '/routines', { name: 'Changelog', botId: group.leadBotId, chatId: group.id, prompt: 'Build the changelog page', trigger: { type: 'daily', time: '03:00' } });
    await crew.api('POST', `/routines/${r.id}/run`);
    // Subscribed to the routine's thread and to the chat's workspace.
    const w = await workerWhere((x) => x.status === 'done' && x.threads?.length === 2);
    const first = (await crew.api('GET', '/triggers?source=routine')).triggers[0];
    expect(first.filter.rule).toBe('explicit-request');
    expect(w.threads).toContain(first.threadId);
    await settle();
    const before = await routerBatches();

    await crew.api('POST', `/routines/${r.id}/run`);
    const again = await workerWhere((x) => x.id === w.id && x.turns === 2 && x.status === 'done');
    const second = (await crew.api('GET', '/triggers?source=routine')).triggers[0];
    expect(second.id).not.toBe(first.id);
    expect(second.filter).toMatchObject({ verdict: 'act', stage: 'fast', rule: 'subscribed', direct: [w.id] });
    expect(again.received).toBe(1);
    // The Router never decided on the run; it heard the Worker's report, and saw the run under <direct>.
    await settle();
    const after = (await routerBatches()).slice(before.length);
    expect(after.flat()).not.toContain(second.ref.messageId);
    expect(after.flat()).toContain(w.id);
    expect((await chat()).router).toMatchObject({ direct: 1 });
    expect((await chat()).router.decided).toBeGreaterThan(0);
  });

  it('hands a running Worker an event on its workspace between its steps, with no slow path or Router turn', async () => {
    await settle();
    const sent = await send('Make a slow change to the footer');
    const w = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'running' && x.threads?.length === 1);
    const before = await routerBatches();
    const t = await consoleError('TypeError: footer is undefined');
    expect(t.filter).toMatchObject({ verdict: 'act', stage: 'fast', rule: 'subscribed', direct: [w.id] });
    const done = await workerWhere((x) => x.id === w.id && x.status === 'done');
    expect(done.report.text).toContain(`Read 1 event sent to me directly: ${t.id}`);
    await settle();
    expect((await routerBatches()).slice(before.length).flat()).not.toContain(t.id);
    expect((await trigger(t.id)).filter.stage).toBe('fast');
  });

  it("tells a Worker that shares the branch about another Worker's merge", async () => {
    await settle();
    const slow = await send('Make a slow change to the nav');
    const a = await workerWhere((x) => x.related.includes(slow.id) && x.status === 'running' && x.threads?.length === 1);
    const fast = await send('Build a header');
    const b = await workerWhere((x) => x.related.includes(fast.id) && x.status === 'done');
    const landing = await waitFor(async () => (await crew.api('GET', '/triggers?source=landing')).triggers.find((t: any) => t.related.includes(b.id)));
    expect(landing.filter).toMatchObject({ rule: 'subscribed', direct: [a.id] });
    expect(landing.summary).toContain(`Worker ${b.id}`);
    expect(landing.threadId).toBe(a.threads[0]);
    const done = await workerWhere((x) => x.id === a.id && x.status === 'done');
    expect(done.report.text).toContain(landing.id);
  });

  it('takes an event a Worker hands back to the Router, which still cannot start work for it', async () => {
    await settle();
    const sent = await send('Make a slow change to the logo');
    const w = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'running' && x.threads?.length === 1);
    const thread = w.threads[0];
    const count = (await workers()).length;
    const t = await consoleError('TypeError: not my task');
    expect(t.filter.direct).toEqual([w.id]);
    const back = await waitFor(async () => {
      const x = await trigger(t.id);
      return x.filter.handedBack ? x : null;
    });
    expect(back.filter.handedBack.by).toBe(w.id);
    expect(back.action).toBe(`Handed back to the Router by ${w.id}`);
    // The Router decided on it alone (an environment event), and told the user instead of dispatching.
    await settle();
    expect((await routerBatches()).some((b) => b.length === 1 && b[0] === t.id)).toBe(true);
    const told = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.filter((m: any) => m.router && m.text.includes(`${w.id} received this directly`));
    expect(told).toHaveLength(1);
    expect(await workers()).toHaveLength(count);
    expect((await workers()).find((x) => x.id === w.id).threads).not.toContain(thread);
  });

  it('lets the user take a Worker off a thread, and the next event takes the normal path', async () => {
    await settle();
    const w = (await workers()).find((x) => x.threads?.length === 1 && x.status === 'done');
    const thread = w.threads[0];
    const log = await crew.api('GET', `/workers/${w.id}/messages`);
    expect(log.threads.map((t: any) => t.id)).toEqual([thread]);
    const off = await crew.api('POST', `/workers/${w.id}/unsubscribe`, { threadId: thread });
    expect(off.threads).toEqual([]);
    expect((await crew.api('POST', `/workers/${w.id}/unsubscribe`, { threadId: thread })).status).toBe(404);
    // Nobody is working on that thread now: a console error goes to the filter, then the Router.
    const t = await consoleError('ReferenceError: header is not defined');
    expect(t.filter.verdict).toBe('candidate');
    const stats = (await crew.api('GET', '/triggers')).stats;
    expect(stats.direct).toBeGreaterThanOrEqual(3);
  });
});
