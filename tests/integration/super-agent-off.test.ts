// With every setting the Super-agent milestones added switched off, Crew behaves as it did before
// them (ADR 010): no new process (no gateway listener, no Watchdog timer, no Router, Worker or
// background job), no new file or folder in the data folder, and no model call beyond the bot's
// own turn, whose tools are the ones it had before.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type Api, type CrewServer, claudeCli, startServer, waitFor, waitTurn } from '../helpers/server';

/** What the milestones write in the data folder, each only once its feature is on. */
const NEW_ENTRIES = ['triggers', 'workers.json', 'router', 'jobs', 'watchdog', 'gateway', 'drafts.json', 'audit.jsonl'];
/** Their logs beside the chats' in messages/: a Router's, a Worker's, a sub-task's, the Watchdog's. */
const NEW_LOGS = /^(rt_|wk_|job_|watchdog)/;

function newFiles(home: string): string[] {
  const logs = fs.readdirSync(path.join(home, 'messages')).filter((f) => NEW_LOGS.test(f));
  return [...NEW_ENTRIES.filter((f) => fs.existsSync(path.join(home, f))), ...logs.map((f) => `messages/${f}`)];
}

/** Every switch the milestones added, off; the guard and stripping too, which are on by default. */
const ALL_OFF = {
  superAgent: { enabled: false, router: { enabled: false, subscriptions: false }, recall: { enabled: false }, watchdog: { enabled: false } },
  gateway: { enabled: false, masking: false },
  safety: { guard: false, stripCredentials: false, audit: false },
};

/** Nothing of the Super-agent runs, is recorded or is written. */
async function expectNothingNew(crew: CrewServer) {
  const api: Api = crew.api;
  const b = await api('GET', '/bootstrap');
  expect(b.routers).toEqual([]);
  expect(b.workers).toEqual([]);
  expect(b.jobs).toEqual([]);
  expect(b.drafts).toEqual([]);
  expect((await api('GET', '/gateway')).running).toBe(false);
  const wd = await api('GET', '/watchdog');
  expect(wd).toMatchObject({ enabled: false, state: 'off', ticksLastHour: 0 });
  expect(wd.nextTickAt).toBeUndefined();
  expect(await api('GET', '/triggers')).toMatchObject({ enabled: false, triggers: [], stats: { total: 0 } });
  expect((await api('GET', '/audit')).entries).toEqual([]);
  expect((await api('GET', `/recall/chat?chatId=${b.chats[0].id}`)).status).toBe(404);
  expect(newFiles(crew.home)).toEqual([]);
}

describe('everything off (demo mode)', () => {
  let crew: CrewServer;

  beforeAll(async () => {
    crew = await startServer();
  });
  afterAll(() => crew?.stop());

  it('starts with every new switch off, except the guard and stripping, which only refuse and remove', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.superAgent).toMatchObject({ enabled: false, router: { enabled: false, subscriptions: false }, recall: { enabled: false }, watchdog: { enabled: false } });
    expect(b.settings.gateway).toMatchObject({ enabled: false, masking: false });
    expect(b.settings.safety).toEqual({ guard: true, stripCredentials: true, audit: false });
    expect(b.bots.every((x: any) => !x.fullDuplex)).toBe(true);
    expect(b.projects.every((p: any) => !p.skillFamilies?.length && !p.passEnv?.length)).toBe(true);
    await expectNothingNew(crew);
  });

  it('runs a direct chat, a group chat, a routine and an outside edit without a new process, file or record', async () => {
    const s = await crew.api('PATCH', '/settings', ALL_OFF);
    expect(s.settings.safety).toEqual({ guard: false, stripCredentials: false, audit: false });
    const b = await crew.api('GET', '/bootstrap');
    const group = b.chats.find((c: any) => c.kind === 'group');
    const project = b.projects.find((p: any) => p.id === group.projectId) ?? b.projects[0];
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);

    const direct = await crew.api('POST', `/chats/${dm.id}/messages`, { text: 'Build a page, in the background if you can' });
    expect((await waitTurn(crew.api, dm.id, direct.seq)).status).toBe('done');
    // The group's lead answers, as before: no Router, no Worker.
    const asked = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Build a header' });
    const reply = await waitTurn(crew.api, group.id, asked.seq);
    expect(reply).toMatchObject({ status: 'done', botId: group.leadBotId });
    expect(reply.router).toBeUndefined();
    const r = await crew.api('POST', '/routines', { name: 'Check', botId: group.leadBotId, chatId: group.id, prompt: 'Check the links', trigger: { type: 'daily', time: '03:00' } });
    const before = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.at(-1).seq;
    await crew.api('POST', `/routines/${r.id}/run`);
    await waitTurn(crew.api, group.id, before);
    // Files that change within seconds of a bot's turn are the bot's, not outside edits.
    await new Promise((res) => setTimeout(res, 4500));
    fs.writeFileSync(path.join(project.path, 'notes.txt'), 'hello\n');
    await waitFor(async () => (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.some((m: any) => m.notice === 'outside-edit'), 20_000);
    // A console error the preview would forward is not recorded either.
    expect(
      (await crew.api('POST', '/triggers/preview-console', { projectId: project.id, chatId: group.id, page: '/', entries: [{ level: 'error', text: 'TypeError: boom', ts: Date.now() }] })).trigger,
    ).toBeNull();
    // The demo bot was not offered the full-duplex tools: it did the work itself.
    expect((await waitTurn(crew.api, dm.id, direct.seq)).parts.some((p: any) => p.type === 'tool' && String(p.name).includes('start'))).toBe(false);
    await expectNothingNew(crew);
  });
});

describe.skipIf(!claudeCli())('everything off (real Claude Code and a mock model)', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;

  beforeAll(async () => {
    mock = await startMockProvider({ token: TOKEN, reply: () => ({ text: 'OK.' }) });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    await crew.api('PATCH', '/settings', ALL_OFF);
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it("calls the model only for the bot's own turn, with the tools it had before", async () => {
    const b = await crew.api('GET', '/bootstrap');
    const group = b.chats.find((c: any) => c.kind === 'group');
    mock.requests.length = 0;
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Say hello in one line' });
    expect((await waitTurn(crew.api, group.id, sent.seq, 120_000)).status).toBe('done');
    // Anything the filter, a Router, a Worker or the Watchdog would have sent arrives within a moment.
    await new Promise((r) => setTimeout(r, 1500));
    const calls = mock.requests.filter((r) => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'));
    expect(calls.length).toBeGreaterThan(0);
    const systems = calls.map((r) => JSON.stringify(r.body.system || ''));
    for (const marker of ['You filter events for Crew', 'coordinator of the group chat', 'You are working as a Worker', "You are Crew's Watchdog"]) {
      expect(systems.some((s) => s.includes(marker))).toBe(false);
    }
    // The main loop's tools: chat_history as before; no recall, no background jobs, no thread tools.
    const main = calls.filter((r) => r.tools.includes('Bash'));
    expect(main.length).toBeGreaterThan(0);
    for (const r of main) {
      expect(r.tools).toContain('mcp__crew__chat_history');
      for (const t of ['mcp__crew__recall', 'mcp__crew__start', 'mcp__crew__stop', 'mcp__crew__status', 'mcp__crew__hand_back', 'mcp__crew__unsubscribe_thread']) expect(r.tools).not.toContain(t);
    }
    await expectNothingNew(crew);
  });
});
