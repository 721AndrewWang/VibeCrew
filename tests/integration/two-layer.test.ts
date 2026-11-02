// Two-layer mode (ADR 002): off by default and invisible; on, a group chat's messages go to its
// Router, which dispatches Workers that run in their own worktrees, never post in the chat, and
// report back; the Router replies, and stays free to answer while they work.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, type MockRequest, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

async function chatMessages(crew: CrewServer, chatId: string): Promise<any[]> {
  return (await crew.api('GET', `/chats/${chatId}/messages?limit=200`)).messages;
}

async function chatWorkers(crew: CrewServer, chatId: string): Promise<any[]> {
  return (await crew.api('GET', `/workers?chatId=${chatId}`)).items;
}

/** The Router's replies after `seq` once there are at least `n`. */
async function replies(crew: CrewServer, chatId: string, seq: number, n = 1): Promise<any[]> {
  return waitFor(async () => {
    const list = (await chatMessages(crew, chatId)).filter((m) => m.seq > seq && m.router);
    return list.length >= n ? list : null;
  }, 30_000);
}

async function workerWhere(crew: CrewServer, chatId: string, pred: (w: any) => boolean): Promise<any> {
  return waitFor(async () => (await chatWorkers(crew, chatId)).find(pred), 30_000);
}

/** Waits until no Worker of the chat is active and its Router has nothing to do. */
async function settle(crew: CrewServer, chatId: string) {
  await waitFor(async () => {
    const b = await crew.api('GET', '/bootstrap');
    const r = b.routers.find((x: any) => x.chatId === chatId);
    const busy = b.workers.some((w: any) => w.chatId === chatId && ['starting', 'running', 'waiting'].includes(w.status));
    return !busy && (!r || (r.state !== 'thinking' && r.queued === 0));
  }, 40_000);
}

describe('in demo mode', () => {
  let crew: CrewServer;
  let group: any;
  let bots: Record<string, any>;

  const send = (text: string) => crew.api('POST', `/chats/${group.id}/messages`, { text });

  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    bots = Object.fromEntries(b.bots.map((x: any) => [x.name, x]));
  });
  afterAll(() => crew?.stop());

  it('leaves the lead in charge while off (the default), even with the Super-agent on', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.superAgent.router).toEqual({ enabled: false, model: 'claude-sonnet-5', workerModel: '', maxWorkers: 3 });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
    const sent = await send('Hello');
    const reply = await waitTurn(crew.api, group.id, sent.seq);
    expect(reply).toMatchObject({ role: 'bot', botId: group.leadBotId });
    expect(reply.router).toBeUndefined();
    expect(await chatWorkers(crew, group.id)).toEqual([]);
    expect((await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === group.id).workspaceId).toBeFalsy();
    expect(fs.existsSync(path.join(crew.home, 'workers.json'))).toBe(false);
  });

  it('sends messages to the Router, which dispatches a Worker in a worktree of its own and tells the user how it went', async () => {
    const s = await crew.api('PATCH', '/settings', { superAgent: { router: { enabled: true } } });
    // A patch to the Router keeps the rest of the Super-agent's settings.
    expect(s.settings.superAgent).toMatchObject({ enabled: true, router: { enabled: true, model: 'claude-sonnet-5', maxWorkers: 3 }, sources: { turn: { mode: 'candidate' } } });
    const sent = await send('Build a pricing page');
    const started = await replies(crew, group.id, sent.seq);
    expect(started[0]).toMatchObject({ role: 'bot', botId: group.leadBotId, status: 'done' });
    expect(started[0].text).toMatch(/^On it\. Started wk_/);

    const w = await workerWhere(crew, group.id, (x) => x.status === 'done');
    expect(w).toMatchObject({ botId: group.leadBotId, title: 'Build a pricing page', turns: 1 });
    expect(w.related).toContain(sent.id);
    // The chat moved into a workspace of its own; the Worker got a worktree branched from it.
    const b = await crew.api('GET', '/bootstrap');
    const chat = b.chats.find((c: any) => c.id === group.id);
    const chatWs = b.projects.find((p: any) => p.id === chat.workspaceId);
    const workerWs = b.projects.find((p: any) => p.id === w.projectId);
    expect(chatWs.workspace.workerId).toBeUndefined();
    expect(workerWs.workspace).toMatchObject({ workerId: w.id, chatId: group.id, baseBranch: chatWs.workspace.branch });
    expect(workerWs.path).not.toBe(chatWs.path);
    // Its change was merged into the chat's branch.
    expect(w.landing.files).toHaveLength(1);
    expect(w.landing.files[0]).toMatch(/^crew-demo-\w+\.md$/);
    expect(fs.existsSync(path.join(chatWs.path, w.landing.files[0]))).toBe(true);

    // Its turns are in its own log, never in the chat; the Router told the user it finished.
    const log = await crew.api('GET', `/workers/${w.id}/messages`);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0].parts.some((p: any) => p.type === 'tool' && p.name === 'Write')).toBe(true);
    const done = await replies(crew, group.id, sent.seq, 2);
    expect(done[1].text).toContain('finished: "Build a pricing page"');
    const after = (await chatMessages(crew, group.id)).filter((m) => m.seq > sent.seq && m.role === 'bot');
    expect(after.every((m) => m.router)).toBe(true);

    // The Router's turns are logged with the events they handled.
    const routerLog = await crew.api('GET', `/chats/${group.id}/router/messages`);
    expect(routerLog.messages.length).toBeGreaterThanOrEqual(2);
    expect(routerLog.messages[0].batch).toEqual([sent.id]);
    expect(routerLog.messages[0].parts.some((p: any) => p.name === 'mcp__crew_router__dispatch_worker')).toBe(true);
    expect(routerLog.messages.at(-1).batch).toEqual([w.id]);

    // On the Trigger bus: the message went to the Router; the Worker's result went to it directly.
    const { triggers } = await crew.api('GET', '/triggers');
    expect(triggers.find((t: any) => t.source === 'user' && t.ref.messageId === sent.id).action).toBe('Sent to the Router');
    const result = triggers.find((t: any) => t.source === 'turn' && t.ref.chatId === w.id);
    expect(result.filter).toMatchObject({ verdict: 'act', stage: 'fast', rule: 'routed' });
  });

  it('stays responsive while a Worker runs, and stops it when asked', async () => {
    await settle(crew, group.id);
    const sent = await send('@Pixel make a slow change to the header');
    const w = await workerWhere(crew, group.id, (x) => x.title.includes('slow change') && x.status === 'running');
    expect(w.botId).toBe(bots.Pixel.id);
    await replies(crew, group.id, sent.seq);
    const asked = await send('How is it going?');
    const answer = await replies(crew, group.id, asked.seq);
    expect(answer[0].text).toContain('Nothing to dispatch');
    expect((await chatWorkers(crew, group.id)).find((x) => x.id === w.id).status).toBe('running');

    const stopped = await crew.api('POST', `/workers/${w.id}/stop`);
    expect(stopped.status).toBe(200);
    const end = await workerWhere(crew, group.id, (x) => x.id === w.id && x.status === 'stopped');
    expect(end.landing.error).toMatch(/did not finish/);
    // The Router hears about it and says so.
    const told = await replies(crew, group.id, sent.seq, 3);
    expect(told.some((m) => m.text.includes('ended (stopped)'))).toBe(true);
  });

  it('runs Workers side by side, merges both, and batches what arrives while the Router thinks', async () => {
    await settle(crew, group.id);
    const before = (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages.length;
    const a = await send('Split this: build a header and a footer');
    const b = await send('Also, hello');
    const c = await send('And thanks');
    const workers = await waitFor(async () => {
      const list = (await chatWorkers(crew, group.id)).filter((x) => x.related.includes(a.id));
      return list.length === 2 && list.every((x) => x.status === 'done') ? list : null;
    }, 40_000);
    expect(workers.every((x) => x.landing.files.length === 1 && !x.landing.conflicts)).toBe(true);
    const turns = (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages.slice(before);
    // The first message started a turn; the two that came while it ran were handled together.
    expect(turns[0].batch).toEqual([a.id]);
    expect(turns[1].batch).toEqual([b.id, c.id]);
  });

  it('hands an environment event the filter acted on to the Router, which cannot start work for it', async () => {
    await settle(crew, group.id);
    const b = await crew.api('GET', '/bootstrap');
    const project = b.projects.find((p: any) => p.id === b.chats.find((x: any) => x.id === group.id).workspaceId);
    const count = (await chatWorkers(crew, group.id)).length;
    const before = (await chatMessages(crew, group.id)).at(-1).seq;
    const r = await crew.api('POST', '/triggers/preview-console', {
      projectId: project.id,
      chatId: group.id,
      page: '/',
      entries: [{ level: 'error', text: 'TypeError: build is undefined', ts: Date.now() }],
    });
    const t = await waitFor(async () => {
      const d = await crew.api('GET', `/triggers/${r.trigger.id}`);
      return d.trigger.filter.stage === 'slow' ? d.trigger : null;
    });
    expect(t.action).toBe(`Handed to the Router of "${group.title}"`);
    expect(t.filter.delivered).toBeUndefined();
    const told = await replies(crew, group.id, before);
    expect(told[0].text).toContain('Crew noticed: Data from the environment');
    // The demo Router would dispatch for "build", but the gate stops environment-only batches.
    const routerLog = (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages;
    expect(routerLog.at(-1).batch).toEqual([r.trigger.id]);
    expect(await chatWorkers(crew, group.id)).toHaveLength(count);
  });

  it("stops the Router and every Worker with the chat's Stop, without the Router replying", async () => {
    await settle(crew, group.id);
    const sent = await send('Make a slow footer change');
    const w = await workerWhere(crew, group.id, (x) => x.related.includes(sent.id) && x.status === 'running');
    await replies(crew, group.id, sent.seq);
    const n = (await chatMessages(crew, group.id)).length;
    expect((await crew.api('POST', `/chats/${group.id}/stop`)).status).toBe(200);
    await workerWhere(crew, group.id, (x) => x.id === w.id && x.status === 'stopped');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await chatMessages(crew, group.id)).length).toBe(n);
    // A finished Worker can be dismissed: its worktree goes, and it leaves the list.
    expect((await crew.api('POST', `/workers/${w.id}/dismiss`)).status).toBe(200);
    expect((await chatWorkers(crew, group.id)).some((x) => x.id === w.id)).toBe(false);
  });

  it('goes back to the lead when switched off', async () => {
    await crew.api('PATCH', '/settings', { superAgent: { router: { enabled: false } } });
    const sent = await send('Hello once more');
    const reply = await waitTurn(crew.api, group.id, sent.seq);
    expect(reply.router).toBeUndefined();
    expect(reply.botId).toBe(group.leadBotId);
  });
});

describe.skipIf(!claudeCli())('with Claude Code and a mock model', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let group: any;

  /** The text and tool results of the conversation's last user message. */
  const lastUser = (r: MockRequest): { text: string; results: string[] } => {
    const m = [...(r.body.messages || [])].reverse().find((x: any) => x.role === 'user');
    const blocks = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : m?.content || [];
    return { text: blocks.map((b: any) => b.text || '').join('\n'), results: blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => String(b.tool_use_id)) };
  };

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        const system = JSON.stringify(r.body.system || '');
        const last = lastUser(r);
        if (system.includes('coordinator of the group chat')) {
          if (last.results.some((id) => id.startsWith('toolu_dispatch'))) return { tool: { id: 'toolu_reply_1', name: 'mcp__crew_router__reply', input: { text: 'On it: Pixel is on the header.' } } };
          if (last.results.length) return { text: 'Handled.' };
          if (last.text.includes('kind="worker"')) return { tool: { id: 'toolu_reply_2', name: 'mcp__crew_router__reply', input: { text: 'Pixel finished the header.' } } };
          if (last.text.includes('kind="user"'))
            return { tool: { id: 'toolu_dispatch_1', name: 'mcp__crew_router__dispatch_worker', input: { title: 'Header', task: 'Make the header blue.', bot: 'Pixel' } } };
        }
        if (system.includes('You are working as a Worker')) return { text: 'Report: made the header blue.' };
        return { text: 'OK.' };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true, model: 'mock-router', workerModel: 'mock-worker' } } });
    group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('gives the Router only its own tools on its model, and the Worker full tools on the strongest', async () => {
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Make the header blue' });
    const told = await replies(crew, group.id, sent.seq, 2);
    expect(told.map((m) => m.text)).toEqual(['On it: Pixel is on the header.', 'Pixel finished the header.']);
    const w = (await chatWorkers(crew, group.id))[0];
    expect(w).toMatchObject({ title: 'Header', task: 'Make the header blue.', status: 'done', model: 'mock-worker' });
    expect(w.report.text).toBe('Report: made the header blue.');

    const router = mock.requests.filter((r) => JSON.stringify(r.body.system || '').includes('coordinator of the group chat'));
    const worker = mock.requests.filter((r) => JSON.stringify(r.body.system || '').includes('You are working as a Worker'));
    expect(router.length).toBeGreaterThanOrEqual(3);
    expect(worker.length).toBeGreaterThanOrEqual(1);
    for (const r of router) {
      expect(r.model).toBe('mock-router');
      expect(r.tools).toEqual(expect.arrayContaining(['mcp__crew_router__dispatch_worker', 'mcp__crew_router__reply', 'mcp__crew_router__list_workers']));
      expect(r.tools.filter((t) => !t.startsWith('mcp__crew_router__'))).toEqual([]);
    }
    expect(worker[0].model).toBe('mock-worker');
    expect(worker[0].tools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'mcp__crew__preview_screenshot']));
    expect(worker[0].tools).not.toContain('mcp__crew__notify_user');
    // The Worker got the task and the user's own words; the Router got the report back.
    expect(JSON.stringify(worker[0].body.messages)).toContain('Make the header blue.');
    expect(JSON.stringify(router.at(-2)?.body.messages ?? '')).toContain('Report: made the header blue.');
  });
});

it('settles Workers a restart cut off, and tells the Router', async () => {
  const dir = tempDir();
  try {
    let crew = await startServer({ dir });
    const chat = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true } } });
    const sent = await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'Make a slow change' });
    const w = await workerWhere(crew, chat.id, (x) => x.status === 'running');
    await replies(crew, chat.id, sent.seq);
    await crew.kill();
    crew = await startServer({ dir });
    const after = (await chatWorkers(crew, chat.id)).find((x) => x.id === w.id);
    expect(after).toMatchObject({ status: 'stopped', detail: 'Crew restarted' });
    // Its workspace is kept, and the Router is told it was cut off.
    expect((await crew.api('GET', '/bootstrap')).projects.some((p: any) => p.id === w.projectId)).toBe(true);
    const told = await replies(crew, chat.id, sent.seq, 2);
    expect(told.at(-1).text).toContain('ended (stopped)');
    await crew.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
