// Isolated workspaces (a git worktree and branch per chat) end to end: a real server in demo mode
// (no model calls) and real git. Each describe block shares one server; its tests run in order and
// build on each other's state.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, type CrewServer, git as gitIn, initRepo, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

/** True when git exits 0. */
function gitOk(dir: string, env: Record<string, string>, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until no bot is working or queued in the chat. A reply shows `done` before the turn has
 * fully ended (auto-commit on the branch, system notes, the chat lock), so tests wait for this too.
 */
async function idle(api: Api, chatId: string): Promise<void> {
  await waitFor(async () => {
    const { statuses } = await api<{ statuses: Record<string, { chatId?: string }> }>('GET', '/bootstrap');
    return !Object.values(statuses || {}).some((s) => s.chatId === chatId);
  });
}

/** Waits for the turn after `sinceSeq` to end completely; returns the last bot reply. */
async function turnAfter(api: Api, chatId: string, sinceSeq: number): Promise<any> {
  const reply = await waitTurn(api, chatId, sinceSeq);
  await idle(api, chatId);
  return reply;
}

/** Sends a message and waits for the whole bot turn. */
async function say(api: Api, chatId: string, text: string): Promise<any> {
  const m = await api('POST', `/chats/${chatId}/messages`, { text });
  expect(m.status, JSON.stringify(m)).toBe(200);
  return turnAfter(api, chatId, m.seq);
}

const lastMessages = async (api: Api, chatId: string, n = 5): Promise<any[]> => (await api<{ messages: any[] }>('GET', `/chats/${chatId}/messages?limit=${n}`)).messages;
const read = (file: string) => fs.readFileSync(file, 'utf8');

describe('isolated workspaces: lifecycle', () => {
  // Own root folder (not removed by stop()) so the server can be restarted on the same data.
  const root = tempDir('crew-ws');
  let server: CrewServer;
  const api: Api = (method, url, body) => server.api(method, url, body);
  const git = (dir: string, ...args: string[]) => gitIn(dir, server.env, ...args);

  let b: any;
  let project: any;
  let group: any;
  let other: any;
  let ws: any;

  beforeAll(async () => {
    server = await startServer({ dir: root });
  });
  afterAll(async () => {
    await server?.stop();
    if (!process.env.CREW_TEST_KEEP) fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts with a git repo as the starter project', async () => {
    b = await api('GET', '/bootstrap');
    project = b.projects[0];
    group = b.chats.find((c: any) => c.kind === 'group');
    expect(project, 'starter project').toBeTruthy();
    expect(fs.existsSync(path.join(project.path, '.git')), project?.path).toBe(true);

    // A second chat on the same project that stays in the main folder.
    other = await api('POST', '/chats', { title: 'Other', botIds: [group.botIds[1]], projectId: project.id });
    expect(other.status).toBe(200);
  });

  it('creates a worktree, copies only ignored env files, and refuses a second one', async () => {
    // Env files: .env.local is gitignored (copied); .env.shared is un-ignored and untracked (must not be copied).
    fs.appendFileSync(path.join(project.path, '.gitignore'), '!.env.shared\n');
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'allow .env.shared' });
    fs.writeFileSync(path.join(project.path, '.env.local'), 'SECRET=1\n');
    fs.writeFileSync(path.join(project.path, '.env.shared'), 'SHARED=1\n');

    ws = await api('POST', `/chats/${group.id}/workspace`);
    expect(ws.status, ws.error).toBe(200);
    expect(ws.workspace?.branch, ws.error).toMatch(/^crew\//);
    expect(fs.existsSync(ws.path) && fs.existsSync(path.join(ws.path, 'index.html')), 'worktree exists: ' + ws.path).toBe(true);
    expect(git(project.path, 'worktree', 'list')).toContain(ws.path);
    expect(fs.existsSync(path.join(ws.path, '.env.local')), 'ignored .env.local copied').toBe(true);
    expect(fs.existsSync(path.join(ws.path, '.env.shared')), 'un-ignored .env.shared not copied').toBe(false);
    fs.rmSync(path.join(project.path, '.env.shared'));

    const b2 = await api('GET', '/bootstrap');
    expect(b2.chats.find((c: any) => c.id === group.id).workspaceId, 'chat points at the workspace').toBe(ws.id);
    expect(
      b2.projects.some((p: any) => p.id === ws.id && p.workspace),
      'bootstrap includes the workspace project',
    ).toBe(true);

    const again = await api('POST', `/chats/${group.id}/workspace`);
    expect(again.status, again.error).toBe(409);
  });

  it('refuses a merge while a bot works, then auto-commits the turn on the branch', async () => {
    const sent = await api('POST', `/chats/${group.id}/messages`, { text: 'Please make a change to the home page title' });
    const early = await api('POST', `/chats/${group.id}/workspace/merge`, {});
    expect(early.status, early.error).toBe(409);
    expect(early.error).toMatch(/working/i);

    // The bot turn happens in the worktree and is committed on the branch.
    const turn1 = await turnAfter(api, group.id, sent.seq);
    expect(turn1.status, turn1.error || '').toBe('done');
    expect(fs.existsSync(path.join(ws.path, 'crew-demo.md')), 'file written in the worktree').toBe(true);
    expect(
      git(ws.path, 'ls-files')
        .split('\n')
        .some((f) => f.startsWith('.env')),
      'copied env file not committed',
    ).toBe(false);
    expect(fs.existsSync(path.join(project.path, 'crew-demo.md')), 'main folder untouched').toBe(false);
    const log1 = git(ws.path, 'log', '--format=%an|%s', '-1');
    expect(log1, 'turn auto-committed on the branch').toMatch(/^Crew Test\|Chief:/);
    expect(git(ws.path, 'status', '--porcelain'), 'worktree clean after turn').toBe('');

    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect({ ahead: st.ahead, behind: st.behind, files: st.files }).toEqual({ ahead: 1, behind: 0, files: [expect.objectContaining({ path: 'crew-demo.md', status: 'added' })] });
    const d = await api('GET', `/chats/${group.id}/workspace/diff?path=crew-demo.md`);
    expect(d.diff, 'diff of a file vs base').toContain('+# Demo');
  });

  it('lets another chat work in the main folder at the same time', async () => {
    const turn2 = await say(api, other.id, 'Please create a readme file');
    expect(turn2.status).toBe('done');
    expect(fs.existsSync(path.join(project.path, 'crew-demo.md')), 'other chat wrote in the main folder').toBe(true);
  });

  it('refuses to merge over an uncommitted main file, reports conflicts, and lets the bot resolve them', async () => {
    // An untracked file in main would be overwritten.
    let m = await api('POST', `/chats/${group.id}/workspace/merge`, {});
    expect(m.status, m.error).toBe(409);
    expect(m.error).toContain('crew-demo.md');
    const mainText = read(path.join(project.path, 'crew-demo.md'));
    expect(/Pixel|\bby\b/i.test(mainText), 'main still has its own version').toBe(true);

    // Commit it in main: now both branches added the same file differently -> conflict.
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'main: demo file' });
    m = await api('POST', `/chats/${group.id}/workspace/merge`, {});
    expect(m.ok, JSON.stringify(m)).toBe(false);
    expect(m.conflicts, JSON.stringify(m)).toContain('crew-demo.md');
    expect(git(project.path, 'log', '-1', '--format=%s'), 'merge with conflicts touched nothing (main)').toBe('main: demo file');
    expect(git(ws.path, 'status', '--porcelain'), 'merge with conflicts touched nothing (worktree)').toBe('');

    // The server starts the merge, the bot fixes the file, the end of the turn concludes it.
    const before = (await lastMessages(api, group.id, 5)).at(-1).seq;
    const r = await api('POST', `/chats/${group.id}/workspace/resolve`);
    expect(r.started, JSON.stringify(r)).toBe(true);
    expect(r.conflicts, JSON.stringify(r)).toContain('crew-demo.md');
    const turn3 = await turnAfter(api, group.id, before);
    expect(turn3.status).toBe('done');
    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect({ merging: st.merging, behind: st.behind, dirty: !!st.dirty }, 'merge concluded by auto-commit').toEqual({ merging: false, behind: 0, dirty: false });
  });

  it('squash-merges into main and keeps the workspace going from the merged state', async () => {
    let m = await api('POST', `/chats/${group.id}/workspace/merge`, { message: 'Redo the home page title' });
    expect(m.ok, JSON.stringify(m)).toBe(true);
    expect(m.files, JSON.stringify(m)).toBeGreaterThanOrEqual(1);
    expect(git(project.path, 'log', '-1', '--format=%s')).toBe('Redo the home page title');
    expect(git(project.path, 'rev-list', '--parents', '-1', 'HEAD').split(' '), 'squash commit has one parent').toHaveLength(2);
    expect(read(path.join(project.path, 'crew-demo.md')), 'main working tree updated').toBe(read(path.join(ws.path, 'crew-demo.md')));
    expect(git(project.path, 'status', '--porcelain')).toBe('');

    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect({ ahead: st.ahead, behind: st.behind, files: st.files.length }).toEqual({ ahead: 0, behind: 0, files: 0 });
    expect(st.mergedAt, 'mergedAt set').toBeTruthy();

    m = await api('POST', `/chats/${group.id}/workspace/merge`, {});
    expect(m.status, 'merging again: nothing to merge — ' + m.error).toBe(409);
  });

  it('syncs when main moves on', async () => {
    fs.writeFileSync(path.join(project.path, 'about.html'), '<h1>about</h1>\n');
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'main: about page' });
    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect(st.behind, 'status sees base ahead').toBe(1);
    const sy = await api('POST', `/chats/${group.id}/workspace/sync`);
    expect(sy.ok, JSON.stringify(sy)).toBe(true);
    expect(fs.existsSync(path.join(ws.path, 'about.html'))).toBe(true);
  });

  it('undoing a workspace turn restores the worktree, not the main folder', async () => {
    await say(api, group.id, 'Make one more change');
    const turns = await api('GET', `/chats/${group.id}/turns`);
    const t = turns.items[0];
    expect(t.projectId, 'turn recorded against the workspace').toBe(ws.id);
    const mainBefore = read(path.join(project.path, 'crew-demo.md'));
    const rv = await api('POST', `/chats/${group.id}/turns/${t.id}/revert`, {});
    expect(rv.reverted, JSON.stringify(rv)).toHaveLength(1);
    expect(read(path.join(project.path, 'crew-demo.md')), 'main folder untouched by revert').toBe(mainBefore);
  });

  it('closes the workspace with branch deletion and the bots go back to the main folder', async () => {
    const del = await api('DELETE', `/chats/${group.id}/workspace?deleteBranch=1`);
    expect(del.ok, del.error || '').toBe(true);
    expect(fs.existsSync(ws.path), 'worktree removed').toBe(false);
    expect(git(project.path, 'branch', '--list', ws.workspace.branch), 'branch deleted').toBe('');
    const b3 = await api('GET', '/bootstrap');
    expect(b3.chats.find((c: any) => c.id === group.id).workspaceId, 'chat back in the project folder').toBeFalsy();
    expect(
      b3.projects.some((p: any) => p.id === ws.id),
      'workspace project gone',
    ).toBe(false);

    const turn5 = await say(api, group.id, 'Make a change in the main folder');
    expect(turn5.status).toBe('done');
    expect(git(project.path, 'status', '--porcelain'), 'bots work in the main folder again').toContain('crew-demo.md');
    git(project.path, 'checkout', '--', '.');
  });

  it('deleting a chat removes its worktree but keeps a branch with unmerged work', async () => {
    const ws2 = await api('POST', `/chats/${other.id}/workspace`);
    expect(ws2.status, ws2.error).toBe(200);
    await say(api, other.id, 'Please create something');
    await api('DELETE', `/chats/${other.id}`);
    await waitFor(() => !fs.existsSync(ws2.path), 10_000);
    expect(fs.existsSync(ws2.path), 'chat deletion removed the worktree').toBe(false);
    expect(git(project.path, 'branch', '--list', ws2.workspace.branch), 'unmerged branch kept: ' + ws2.workspace.branch).not.toBe('');
  });

  it('keeps a workspace across a restart and reconciles a hand-deleted worktree', async () => {
    const dm = b.chats.find((c: any) => c.kind === 'dm');
    const ws3 = await api('POST', `/chats/${dm.id}/workspace`);
    const ws4 = await api('POST', `/chats/${group.id}/workspace`);
    expect(ws3.status, ws3.error).toBe(200);
    expect(ws4.status, ws4.error).toBe(200);
    await server.stop();
    fs.rmSync(ws4.workspace.worktree, { recursive: true, force: true });
    server = await startServer({ dir: root });

    const b4 = await api('GET', '/bootstrap');
    expect(b4.chats.find((c: any) => c.id === dm.id).workspaceId, 'workspace kept across restart').toBe(ws3.id);
    expect(fs.existsSync(ws3.path)).toBe(true);
    expect(b4.chats.find((c: any) => c.id === group.id).workspaceId, 'missing worktree reconciled (chat)').toBeFalsy();
    expect(
      b4.projects.some((p: any) => p.id === ws4.id),
      'missing worktree reconciled (project)',
    ).toBe(false);
  });

  it('refuses a workspace for a non-git project and never lists workspaces as projects', async () => {
    const plainDir = path.join(root, 'plain-site');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'index.html'), '<h1>plain</h1>\n');
    const plain = await api('POST', '/projects', { mode: 'open', path: plainDir });
    const pc = await api('POST', '/chats', { title: 'Plain', botIds: [group.botIds[0]], projectId: plain.id });
    const pw = await api('POST', `/chats/${pc.id}/workspace`);
    expect(pw.status, pw.error).toBe(400);
    expect(pw.error).toMatch(/Git/);

    const lp = (await api('GET', '/bootstrap')).projects.filter((p: any) => !p.workspace).map((p: any) => p.name as string);
    expect(
      lp.some((n: string) => n.includes('crew/')),
      lp.join(','),
    ).toBe(false);
    expect(lp, lp.join(',')).toHaveLength(2);
  });
});

describe('isolated workspaces: conflicts, guards and edge cases', () => {
  let server: CrewServer;
  let T: string;
  const api: Api = (method, url, body) => server.api(method, url, body);
  const git = (dir: string, ...args: string[]) => gitIn(dir, server.env, ...args);
  const ok = (dir: string, ...args: string[]) => gitOk(dir, server.env, ...args);
  const IDENTITY = '[user]\n\tname = Crew Test\n\temail = test@example.invalid\n';
  // Without an identity git still guesses one from the account and host name where the host name
  // has a domain (a Mac on a LAN, say); useConfigOnly stops the guess so commits really fail.
  const NO_IDENTITY = '[user]\n\tuseConfigOnly = true\n';
  /** Rewrites the test's global git config, with or without a commit identity. */
  const writeConfig = (withIdentity: boolean) =>
    fs.writeFileSync(server.env.GIT_CONFIG_GLOBAL, (withIdentity ? IDENTITY : NO_IDENTITY) + '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  const makeRepo = (dir: string, files: Record<string, string>) => initRepo(dir, server.env, files);
  const newGroup = (title: string, botId: string, projectId: string) => api('POST', '/chats', { title, botIds: [botId], projectId });
  const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, n, 1, 2, 3]);

  let b: any;
  let project: any;
  let group: any;
  let bots: { chief: string; pixel: string; probe: string; lens: string };
  let ws: any;
  let W: string;

  beforeAll(async () => {
    // No identity may leak in from the environment: the commit-failure tests take it away from git.
    const unset: Record<string, undefined> = {};
    for (const k of Object.keys(process.env)) if (/^(EMAIL|GIT_AUTHOR_.*|GIT_COMMITTER_.*)$/.test(k)) unset[k] = undefined;
    server = await startServer({ env: unset });
    T = server.dir;
    writeConfig(true);
    b = await api('GET', '/bootstrap');
    project = b.projects[0];
    group = b.chats.find((c: any) => c.kind === 'group');
    const [chief, pixel, probe, lens] = group.botIds;
    bots = { chief, pixel, probe, lens };
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('detects non-ASCII, binary and modify/delete conflicts and does not conclude an unfixed merge', async () => {
    fs.writeFileSync(path.join(project.path, 'página.html'), '<h1>Home</h1>\n<p>Original</p>\n');
    fs.writeFileSync(path.join(project.path, 'logo.png'), png(1));
    fs.writeFileSync(path.join(project.path, 'about.html'), '<h1>about</h1>\n');
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'add files' });
    ws = await api('POST', `/chats/${group.id}/workspace`);
    expect(ws.status, ws.error).toBe(200);
    W = ws.workspace.worktree;
    // The branch changes all three...
    fs.writeFileSync(path.join(W, 'página.html'), '<h1>Home</h1>\n<p>Branch version</p>\n');
    fs.writeFileSync(path.join(W, 'logo.png'), png(2));
    fs.writeFileSync(path.join(W, 'about.html'), '<h1>about (branch)</h1>\n');
    git(W, 'add', '-A');
    git(W, 'commit', '-qm', 'branch edits');
    // ...and main changes them differently, deleting about.html.
    fs.writeFileSync(path.join(project.path, 'página.html'), '<h1>Home</h1>\n<p>Main version</p>\n');
    fs.writeFileSync(path.join(project.path, 'logo.png'), png(3));
    fs.rmSync(path.join(project.path, 'about.html'));
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'main edits' });

    const all = ['página.html', 'logo.png', 'about.html'];
    const m = await api('POST', `/chats/${group.id}/workspace/merge`, {});
    expect(m.ok, JSON.stringify(m)).toBe(false);
    expect(m.conflicts, 'merge sees all three conflicts').toEqual(expect.arrayContaining(all));
    const sy = await api('POST', `/chats/${group.id}/workspace/sync`);
    expect(sy.ok, JSON.stringify(sy)).toBe(false);
    expect(sy.conflicts, 'sync lists non-ASCII, binary and modify/delete conflicts').toEqual(expect.arrayContaining(all));
    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect(st.merging, 'status: merging').toBeTruthy();
    expect(
      st.files.some((f: any) => f.path === 'página.html'),
      'names unescaped: ' + JSON.stringify(st.files),
    ).toBe(true);
  });

  it('keeps the merge open after a bot turn that did not fix the conflicts', async () => {
    // The (demo) bot does not fix them: the merge must not be concluded.
    const beforeResolve = (await lastMessages(api, group.id, 1)).at(-1).seq;
    const rs = await api('POST', `/chats/${group.id}/workspace/resolve`);
    expect(rs.started, JSON.stringify(rs)).toBe(true);
    expect(rs.conflicts, JSON.stringify(rs)).toHaveLength(3);
    await turnAfter(api, group.id, beforeResolve);
    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect(st.merging, 'merge still in progress after an unfixed turn').toBe(true);
    const notes = (await lastMessages(api, group.id, 6))
      .filter((x) => x.role === 'system')
      .map((x) => x.text)
      .join(' | ');
    expect(notes, 'bot told what is still unresolved').toMatch(/merge (is )?(not|isn't) (finished|complete|done)/i);
    expect(notes).toContain('logo.png');

    const m = await api('POST', `/chats/${group.id}/workspace/merge`, {});
    expect(m.status, 'merge refused while conflicts remain — ' + m.error).toBe(409);
    const gc = await api('POST', `/projects/${ws.id}/git/commit`, { message: 'sneaky' });
    expect(gc.status, gc.error).toBe(409);
    expect(gc.error, 'Git section commit refused with conflicts').toContain('conflict');
    expect(ok(W, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'no marker commit on the branch (merge still pending)').toBe(true);
  });

  it('concludes the merge once conflicts are fixed and lands the result in main', async () => {
    // Fix them the way a bot would: text without markers, pick a binary, confirm the deletion.
    fs.writeFileSync(path.join(W, 'página.html'), '<h1>Home</h1>\n<p>Both sides combined</p>\n');
    git(W, 'checkout', '--ours', 'logo.png');
    git(W, 'add', 'logo.png');
    git(W, 'rm', '-q', 'about.html');
    const sy = await api('POST', `/chats/${group.id}/workspace/sync`);
    expect(sy.ok, 'sync concludes the fixed merge — ' + JSON.stringify(sy)).toBe(true);
    const m = await api('POST', `/chats/${group.id}/workspace/merge`, { message: 'conflict test' });
    expect(m.ok, 'merge after fixing — ' + JSON.stringify(m)).toBe(true);
    const home = read(path.join(project.path, 'página.html'));
    expect(home, 'main has no conflict markers').not.toMatch(/^(<{7}|>{7})/m);
    expect(home).toContain('Both sides combined');
    expect(Buffer.compare(fs.readFileSync(path.join(project.path, 'logo.png')), png(2)), 'main has our binary').toBe(0);
    expect(fs.existsSync(path.join(project.path, 'about.html')), 'main has no about.html').toBe(false);
  });

  it('concludes a resolve-to-ours merge even when the status is empty', async () => {
    fs.writeFileSync(path.join(W, 'página.html'), '<h1>Home</h1>\n<p>Branch, second version</p>\n');
    git(W, 'commit', '-qam', 'branch 2');
    fs.writeFileSync(path.join(project.path, 'página.html'), '<h1>Home</h1>\n<p>Main, second version</p>\n');
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'main 2' });
    let sy = await api('POST', `/chats/${group.id}/workspace/sync`);
    expect(sy.ok, 'second conflict — ' + JSON.stringify(sy)).toBe(false);
    expect(sy.conflicts).toContain('página.html');
    git(W, 'checkout', '--ours', 'página.html');
    git(W, 'add', 'página.html');
    expect(git(W, 'status', '--porcelain'), 'status empty').toBe('');
    expect(ok(W, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'but merge pending').toBe(true);
    sy = await api('POST', `/chats/${group.id}/workspace/sync`);
    const st = await api('GET', `/chats/${group.id}/workspace`);
    expect(sy.ok, JSON.stringify(sy)).toBe(true);
    expect(st.merging).toBe(false);
    expect(ok(W, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'resolve-to-ours merge concluded').toBe(false);
  });

  it('refuses project switch, chat deletion and project removal while a bot works in the workspace', async () => {
    const sent = await api('POST', `/chats/${group.id}/messages`, { text: 'Please make a change to the home page' });
    const plainDir = path.join(T, 'other-site');
    makeRepo(plainDir, { 'index.html': '<h1>other</h1>\n' });
    const other = await api('POST', '/projects', { mode: 'open', path: plainDir });
    const sw = await api('PATCH', `/chats/${group.id}`, { projectId: other.id });
    expect(sw.status, 'project switch refused — ' + sw.error).toBe(409);
    const dl = await api('DELETE', `/chats/${group.id}`);
    expect(dl.status, 'chat deletion refused — ' + dl.error).toBe(409);
    const pd = await api('DELETE', `/projects/${project.id}`);
    expect(pd.status, 'project removal refused — ' + pd.error).toBe(409);
    await turnAfter(api, group.id, sent.seq);
    expect(fs.existsSync(W), 'workspace intact after refusals').toBe(true);
    expect((await api('GET', '/bootstrap')).chats.find((c: any) => c.id === group.id).workspaceId).toBe(ws.id);
  });

  it('never loses work when git cannot commit', async () => {
    // Pixel may write anywhere; Probe's role is limited to test files, so its demo write is refused.
    const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === bots.pixel);
    const wsd = await api('POST', `/chats/${dm.id}/workspace`);
    expect(wsd.status, wsd.error).toBe(200);
    writeConfig(false); // git can no longer commit
    try {
      const t = await say(api, dm.id, 'Please create a file');
      const dmNotes = (await lastMessages(api, dm.id, 4))
        .filter((x) => x.role === 'system')
        .map((x) => x.text)
        .join(' | ');
      expect(t.status).toBe('done');
      expect(dmNotes, 'failed turn commit is reported').toMatch(/(couldn't|could not|failed to) commit/i);
      const cl = await api('DELETE', `/chats/${dm.id}/workspace`);
      expect(cl.status, cl.error).toBe(500);
      expect(cl.error, 'close refused when work cannot be saved').toMatch(/not closed/);
      expect(fs.existsSync(path.join(wsd.path, 'crew-demo.md')), 'worktree and work still there').toBe(true);
      const lensDm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === bots.lens);
      const noId = await api('POST', `/chats/${lensDm.id}/workspace`);
      expect(noId.status, noId.error).toBe(400);
      expect(noId.error, 'create refused without git identity').toMatch(/user.name/);
      expect(git(project.path, 'worktree', 'list'), 'no leftover worktree from the refusal').not.toContain('lens');
    } finally {
      writeConfig(true);
    }
    const cl2 = await api('DELETE', `/chats/${dm.id}/workspace`);
    expect(cl2.ok, 'close works once commits work again — ' + cl2.error).toBe(true);
    expect(fs.existsSync(wsd.path)).toBe(false);
    expect(git(project.path, 'branch', '--list', wsd.workspace.branch), 'branch kept').not.toBe('');
  });

  it("copies env files according to the worktree's committed ignore rules", async () => {
    // Committed .gitignore un-ignores .env.shared; main's working tree (uncommitted) ignores it again.
    fs.appendFileSync(path.join(project.path, '.gitignore'), '!.env.shared\n');
    await api('POST', `/projects/${project.id}/git/commit`, { message: 'un-ignore .env.shared' });
    fs.appendFileSync(path.join(project.path, '.gitignore'), '.env.shared\n');
    fs.writeFileSync(path.join(project.path, '.env.shared'), 'KEY=secret\n');
    fs.writeFileSync(path.join(project.path, '.env.local'), 'LOCAL=1\n');
    const pixelDm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === bots.pixel);
    const wse = await api('POST', `/chats/${pixelDm.id}/workspace`);
    expect(wse.status, wse.error).toBe(200);
    expect(fs.existsSync(path.join(wse.path, '.env.local')), 'env ignored by the worktree copied').toBe(true);
    expect(fs.existsSync(path.join(wse.path, '.env.shared')), 'env only ignored by uncommitted rules not copied').toBe(false);
    await api('DELETE', `/chats/${pixelDm.id}/workspace?deleteBranch=1`);
    git(project.path, 'checkout', '--', '.gitignore');
    fs.rmSync(path.join(project.path, '.env.shared'));
  });

  it('handles a monorepo package: files outside the package are listed and merged', async () => {
    const mono = path.join(T, 'mono');
    makeRepo(mono, { 'package.json': '{"name":"root"}\n', 'packages/web/index.html': '<h1>web</h1>\n', 'packages/ui/button.ts': 'export const b = 1;\n' });
    const mp = await api('POST', '/projects', { mode: 'open', path: path.join(mono, 'packages/web') });
    const mc = await newGroup('Mono', bots.chief, mp.id);
    const mw = await api('POST', `/chats/${mc.id}/workspace`);
    expect(mw.status, mw.error).toBe(200);
    expect(mw.path, 'monorepo workspace points at the package').toBe(path.join(mw.workspace.worktree, 'packages/web'));
    expect(fs.existsSync(path.join(mw.path, 'index.html'))).toBe(true);
    fs.writeFileSync(path.join(mw.workspace.worktree, 'packages/ui/button.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(mw.workspace.worktree, 'package.json'), '{"name":"root","private":true}\n');
    const st = await api('GET', `/chats/${mc.id}/workspace`);
    expect(st.prefix).toBe('packages/web');
    expect(
      st.files.map((x: any) => x.path),
      'files outside the package listed',
    ).toEqual(expect.arrayContaining(['packages/ui/button.ts', 'package.json']));
    await say(api, mc.id, 'Please make a change to the page');
    const m = await api('POST', `/chats/${mc.id}/workspace/merge`, {});
    expect(m.ok, JSON.stringify(m)).toBe(true);
    expect(m.files, 'monorepo merge lands everything').toBe(3);
    expect(git(mono, 'show', 'HEAD:packages/ui/button.ts')).toContain('2');
  });

  it('works for a symlinked project and refuses a folder not yet committed to git', async () => {
    const real = path.join(T, 'real-site');
    makeRepo(real, { 'index.html': '<h1>real</h1>\n' });
    fs.writeFileSync(path.join(real, '.gitignore'), '.env\n');
    git(real, 'add', '-A');
    git(real, 'commit', '-qm', 'gitignore');
    fs.writeFileSync(path.join(real, '.env'), 'A=1\n');
    fs.symlinkSync(real, path.join(T, 'link-site'));
    const lp = await api('POST', '/projects', { mode: 'open', path: path.join(T, 'link-site') });
    const lc = await newGroup('Link', bots.chief, lp.id);
    const lw = await api('POST', `/chats/${lc.id}/workspace`);
    expect(lw.status, lw.error).toBe(200);
    expect(fs.existsSync(path.join(lw.path, 'index.html')), 'symlinked project gets a real workspace').toBe(true);
    expect(fs.existsSync(path.join(lw.path, '.env')), 'env copied for the symlinked project').toBe(true);

    fs.mkdirSync(path.join(real, 'draft'));
    fs.writeFileSync(path.join(real, 'draft', 'index.html'), '<h1>draft</h1>\n');
    const dp = await api('POST', '/projects', { mode: 'open', path: path.join(real, 'draft') });
    const dc = await newGroup('Draft', bots.chief, dp.id);
    const dw = await api('POST', `/chats/${dc.id}/workspace`);
    expect(dw.status, dw.error).toBe(400);
    expect(dw.error, 'uncommitted folder refused').toMatch(/hasn't been committed to Git/);
    expect(git(real, 'worktree', 'list').split('\n'), 'refusal left no worktree (only main + link workspace)').toHaveLength(2);
    expect(git(real, 'branch', '--list', 'crew/draft-*'), 'refusal left no branch').toBe('');
  });

  it('uses the base branch, not a tag with the same name, and refuses to merge during a rebase', async () => {
    const tagged = path.join(T, 'tagged');
    makeRepo(tagged, { 'index.html': '<h1>t</h1>\n' });
    git(tagged, 'tag', 'main');
    const tp = await api('POST', '/projects', { mode: 'open', path: tagged });
    const tc = await newGroup('Tagged', bots.chief, tp.id);
    const tw = await api('POST', `/chats/${tc.id}/workspace`);
    expect(tw.workspace?.baseBranch, 'base branch is main, not heads/main').toBe('main');
    fs.writeFileSync(path.join(tagged, 'new.html'), 'n\n');
    git(tagged, 'add', '-A');
    git(tagged, 'commit', '-qm', 'main moves');
    const st = await api('GET', `/chats/${tc.id}/workspace`);
    const sy = await api('POST', `/chats/${tc.id}/workspace/sync`);
    expect(st.behind).toBe(1);
    expect(sy.ok, 'sync merges the branch, not the tag — ' + JSON.stringify(sy)).toBe(true);
    expect(sy.files).toBe(1);
    expect(fs.existsSync(path.join(tw.path, 'new.html'))).toBe(true);

    // The base branch is being rebased in the project folder.
    await say(api, tc.id, 'Please create something');
    git(tagged, 'checkout', '-qb', 'side', 'HEAD~1');
    fs.writeFileSync(path.join(tagged, 'index.html'), '<h1>side</h1>\n');
    git(tagged, 'commit', '-qam', 'side');
    git(tagged, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(tagged, 'index.html'), '<h1>main</h1>\n');
    git(tagged, 'commit', '-qam', 'main index');
    const mainBefore = git(tagged, 'rev-parse', 'refs/heads/main');
    expect(ok(tagged, 'rebase', 'side'), 'rebase stopped at a conflict').toBe(false);
    let m = await api('POST', `/chats/${tc.id}/workspace/merge`, {});
    expect(m.status, 'merge refused during rebase — ' + m.error).toBe(409);
    expect(git(tagged, 'rev-parse', 'refs/heads/main'), 'main untouched by the refused merge').toBe(mainBefore);
    git(tagged, 'rebase', '--abort');
    m = await api('POST', `/chats/${tc.id}/workspace/merge`, {});
    expect(m.ok, 'merge works after the rebase is aborted — ' + JSON.stringify(m)).toBe(true);
  });
});
