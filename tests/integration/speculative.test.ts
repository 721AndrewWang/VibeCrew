// Speculative execution (ADR 008), in demo mode: off until a project opts in; then a bug report, a
// console error or a failing check starts a silent background run in a throwaway worktree. Crew
// runs the project's checks itself, surfaces only a fix that passes them (and without which they
// fail), merges it on one click, and discards everything else without a word in the chat.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitFor } from '../helpers/server';

const CHECK = 'sh check.sh';
const CHECK_SH = 'for f in repro/*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done\n';

describe('speculative execution in demo mode', () => {
  let crew: CrewServer;
  let project: any;
  let chat: any;
  let group: any;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: project.path, env: { ...process.env, ...crew.env }, encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string | null>, msg: string) => {
    for (const [rel, text] of Object.entries(files)) {
      const f = path.join(project.path, rel);
      if (text === null) fs.rmSync(f, { force: true });
      else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
      }
    }
    git('add', '-A');
    git('commit', '-qm', msg);
  };
  const runs = async (chatId = chat.id) => (await crew.api('GET', `/speculations?chatId=${chatId}`)).speculations as any[];
  const chatMessages = async (id = chat.id) => (await crew.api('GET', `/chats/${id}/messages?limit=200`)).messages as any[];
  const idle = (id = chat.id) =>
    waitFor(async () => {
      const b = await crew.api('GET', '/bootstrap');
      return !Object.values(b.statuses || {}).some((s: any) => s.chatId === id && s.state !== 'idle');
    }, 30_000);
  /** Sends a message and waits for the speculative run it starts (or the skip it records) to settle. */
  async function report(text: string, done: (s: any) => boolean = (s) => ['ready', 'discarded', 'skipped'].includes(s.status), id = chat.id) {
    const before = new Set((await runs(id)).map((s) => s.id));
    const sent = await crew.api('POST', `/chats/${id}/messages`, { text });
    expect(sent.status).toBe(200);
    const sp = await waitFor(async () => (await runs(id)).find((s) => !before.has(s.id) && done(s)), 60_000).catch((e) => {
      if (process.env.SPEC_DEBUG) console.log(crew.log().slice(-6000));
      throw e;
    });
    await idle(id);
    return sp;
  }
  const branches = () => git('branch', '--list', 'crew/*');

  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    project = b.projects[0];
    group = b.chats.find((c: any) => c.kind === 'group');
    chat = await crew.api('POST', '/chats', { title: 'Bugs', botIds: [group.leadBotId], projectId: project.id });
    commit({ 'app.txt': 'Title: BUG\n', 'check.sh': CHECK_SH }, 'add the app and its checks');
  });
  afterAll(() => crew?.stop());

  it('is off by default: no record, no folder, no Worker, even with the Super-agent on', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.superAgent.speculative).toEqual({ model: '', dailyBudgetUsd: 2, maxConcurrent: 2, maxMinutes: 20 });
    expect(b.speculations).toEqual([]);
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
    await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'The title on the home page is broken, it shows an error' });
    await idle();
    await new Promise((r) => setTimeout(r, 500));
    expect(await runs()).toEqual([]);
    expect(fs.existsSync(path.join(crew.home, 'speculative'))).toBe(false);
    expect(branches()).toBe('');
  });

  it('reproduces a reported problem silently and surfaces a verified fix with its diff', async () => {
    const p = await crew.api('PATCH', `/projects/${project.id}`, { speculative: { enabled: true, checkCommand: CHECK } });
    expect(p.speculative).toEqual({ enabled: true, checkCommand: CHECK, signals: { failingChecks: true, consoleErrors: true, bugReports: true }, maxFixLines: 120 });
    const sp = await report('The home page title looks wrong, it shows a weird word');
    expect(sp).toMatchObject({ status: 'ready', signal: 'bug-report', chatId: chat.id, checkCommand: CHECK, claim: { reproduced: true, testFiles: ['repro/crew-repro.sh'] } });
    expect(sp.reasons[0]).toContain('describes a problem');
    expect(sp.files).toEqual([
      { path: 'app.txt', added: 1, removed: 1, test: false },
      { path: 'repro/crew-repro.sh', added: 1, removed: 0, test: true },
    ]);
    expect(sp.checks.after).toMatchObject({ ok: true, exitCode: 0 });
    expect(sp.checks.before).toMatchObject({ ok: false, exitCode: 1 });
    // The user's folder is untouched until they click.
    expect(fs.readFileSync(path.join(project.path, 'app.txt'), 'utf8')).toBe('Title: BUG\n');
    const diff = (await crew.api('GET', `/speculations/${sp.id}/diff`)).diff;
    expect(diff).toContain('-Title: BUG');
    expect(diff).toContain('+Title: FIXED');
    // A UI-only card in the chat, a recorded Trigger, and nothing in the Workers list.
    const card = (await chatMessages()).find((m) => m.notice === 'speculative');
    expect(card).toMatchObject({ uiOnly: true, speculationId: sp.id, id: sp.messageId });
    const t = (await crew.api('GET', `/triggers/${sp.triggerOut}`)).trigger;
    expect(t).toMatchObject({ source: 'speculative', filter: { verdict: 'act', rule: 'speculative-ready' } });
    expect(t.related).toEqual([sp.triggerId, sp.workerId]);
    expect((await crew.api('GET', `/workers?chatId=${chat.id}`)).items ?? []).toEqual([]);
    // The run's transcript is kept under its Worker id, and it was told about the check command.
    const log = await crew.api('GET', `/workers/${sp.workerId}/messages`);
    expect(log.worker).toMatchObject({ speculation: sp.id, status: 'done' });
    expect(log.messages[0].parts.some((x: any) => x.type === 'tool' && x.name === 'mcp__crew__speculative_result')).toBe(true);
  });

  it('merges the fix with one click, tells the bots, and removes the throwaway worktree and branch', async () => {
    const [sp] = (await runs()).filter((s) => s.status === 'ready');
    const ws = (await crew.api('GET', '/bootstrap')).projects.find((x: any) => x.workspace?.workerId === sp.workerId);
    expect(ws).toBeTruthy();
    const r = await crew.api('POST', `/speculations/${sp.id}/merge`);
    expect(r.status, r.error).toBe(200);
    expect(r.speculation.status).toBe('merged');
    expect(fs.readFileSync(path.join(project.path, 'app.txt'), 'utf8')).toBe('Title: FIXED\n');
    expect(fs.existsSync(path.join(project.path, 'repro', 'crew-repro.sh'))).toBe(true);
    const note = (await chatMessages()).find((m) => m.role === 'system' && m.text.startsWith(`Merged a speculative fix (${sp.id})`));
    expect(note.uiOnly).toBeUndefined();
    expect(fs.existsSync(ws.workspace.worktree)).toBe(false);
    expect(branches()).toBe('');
    expect((await crew.api('POST', `/speculations/${sp.id}/merge`)).status).toBe(409);
    git('add', '-A');
    git('commit', '-qm', 'take the speculative fix');
  });

  it('never speculates twice on the same signal, nor on a message that already asks for the fix', async () => {
    const dup = await report('The home page title looks wrong, it shows a weird word');
    expect(dup).toMatchObject({ status: 'skipped' });
    expect(dup.why).toMatch(/^The same signal was speculated on in the last 24 hours \(sp_/);
    const before = (await runs()).length;
    await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'Please fix the broken footer, it throws an error' });
    await idle();
    await new Promise((r) => setTimeout(r, 500));
    expect((await runs()).length).toBe(before);
  });

  it('stays quiet when it cannot reproduce the problem, and throws its workspace away', async () => {
    const before = (await chatMessages()).length;
    const sp = await report('The sidebar is broken after the last change');
    expect(sp).toMatchObject({ status: 'discarded', why: 'It could not reproduce the problem' });
    const after = await chatMessages();
    expect(after.slice(before).some((m) => m.notice === 'speculative' || m.text.includes(sp.id))).toBe(false);
    expect(branches()).toBe('');
    expect((await crew.api('GET', '/bootstrap')).projects.some((x: any) => x.workspace?.workerId === sp.workerId)).toBe(false);
  });

  it('discards a run that changed only its reproduction, and one whose fix fails the checks', async () => {
    commit({ 'app.txt': 'Title: BUG\n', 'repro/crew-repro.sh': null }, 'the bug is back');
    const half = await report('Only half of the header renders, the title is broken');
    expect(half).toMatchObject({ status: 'discarded', why: 'It changed only the reproduction, no fix' });
    commit({ 'repro/always.sh': 'exit 1\n' }, 'a check that always fails');
    const red = await report('The title is broken again, it shows the wrong text');
    expect(red.status).toBe('discarded');
    expect(red.why).toMatch(/^The checks fail with the fix \(exit code 1\)/);
    expect(red.checks.before).toBeUndefined();
    commit({ 'repro/always.sh': null }, 'drop the failing check');
    expect(branches()).toBe('');
  });

  it('runs unattended: what would need approval is refused, with no approval card', async () => {
    const sp = await report('Something is broken: the install of the title widget fails');
    expect(sp.status).toBe('ready');
    const log = await crew.api('GET', `/workers/${sp.workerId}/messages`);
    const parts = log.messages[0].parts;
    expect(parts.some((x: any) => x.type === 'approval')).toBe(false);
    const install = parts.find((x: any) => x.type === 'tool' && x.name === 'Bash' && String(x.input?.command).startsWith('npm install'));
    expect(install.status).toBe('error');
    expect(install.result).toContain('This is a silent speculative run');
    await crew.api('POST', `/speculations/${sp.id}/discard`);
    expect((await crew.api('GET', `/speculations/${sp.id}`)).speculation).toMatchObject({ status: 'discarded', why: 'Discarded by you' });
    expect(branches()).toBe('');
  });

  it('acts on a preview console error in the project too', async () => {
    const before = new Set((await runs()).map((s) => s.id));
    const r = await crew.api('POST', '/triggers/preview-console', {
      projectId: project.id,
      chatId: chat.id,
      page: '/',
      entries: [{ level: 'error', text: 'TypeError: title is undefined', ts: Date.now() }],
    });
    expect(r.trigger).toBeTruthy();
    const sp = await waitFor(async () => (await runs()).find((s) => !before.has(s.id) && ['ready', 'discarded'].includes(s.status)), 60_000);
    expect(sp).toMatchObject({ signal: 'console-error', status: 'ready', triggerId: r.trigger.id });
    await crew.api('POST', `/speculations/${sp.id}/discard`);
  });

  it('holds the daily budget', async () => {
    await crew.api('PATCH', '/settings', { superAgent: { speculative: { dailyBudgetUsd: 0 } } });
    const sp = await report('The title is broken once more, totally wrong');
    expect(sp).toMatchObject({ status: 'skipped', why: "Today's speculative budget of $0.00 is used up" });
    await crew.api('PATCH', '/settings', { superAgent: { speculative: { dailyBudgetUsd: 2 } } });
  });

  it('is discarded quietly when the user stops the chat', async () => {
    const before = new Set((await runs()).map((s) => s.id));
    await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'The title is slow and broken today' });
    const running = await waitFor(async () => (await runs()).find((s) => !before.has(s.id) && s.status === 'running' && s.base), 30_000);
    await idle();
    await crew.api('POST', `/chats/${chat.id}/stop`);
    const sp = await waitFor(async () => (await runs()).find((s) => s.id === running.id && s.status === 'discarded'), 30_000);
    expect(sp.why).toBe('It was stopped');
    expect((await chatMessages()).some((m) => m.speculationId === sp.id)).toBe(false);
    await waitFor(() => branches() === '', 10_000);
  });

  it('acts on a failing check a full-duplex bot ran in the background', async () => {
    await crew.api('PATCH', `/bots/${group.leadBotId}`, { fullDuplex: true, permission: 'auto' });
    // A chat of its own: the demo bot runs the first command in backticks it reads.
    const checks = await crew.api('POST', '/chats', { title: 'Checks', botIds: [group.leadBotId], projectId: project.id });
    const sp = await report('Run `sh check.sh && grep -q FIXED app.txt` in the background please', undefined, checks.id);
    await crew.api('PATCH', `/bots/${group.leadBotId}`, { fullDuplex: false, permission: 'edits' });
    expect(sp).toMatchObject({ signal: 'failing-check', status: 'ready' });
    expect(sp.reasons[0]).toBe("The project's check command failed: sh check.sh && grep -q FIXED app.txt");
    const job = (await crew.api('GET', `/triggers/${sp.triggerId}`)).trigger;
    expect(job).toMatchObject({ source: 'job', explicit: true });
    await crew.api('POST', `/speculations/${sp.id}/discard`);
  });

  it('gives a two-layer chat’s Router the ready fix as an environment event it cannot act on', async () => {
    await crew.api('PATCH', '/settings', { superAgent: { router: { enabled: true } } });
    const sp = await report('The page title is broken in the group too', (s) => ['ready', 'discarded', 'skipped'].includes(s.status), group.id);
    expect(sp.status).toBe('ready');
    const log = await waitFor(async () => {
      const r = await crew.api('GET', `/chats/${group.id}/router/messages`);
      return r.messages.find((m: any) => (m.batch || []).includes(sp.triggerOut)) ? r : null;
    }, 30_000);
    expect(log.messages.some((m: any) => (m.batch || []).includes(sp.triggerOut))).toBe(true);
    // The speculative run is not one of the Router's Workers.
    expect(((await crew.api('GET', `/workers?chatId=${group.id}`)).items ?? []).some((w: any) => w.id === sp.workerId)).toBe(false);
    await crew.api('POST', `/speculations/${sp.id}/discard`);
  });
});

describe.skipIf(!claudeCli())('a speculative run with Claude Code and a mock model (ADR 008 × 009)', () => {
  const KEY = 'mock-provider-key';
  const MARK = 'You are a speculative background run';
  let mock: MockProvider;
  let crew: CrewServer;

  beforeAll(async () => {
    // The run says it could not reproduce anything; the bot's own turn just answers.
    mock = await startMockProvider({ token: KEY, reply: (r) => ({ text: JSON.stringify(r.body.system || '').includes(MARK) ? 'Could not reproduce it.' : 'Noted.' }) });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      gateway: {
        enabled: true,
        providers: [{ id: 'acct', baseUrl: mock.url, models: ['strong-model', 'spec-model'] }],
        groups: [
          { id: 'strong', members: ['acct/strong-model'] },
          { id: 'spec', members: ['acct/spec-model'] },
        ],
        defaultTarget: 'strong',
        roles: { speculative: 'spec' },
      },
      gatewayTokens: { acct: KEY },
    });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true } });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('runs under the gateway’s speculative role, without tools that reach the user, and is discarded quietly when it reports nothing', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const project = b.projects[0];
    const group = b.chats.find((c: any) => c.kind === 'group');
    const chat = await crew.api('POST', '/chats', { title: 'Bugs', botIds: [group.leadBotId], projectId: project.id });
    await crew.api('PATCH', `/projects/${project.id}`, { speculative: { enabled: true, checkCommand: 'true' } });
    await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'The contact form is broken, it shows an error on submit' });
    const sp = await waitFor(async () => (await crew.api('GET', `/speculations?chatId=${chat.id}`)).speculations.find((s: any) => s.status === 'discarded'), 120_000);
    expect(sp.why).toBe('It ended without reporting a result');

    const calls = mock.requests.filter((x) => x.url.startsWith('/v1/messages') && !x.url.includes('count_tokens'));
    const spec = calls.filter((x) => JSON.stringify(x.body.system || '').includes(MARK));
    expect(spec.length).toBeGreaterThan(0);
    expect(spec.every((x) => x.model === 'spec-model')).toBe(true);
    const tools = new Set(spec.flatMap((x) => x.tools));
    for (const t of ['mcp__crew__draft_external_action', 'mcp__crew__remember', 'mcp__crew__notify_user']) expect(tools.has(t)).toBe(false);
    const g = await crew.api('GET', '/gateway');
    expect(g.calls.some((c: any) => c.role === 'speculative' && c.target === 'spec' && c.botId === group.leadBotId)).toBe(true);
    // Nothing in the chat but the bot's own answer.
    const msgs = (await crew.api('GET', `/chats/${chat.id}/messages?limit=50`)).messages;
    expect(msgs.some((m: any) => m.notice === 'speculative')).toBe(false);
  });
});
