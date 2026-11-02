// The Trigger bus: off by default and invisible; on, every input becomes a trigger in a thread, the
// fast path settles explicit requests and noise, and the slow path (the demo stand-in, or a mock
// model below) decides the rest, telling the user with a note only they see.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

const consoleError = (projectId: string, chatId: string, text: string, level = 'error') => ({ projectId, chatId, page: '/', entries: [{ level, text, ts: Date.now() }] });

async function triggers(crew: CrewServer, query = '') {
  return crew.api<{ enabled: boolean; triggers: any[]; threads: Record<string, any>; stats: any }>('GET', `/triggers${query}`);
}

async function decided(crew: CrewServer, id: string) {
  return waitFor(async () => {
    const d = await crew.api('GET', `/triggers/${id}`);
    return d.trigger?.filter.stage === 'slow' ? d : null;
  });
}

describe('in demo mode', () => {
  let crew: CrewServer;
  let group: any;
  let project: any;
  let bots: Record<string, any>;

  async function say(text: string) {
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text });
    await waitTurn(crew.api, group.id, sent.seq);
    return sent;
  }

  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    project = b.projects.find((p: any) => p.id === group.projectId) ?? b.projects[0];
    bots = Object.fromEntries(b.bots.map((x: any) => [x.name, x]));
  });
  afterAll(() => crew?.stop());

  it('records nothing and creates nothing while off (the default)', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.superAgent.enabled).toBe(false);
    await say('Hello');
    expect((await crew.api('POST', '/triggers/preview-console', consoleError(project.id, group.id, 'TypeError: boom'))).trigger).toBeNull();
    const list = await triggers(crew);
    expect(list.enabled).toBe(false);
    expect(list.triggers).toEqual([]);
    expect(fs.existsSync(path.join(crew.home, 'triggers'))).toBe(false);
  });

  it('puts a message and the turns it caused on the chat thread, acted on by the fast path', async () => {
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
    const sent = await say('Split this task up and hand off to a teammate');
    const { triggers: list, threads } = await triggers(crew);
    const user = list.find((t) => t.source === 'user');
    expect(user).toMatchObject({ explicit: true, ref: { kind: 'message', chatId: group.id, messageId: sent.id }, action: 'Sent to Chief' });
    expect(user.filter).toMatchObject({ verdict: 'act', stage: 'fast', rule: 'explicit-request' });
    expect(threads[user.threadId]).toMatchObject({ key: `chat:${group.id}`, kind: 'chat', title: group.title });
    const turns = list.filter((t) => t.source === 'turn').reverse();
    // Chief handed off (an explicit request to Pixel), Pixel reported back (and the lead may be woken after).
    expect(turns.slice(0, 2).map((t) => [t.summary.split(':')[0], t.filter.rule, t.action])).toEqual([
      ['Chief', 'explicit-request', 'Handed to Pixel'],
      ['Pixel', 'reported-back', undefined],
    ]);
    for (const t of turns) {
      expect(t.threadId).toBe(user.threadId);
      expect(t.related).toEqual([user.id]);
    }
  });

  it('records routine runs, and the turns they start, on the routine thread', async () => {
    const routine = await crew.api('POST', '/routines', { name: 'Morning check', botId: bots.Chief.id, chatId: group.id, prompt: 'Check the home page', trigger: { type: 'manual' } });
    await crew.api('POST', `/routines/${routine.id}/run`);
    const run = await waitFor(async () => (await triggers(crew, '?source=routine')).triggers[0]);
    expect(run).toMatchObject({ explicit: true, ref: { kind: 'routine', routineId: routine.id, chatId: group.id } });
    expect(run.summary).toBe('Routine "Morning check" ran by hand: Check the home page');
    const turn = await waitFor(async () => (await triggers(crew, '?source=turn')).triggers.find((t) => t.threadId === run.threadId));
    expect(turn.related).toEqual([run.id]);
    expect((await crew.api('GET', `/triggers/${run.id}`)).thread).toMatchObject({ key: `routine:${routine.id}`, title: 'Routine: Morning check' });
  });

  it('records edits made outside the chat on the workspace thread, with the note as payload', async () => {
    // Files that change within seconds of a bot's turn are the bot's, not outside edits.
    await new Promise((r) => setTimeout(r, 4500));
    fs.writeFileSync(path.join(project.path, 'notes.txt'), 'hello\n');
    const edit = await waitFor(async () => (await triggers(crew, '?source=outside-edit')).triggers[0], 20_000);
    expect(edit.summary).toBe(`1 file changed outside the chat in ${project.name}: notes.txt`);
    expect(edit.related.length).toBeGreaterThan(0);
    const d = await decided(crew, edit.id);
    expect(d.thread).toMatchObject({ key: `workspace:${project.id}`, kind: 'workspace' });
    expect(d.detail).toContain('notes.txt: new file');
    // The demo filter sees nothing that reads like an error: quiet.
    expect(d.trigger.filter).toMatchObject({ verdict: 'drop', stage: 'slow', slow: { backend: 'fake' } });
  });

  it('lets the slow path decide a console error and tells the user with a note bots never see', async () => {
    const r = await crew.api('POST', '/triggers/preview-console', consoleError(project.id, group.id, 'TypeError: x is undefined at app.js:12:5'));
    expect(r.trigger.filter).toMatchObject({ verdict: 'candidate', stage: 'fast' });
    const d = await decided(crew, r.trigger.id);
    expect(d.trigger.filter).toMatchObject({ verdict: 'act', rule: 'policy', slow: { backend: 'fake', batch: 1, costUsd: 0 } });
    expect(d.thread.key).toBe(`workspace:${project.id}`);
    expect(d.detail).toBe('Page /\n[error] TypeError: x is undefined at app.js:12:5');
    const { messages } = await crew.api('GET', `/chats/${group.id}/messages?limit=10`);
    const note = messages.find((m: any) => m.id === d.trigger.filter.delivered.messageId);
    expect(note).toMatchObject({ role: 'system', uiOnly: true, notice: 'trigger' });
    expect(note.text).toContain(`(${r.trigger.id} in Triggers)`);
  });

  it('settles warnings, noise and a repeat in a thread that was just told, without a model', async () => {
    const calls = (await triggers(crew)).stats.slowCalls;
    const post = async (text: string, level?: string) => (await crew.api('POST', '/triggers/preview-console', consoleError(project.id, group.id, text, level))).trigger;
    expect((await post('Deprecated API', 'warn')).filter.rule).toBe('no-errors');
    expect((await post('GET /favicon.ico 404 (Not Found)')).filter.rule).toBe('known-noise');
    expect((await post('TypeError: x is undefined at app.js:40:9')).filter.rule).toBe('cooldown');
    expect((await triggers(crew)).stats.slowCalls).toBe(calls);
  });

  it('starts a new chat thread with a new topic, and ignores a source set to ignore', async () => {
    const old = (await triggers(crew, '?source=user')).triggers[0].threadId;
    await crew.api('POST', `/chats/${group.id}/reset`);
    await say('Hello again');
    const { triggers: list, threads } = await triggers(crew, '?source=user');
    expect(list[0].threadId).not.toBe(old);
    expect(threads[old].closedAt).toBeTruthy();

    const s = await crew.api('PATCH', '/settings', { superAgent: { sources: { 'preview-console': { mode: 'ignore' } } } });
    // A patch to one source keeps the others and the switch.
    expect(s.settings.superAgent).toMatchObject({ enabled: true, sources: { 'preview-console': { mode: 'ignore' }, turn: { mode: 'candidate' } } });
    expect((await crew.api('POST', '/triggers/preview-console', consoleError(project.id, group.id, 'RangeError: new'))).trigger).toBeNull();
  });

  it('refuses malformed settings and console reports', async () => {
    expect((await crew.api('PATCH', '/settings', { superAgent: { sources: { turn: { mode: 'sometimes' } } } })).status).toBe(400);
    expect((await crew.api('POST', '/triggers/preview-console', { projectId: project.id, entries: [] })).status).toBe(400);
    expect((await crew.api('GET', '/triggers/tg_nope')).status).toBe(404);
  });
});

it('keeps the log across a restart and settles decisions a restart cut off', async () => {
  const dir = tempDir();
  try {
    let crew = await startServer({ dir });
    const b = await crew.api('GET', '/bootstrap');
    const chat = b.chats.find((c: any) => c.kind === 'group');
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
    const sent = await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'Hello' });
    await waitTurn(crew.api, chat.id, sent.seq);
    const before = (await triggers(crew)).triggers;
    await crew.kill();
    crew = await startServer({ dir });
    const after = await triggers(crew);
    expect(after.triggers.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(Object.keys(after.threads)).toHaveLength(1);
    await crew.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!claudeCli())('slow path with a model', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let answer: (ids: string[]) => string;
  let project: any;
  let group: any;

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        const text = JSON.stringify(r.body.messages || []);
        if (!text.includes('<policies>')) return { text: 'OK.' };
        return { text: answer([...text.matchAll(/<event id=\\"(tg_\w+)\\"/g)].map((m) => m[1])) };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, policies: 'Tell me about TypeErrors from my own code.' } });
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    project = b.projects.find((p: any) => p.id === group.projectId);
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  // First: an unusable answer posts no notice, so the thread is not in its cooldown for the next test.
  it('stays quiet on an answer it cannot use', async () => {
    answer = () => 'Both look important to me.';
    const r = await crew.api('POST', '/triggers/preview-console', consoleError(project.id, group.id, 'ReferenceError: total is not defined'));
    const d = await decided(crew, r.trigger.id);
    expect(d.trigger.filter).toMatchObject({ verdict: 'drop', rule: 'invalid' });
    expect(d.trigger.filter.delivered).toBeUndefined();
  });

  it('asks a bare cheap call with the policies and the fenced event, and acts on the answer', async () => {
    answer = (ids) => JSON.stringify({ decisions: ids.map((id) => ({ id, act: true, reason: 'A TypeError in the app.' })) });
    const r = await crew.api('POST', '/triggers/preview-console', consoleError(project.id, group.id, 'TypeError: cart is undefined'));
    const d = await decided(crew, r.trigger.id);
    expect(d.trigger.filter).toMatchObject({ verdict: 'act', rule: 'policy', reason: 'A TypeError in the app.', slow: { backend: 'haiku', batch: 1 } });
    const ask = mock.requests.find((q) => JSON.stringify(q.body.messages ?? []).includes(r.trigger.id))!;
    expect(ask.tools).toEqual([]);
    expect(JSON.stringify(ask.body.system)).toContain('event filter');
    const prompt = JSON.stringify(ask.body.messages);
    expect(prompt).toContain('Tell me about TypeErrors from my own code.');
    expect(prompt).toContain(`<event id=\\"${r.trigger.id}\\" source=\\"preview-console\\"`);
    expect(prompt).toContain('TypeError: cart is undefined');
    const { messages } = await crew.api('GET', `/chats/${group.id}/messages?limit=10`);
    expect(messages.some((m: any) => m.id === d.trigger.filter.delivered.messageId && m.uiOnly)).toBe(true);
  });
});
