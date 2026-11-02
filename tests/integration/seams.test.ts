// The seams between the Super-agent milestones (ADR 010), end to end. In demo mode: a background
// job in a shared folder reaches the Worker subscribed to it straight from the bus; recall walks from
// that event to a job another chat ran, and from a Watchdog notice to the tick that sent it; the
// Watchdog reads the audit log and the friction log; the command guard and the untrusted wrapper
// hold for Workers, background commands and sub-tasks alike. With the real Claude Code and a mock
// provider: the model gateway routes the Router, its Workers and the Watchdog each by their role.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

describe('the Super-agent as one system (demo mode)', () => {
  let crew: CrewServer;
  let siteDir: string;
  let group: any;
  let dm: any;
  let other: any;
  let pusher: any;

  const send = (chat: any, text: string) => crew.api('POST', `/chats/${chat.id}/messages`, { text });
  const groupWorkers = async (): Promise<any[]> => (await crew.api('GET', `/workers?chatId=${group.id}`)).items;
  const workerWhere = (pred: (w: any) => boolean): Promise<any> => waitFor(async () => (await groupWorkers()).find(pred), 40_000);
  const jobsOf = async (chat: any): Promise<any[]> => (await crew.api('GET', `/jobs?chatId=${chat.id}`)).items;
  const jobTriggers = async (): Promise<any[]> => (await crew.api('GET', '/triggers?source=job')).triggers;
  const recall = (id: string, chat: any) => crew.api('GET', `/recall/${encodeURIComponent(id)}?chatId=${chat.id}`);
  const audit = async (): Promise<any[]> => (await crew.api('GET', '/audit')).entries;
  const messagesOf = async (chat: any): Promise<any[]> => (await crew.api('GET', `/chats/${chat.id}/messages?limit=200`)).messages;
  const groupChat = async () => (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === group.id);
  const routerBatches = async (): Promise<string[][]> => (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages.map((m: any) => m.batch || []);
  /** No Worker of the group is active and its Router has nothing to do. */
  const settle = () =>
    waitFor(async () => {
      const b = await crew.api('GET', '/bootstrap');
      const r = b.routers.find((x: any) => x.chatId === group.id);
      const busy = b.workers.some((w: any) => w.chatId === group.id && ['starting', 'running', 'waiting'].includes(w.status));
      return !busy && (!r || (r.state !== 'thinking' && r.queued === 0));
    }, 40_000);
  /** Asks for a tick once the Watchdog is idle, and waits for its turn to finish. */
  async function tickNow(): Promise<any> {
    await waitFor(async () => (await crew.api('GET', '/watchdog')).state === 'idle', 30_000);
    const r = await crew.api('POST', '/watchdog/tick');
    expect(r.tick.outcome).toBe('ran');
    await waitFor(async () => {
      const o = await crew.api('GET', '/watchdog');
      return o.state === 'idle' && o.ticks.find((x: any) => x.id === r.tick.id)?.messageId;
    }, 30_000);
    return r.tick;
  }

  beforeAll(async () => {
    crew = await startServer();
    // A folder without git: Workers work in the chat's folder and subscribe to its workspace thread,
    // which a direct chat on the same folder shares.
    siteDir = tempDir('crew-shared-site');
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<h1>Site</h1>\n');
    const site = await crew.api('POST', '/projects', { mode: 'open', path: siteDir });
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    other = b.chats.find((c: any) => c.kind === 'dm' && c.id !== dm.id);
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
    fs.rmSync(siteDir, { recursive: true, force: true });
  });

  it('hands a background job’s result to the Worker subscribed to the folder it ran in, with no Router decision (ADR 003 × 004)', async () => {
    const sent = await send(group, 'Make a slow change to the footer');
    const w = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'running' && x.threads?.length === 1);
    const directBefore = (await groupChat()).router?.direct ?? 0;

    await send(dm, 'Run `sleep 1; echo built-ok` in the background');
    const job = await waitFor(async () => (await jobsOf(dm)).find((j) => j.status === 'done' && j.triggerId), 30_000);
    const onWorkspace = await waitFor(async () => (await jobTriggers()).find((t) => !t.explicit));
    expect(onWorkspace).toMatchObject({ threadId: w.threads[0], chatId: dm.id, filter: { verdict: 'act', stage: 'fast', rule: 'subscribed', direct: [w.id] } });
    expect(onWorkspace.related).toEqual([job.id, job.triggerId]);
    expect(onWorkspace.summary).toContain(`${job.id} · command · finished · exit 0`);
    // The bot that started it got its own copy on its chat's thread, as before.
    expect((await jobTriggers()).find((t) => t.id === job.triggerId)?.filter.rule).toBe('job-result');

    const done = await workerWhere((x) => x.id === w.id && x.status === 'done');
    expect(done.report.text).toContain(`Read 1 event sent to me directly: ${onWorkspace.id}`);
    await settle();
    // The Router observed it, and counted a decision it did not have to make.
    expect((await groupChat()).router.direct).toBe(directBefore + 1);
    expect((await routerBatches()).flat()).not.toContain(onWorkspace.id);

    // The result the bot read is untrusted data, like page text and event payloads (ADR 007).
    const result = (await messagesOf(dm)).find((m) => m.id === job.resultMessageId);
    expect(result.text).toContain(`<untrusted source="job output" job="${job.id}">`);
    expect(result.text).toContain('built-ok');
    await waitTurn(crew.api, dm.id, result.seq);
  });

  it('lets recall walk from that event to the job another chat ran, since its result reached this chat’s Worker (ADR 004 × 005)', async () => {
    const t = (await jobTriggers()).find((x) => !x.explicit);
    const jobId = t.related[0];
    const ev = await recall(t.id, group);
    expect(ev.status).toBe(200);
    expect(ev.text).toContain(`- related ${jobId}:`);
    expect(ev.text).toContain(`<untrusted source="trigger" id="${t.id}">`);
    const j = await recall(jobId, group);
    expect(j.status).toBe(200);
    expect(j.text.split('\n')[0]).toBe(`[job ${jobId}] Demo build`);
    expect(j.text).toContain(`<untrusted source="job" id="${jobId}">`);
    expect(j.text).toContain('built-ok');
    // A chat whose Workers never got its result does not see it, as before (ADR 005).
    expect((await recall(jobId, other)).status).toBe(404);
  });

  it('holds the command guard for Workers, background commands and sub-tasks alike, and names each in the audit log (ADR 007)', async () => {
    const sent = await send(group, 'Make a footer change and push it twice');
    pusher = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'done');
    const byWorker = (await audit()).filter((e) => e.event === 'blocked' && e.actor.workerId === pusher.id);
    expect(byWorker).toHaveLength(2);
    expect(byWorker[0]).toMatchObject({ rule: 'external', command: 'git push origin HEAD', actor: { chatId: group.id } });
    await settle();

    // A background command the guard refuses is never started.
    const before = (await jobsOf(dm)).length;
    const asked = await send(dm, 'Run `git push origin main` in the background');
    const reply = await waitTurn(crew.api, dm.id, asked.seq);
    expect(reply.text).toMatch(/^Couldn't start it: Not started\./);
    expect(await jobsOf(dm)).toHaveLength(before);
    expect((await audit()).find((e) => e.event === 'blocked' && e.command === 'git push origin main' && e.actor.chatId === dm.id && !e.actor.jobId)).toBeTruthy();

    // A sub-task is refused inside its own session, and the audit log names its job.
    await send(dm, 'Run a sub-task: `push the branch`');
    const sub = await waitFor(async () => (await jobsOf(dm)).find((j) => j.kind === 'task' && j.status === 'done'), 30_000);
    expect((await audit()).find((e) => e.event === 'blocked' && e.actor.jobId === sub.id)).toMatchObject({ rule: 'external', actor: { chatId: dm.id } });
    await waitFor(async () => (await messagesOf(dm)).some((m) => m.role === 'bot' && m.trigger?.jobId === sub.id && m.status === 'done'), 30_000);
  });

  it('reads the audit log and the friction log, and its notice is recallable in the chat it told (ADR 005 × 006 × 007)', async () => {
    // An approval the user denied, as Crew records it.
    fs.appendFileSync(
      path.join(crew.home, 'friction.jsonl'),
      `${JSON.stringify({ at: Date.now(), kind: 'approval-denied', key: 'Bash(rm -rf dist)', detail: 'Denied: rm -rf dist', chatId: group.id, chatTitle: group.title, botName: 'Chief' })}\n`,
    );
    const t = await tickNow();
    // One refusal is the guard doing its job; the Worker refused twice is flagged.
    expect(t.flags).toEqual(expect.arrayContaining([`guard:${pusher.id}`, 'friction:approval-denied']));
    expect(t.flags.filter((f: string) => f.startsWith('guard:'))).toEqual([`guard:${pusher.id}`]);

    const o = await crew.api('GET', '/watchdog');
    const told = o.actions.find((a: any) => a.kind === 'notify' && a.chatId === group.id && !a.refused);
    expect(told.text).toContain(`refused ${pusher.id} 2 times`);
    // The group is in two-layer mode: its Router got the notice as an environment event under the action's id.
    await waitFor(async () => (await routerBatches()).flat().includes(told.id), 30_000);
    await settle();

    const a = await recall(told.id, group);
    expect(a.status).toBe(200);
    expect(a.text.split('\n')[0]).toBe(`[watchdog action ${told.id}] The Watchdog told ${group.id}`);
    expect(a.text).toContain(`- tick ${t.id}:`);
    expect(a.text).toContain(`<untrusted source="watchdog action" id="${told.id}">`);
    const tick = await recall(t.id, group);
    expect(tick.text).toContain(`guard:${pusher.id}`);
    expect(tick.text).toContain(`- action ${told.id}:`);
    const wd = await recall('watchdog', group);
    expect(wd.text).toMatch(/^\[watchdog watchdog\] Crew's Watchdog\nstate: idle/);
    expect(wd.text).toContain(`- action ${told.id}:`);
    // Another chat's agents do not see the Watchdog's dealings with this one.
    expect((await recall(told.id, other)).status).toBe(404);
  });

  it('links a Worker to what the Watchdog did to it, and the note it got names the action (ADR 005 × 006)', async () => {
    const sent = await send(group, 'Build a slow drift page');
    const w = await workerWhere((x) => x.related.includes(sent.id) && x.status === 'running');
    const t = await tickNow();
    const stop = (await crew.api('GET', '/watchdog')).actions.find((a: any) => a.kind === 'stop' && a.target === w.id && !a.refused);
    expect(stop.tickId).toBe(t.id);
    await workerWhere((x) => x.id === w.id && x.status === 'done' && x.turns === 2);
    const r = await recall(w.id, group);
    expect(r.text).toContain(`- watchdog ${stop.id}: stop`);
    const s = await recall(stop.id, group);
    expect(s.text).toContain(`- target ${w.id}:`);
  });
});

describe.skipIf(!claudeCli())('per-role model routing through the gateway (real Claude Code, ADR 002 × 006 × 009)', () => {
  const KEY = 'mock-provider-key';
  let mock: MockProvider;
  let crew: CrewServer;
  let group: any;
  const ROUTER = 'coordinator of the group chat';
  const WORKER = 'You are working as a Worker';
  const WATCHDOG = "You are Crew's Watchdog";

  beforeAll(async () => {
    mock = await startMockProvider({
      token: KEY,
      reply: (r) => {
        const system = JSON.stringify(r.body.system || '');
        const messages = JSON.stringify(r.body.messages || []);
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
        providers: [{ id: 'acct', baseUrl: mock.url, models: ['light-model', 'strong-model', 'watch-model'] }],
        groups: [
          { id: 'light', members: ['acct/light-model'] },
          { id: 'strong', members: ['acct/strong-model'] },
          { id: 'watch', members: ['acct/watch-model'] },
        ],
        defaultTarget: 'strong',
        roles: { router: 'light', worker: 'strong', watchdog: 'watch' },
      },
      gatewayTokens: { acct: KEY },
    });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true }, watchdog: { enabled: true } } });
    group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('sends the Router to its light route, its Worker to the strongest and the Watchdog to its own, each attributed to its role', async () => {
    await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Make the header blue' });
    await waitFor(async () => (await crew.api('GET', `/workers?chatId=${group.id}`)).items.find((w: any) => w.status === 'done'), 120_000);
    const r = await crew.api('POST', '/watchdog/tick');
    expect(r.tick.outcome).toBe('ran');
    await waitFor(async () => {
      const o = await crew.api('GET', '/watchdog');
      return o.state !== 'thinking' && o.ticks.find((x: any) => x.id === r.tick.id)?.messageId;
    }, 120_000);

    const calls = mock.requests.filter((x) => x.url.startsWith('/v1/messages') && !x.url.includes('count_tokens'));
    // Only the provider's key reaches it, never a session's scope credential.
    expect(calls.every((x) => x.auth === `Bearer ${KEY}`)).toBe(true);
    const of = (marker: string) => calls.filter((x) => JSON.stringify(x.body.system || '').includes(marker));
    for (const [marker, model] of [
      [ROUTER, 'light-model'],
      [WORKER, 'strong-model'],
      [WATCHDOG, 'watch-model'],
    ]) {
      expect(of(marker).length).toBeGreaterThan(0);
      expect(of(marker).map((x) => x.model)).toEqual(of(marker).map(() => model));
    }
    const g = await crew.api('GET', '/gateway');
    const byRole = (role: string) => g.calls.filter((c: any) => c.role === role);
    expect(byRole('router').length).toBeGreaterThan(0);
    expect(byRole('router').every((c: any) => c.target === 'light' && c.provider === 'acct' && c.outcome === 'ok')).toBe(true);
    expect(byRole('worker').some((c: any) => c.target === 'strong' && c.botId)).toBe(true);
    expect(byRole('watchdog').some((c: any) => c.target === 'watch' && !c.botId)).toBe(true);
  });
});
