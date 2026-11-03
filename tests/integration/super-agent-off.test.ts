// With every setting the Super-agent milestones added switched off, Crew behaves as it did before
// them (ADR 010): no new process (no gateway listener, no Watchdog timer, no Router, Worker or
// background job), no new file or folder in the data folder, and no model call beyond the bot's
// own turn, whose tools are the ones it had before. A crash and restart with everything off recovers
// nothing new either (ADR 105). The second wave adds to the list (ADR 011): no speculative run, no
// GitHub poller and no `gh` process, no webhook delivery, and no channel shape on any reply.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeGh, fakeGh } from '../helpers/fakeGh';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type Api, type CrewServer, claudeCli, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

/** What the milestones write in the data folder, each only once its feature is on. */
const NEW_ENTRIES = ['triggers', 'workers.json', 'router', 'jobs', 'watchdog', 'gateway', 'drafts.json', 'audit.jsonl', 'speculative', 'github'];
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
  expect(b.speculations).toEqual([]);
  expect((await api('GET', '/speculations')).speculations).toEqual([]);
  expect((await api('GET', '/gateway')).running).toBe(false);
  const wd = await api('GET', '/watchdog');
  expect(wd).toMatchObject({ enabled: false, state: 'off', ticksLastHour: 0 });
  expect(wd.nextTickAt).toBeUndefined();
  expect(await api('GET', '/triggers')).toMatchObject({ enabled: false, triggers: [], stats: { total: 0 } });
  expect((await api('GET', '/audit')).entries).toEqual([]);
  expect((await api('GET', `/recall/chat?chatId=${b.chats[0].id}`)).status).toBe(404);
  // The second wave (ADR 011): no project polls GitHub, no webhook is set, and no reply carries a channel shape.
  expect((await api('GET', '/github')).projects.every((p: any) => !p.active && !p.lastPollAt)).toBe(true);
  for (const p of b.projects.filter((x: any) => !x.workspace)) expect(await api('GET', `/projects/${p.id}/webhook`)).toMatchObject({ configured: false, enabled: false, deliveries: [] });
  for (const c of b.chats) expect((await api('GET', `/chats/${c.id}/messages?limit=200`)).messages.some((m: any) => m.channel || m.notice === 'speculative')).toBe(false);
  expect(newFiles(crew.home)).toEqual([]);
}

describe('everything off (demo mode)', () => {
  const dir = tempDir('crew-off');
  let crew: CrewServer;
  // A `gh` on PATH that logs every call: with the GitHub channel off, nothing ever runs it.
  let gh: FakeGh;

  beforeAll(async () => {
    gh = fakeGh();
    crew = await startServer({ dir, env: { PATH: gh.path } });
  });
  afterAll(async () => {
    await crew?.stop();
    gh?.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts with every new switch off, except the guard and stripping, which only refuse and remove', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.superAgent).toMatchObject({ enabled: false, router: { enabled: false, subscriptions: false }, recall: { enabled: false }, watchdog: { enabled: false } });
    expect(b.settings.gateway).toMatchObject({ enabled: false, masking: false });
    expect(b.settings.safety).toEqual({ guard: true, stripCredentials: true, audit: false });
    expect(b.bots.every((x: any) => !x.fullDuplex)).toBe(true);
    expect(b.projects.every((p: any) => !p.skillFamilies?.length && !p.passEnv?.length && !p.speculative && !p.github)).toBe(true);
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
    expect(reply.channel).toBeUndefined();
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
    // A message that reads like a bug report starts no speculative run, and nothing ever ran gh.
    const bug = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'The header is broken, it shows an error' });
    await waitTurn(crew.api, group.id, bug.seq);
    await new Promise((res) => setTimeout(res, 1500));
    expect(gh.calls()).toEqual([]);
    await expectNothingNew(crew);
  });

  it('starts again after a crash without recovering, writing or starting anything new (ADR 105)', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const group = b.chats.find((c: any) => c.kind === 'group');
    // Killed in the middle of a turn: the recovery added for the Super-agent finds nothing of its own to do.
    await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Build a footer' });
    await waitFor(async () => (await crew.api('GET', `/chats/${group.id}/messages?limit=5`)).messages.some((m: any) => m.role === 'bot'), 20_000);
    await crew.kill();
    crew = await startServer({ dir, env: { PATH: gh.path } });
    expect(crew.log()).not.toMatch(/\[(watchdog|jobs|layers|triggers|speculative|github)\]/);
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Build a header' });
    expect((await waitTurn(crew.api, group.id, sent.seq)).router).toBeUndefined();
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
    for (const marker of ['You filter events for Crew', 'coordinator of the group chat', 'You are working as a Worker', "You are Crew's Watchdog", 'You are a speculative background run']) {
      expect(systems.some((s) => s.includes(marker))).toBe(false);
    }
    // The main loop's tools: chat_history as before; no recall, no background jobs, no thread tools.
    const main = calls.filter((r) => r.tools.includes('Bash'));
    expect(main.length).toBeGreaterThan(0);
    for (const r of main) {
      expect(r.tools).toContain('mcp__crew__chat_history');
      for (const t of ['mcp__crew__recall', 'mcp__crew__start', 'mcp__crew__stop', 'mcp__crew__status', 'mcp__crew__hand_back', 'mcp__crew__unsubscribe_thread', 'mcp__crew__speculative_result'])
        expect(r.tools).not.toContain(t);
    }
    await expectNothingNew(crew);
  });
});
