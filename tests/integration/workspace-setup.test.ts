// Workspaces for a real-world project: files git ignores are carried over, a setup command runs
// before the bots, and the project's commit rules shape merges.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, git, initRepo, startServer, waitFor, waitTurn } from '../helpers/server';

let crew: CrewServer;
let repo: string;
let projectId: string;
let botId: string;

beforeAll(async () => {
  crew = await startServer();
  // .gitignore shares .claude/ but keeps personal files out; .git/info/exclude keeps more local.
  repo = path.join(crew.dir, 'repo');
  initRepo(repo, crew.env, {
    '.gitignore': '.*\n!/.gitignore\n!/.claude/\n/.claude/settings.local.json\nnode_modules/\n.env\n',
    '.claude/settings.json': '{"permissions":{}}\n',
    'src/app.txt': 'v1\n',
  });
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '/CLAUDE.md\n/.claude/hooks/\n/docs/specs/\n/notes.txt\n/.claude/.pending-validation\n');
  const local: Record<string, string> = {
    'CLAUDE.md': '# rules\n',
    '.claude/hooks/check.py': 'print(1)\n',
    '.claude/settings.local.json': '{"hooks":{}}\n',
    '.claude/.pending-validation': 'src/app.txt\n',
    'docs/specs/api.md': 'spec\n',
    'notes.txt': 'mine\n',
    '.env': 'KEY=local\n',
    'frontend/node_modules/pkg/index.js': 'x\n',
    'scratch.txt': 'not ignored\n',
  };
  for (const [rel, text] of Object.entries(local)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  const project = await crew.api('POST', '/projects', { mode: 'open', path: repo });
  projectId = project.id;
  botId = (await crew.api('GET', '/bootstrap')).bots[0].id;
});

afterAll(() => crew?.stop());

describe('project settings', () => {
  it('saves the setup command, commit rules and must-ask rules, cleaning the rules up', async () => {
    const p = await crew.api('PATCH', `/projects/${projectId}`, {
      setupCommand: 'sleep 2 && mkdir -p frontend/node_modules && echo ready > frontend/node_modules/.setup-done',
      commitGuide: 'English, imperative mood, subject under 72 characters',
      noAttribution: true,
      askRules: ['Bash(ssh:*)', '  ', 'Bash(ssh:*)', 'Bash(docker compose down:*)'],
    });
    expect(p.commitGuide).toMatch(/^English/);
    expect(p.noAttribution).toBe(true);
    expect(p.askRules).toEqual(['Bash(ssh:*)', 'Bash(docker compose down:*)']);
  });
});

describe('a new workspace', () => {
  let chatId: string;
  let ws: any;
  const has = (rel: string) => fs.existsSync(path.join(ws.workspace.worktree, rel));

  beforeAll(async () => {
    chatId = (await crew.api('POST', '/chats', { title: 'Fix bug', botIds: [botId], projectId })).id;
    ws = await crew.api('POST', `/chats/${chatId}/workspace`);
  });

  it('is created on its own branch', () => {
    expect(ws.status).toBe(200);
    expect(ws.workspace.branch).toMatch(/^crew\//);
  });

  it('carries over the files git ignores but the work needs', () => {
    for (const rel of ['CLAUDE.md', '.claude/hooks/check.py', '.claude/settings.local.json', 'docs/specs/api.md', 'notes.txt', '.env']) expect(has(rel), rel).toBe(true);
    expect(has('.claude/settings.json')).toBe(true);
  });

  it('leaves tool state, dependencies and untracked files behind', () => {
    expect(has('.claude/.pending-validation')).toBe(false);
    expect(has('frontend/node_modules/pkg/index.js')).toBe(false);
    expect(has('scratch.txt')).toBe(false);
  });

  it('stays clean for git', () => {
    expect(git(ws.workspace.worktree, crew.env, 'status', '--porcelain')).toBe('');
  });

  it('runs the setup command before the bots, holding messages meanwhile', async () => {
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: '改一下 src/app.txt' });
    await waitFor(async () => (await crew.api('GET', '/bootstrap')).statuses?.[botId]?.state === 'queued', 5000, 100);
    const merging = await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: 'x' });
    expect(merging.status).toBe(409);
    expect(merging.error).toMatch(/准备/);
    await waitTurn(crew.api, chatId, sent.seq);
    expect(has('frontend/node_modules/.setup-done')).toBe(true);
    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
    const sys = messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => m.text)
      .join('\n');
    expect(sys).toMatch(/已带上 git 之外的本地文件：.*CLAUDE\.md/);
    expect(sys).not.toContain('.pending-validation');
    expect(sys).toContain('正在准备工作区');
    const ready = messages.find((m: any) => m.text?.includes('工作区准备好了'));
    const reply = messages.filter((m: any) => m.role === 'bot').at(-1);
    expect(ready).toBeTruthy();
    expect(reply.ts).toBeGreaterThan(ready.ts);
  });

  it('needs a written message to merge when the project has commit rules, and uses it as is', async () => {
    const noMsg = await crew.api('POST', `/chats/${chatId}/workspace/merge`, {});
    expect(noMsg.status).toBe(400);
    expect(noMsg.error).toMatch(/提交信息有要求/);
    const msg = 'Fix the demo page title\n\nThe title was stale after the rename.';
    expect((await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: msg })).ok).toBe(true);
    expect(git(repo, crew.env, 'log', '-1', '--format=%B')).toBe(msg);
  });

  it('adds no Crew footer with attribution off', async () => {
    await crew.api('PATCH', `/projects/${projectId}`, { commitGuide: '', noAttribution: true, setupCommand: '' });
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: '再改一下' });
    await waitTurn(crew.api, chatId, sent.seq);
    expect((await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: 'Second change' })).ok).toBe(true);
    expect(git(repo, crew.env, 'log', '-1', '--format=%B')).not.toMatch(/Crew/);
  });

  it('cannot change settings on the workspace itself', async () => {
    expect((await crew.api('PATCH', `/projects/${ws.id}`, { commitGuide: 'x' })).status).toBe(400);
  });
});

describe('a failing setup command', () => {
  it('is reported with its output, and the bots still start', async () => {
    await crew.api('PATCH', `/projects/${projectId}`, { setupCommand: 'echo "installing…"; echo "boom" >&2; exit 3' });
    const chatId = (await crew.api('POST', '/chats', { title: 'Another', botIds: [botId], projectId })).id;
    await crew.api('POST', `/chats/${chatId}/workspace`);
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'hi' });
    await waitTurn(crew.api, chatId, sent.seq);
    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
    const sys = messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => m.text)
      .join('\n');
    expect(sys).toMatch(/退出码 3/);
    expect(sys).toContain('boom');
  });
});
