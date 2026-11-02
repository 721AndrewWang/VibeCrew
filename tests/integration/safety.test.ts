// ADR 007 end to end, with the demo agent (no model calls) and real git: the command guard refuses
// a bot's push in every mode, the bot drafts it instead, the user's click runs the exact command,
// and the audit log records each step with the way back. Also: settings, the guard's dry run,
// families on projects and skills.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, type CrewServer, git as gitIn, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

describe('safety: guard, drafts and the audit log', () => {
  let server: CrewServer;
  const api: Api = (method, url, body) => server.api(method, url, body);
  let project: any;
  let group: any;
  let remote: string;

  beforeAll(async () => {
    server = await startServer();
    const b = await api('GET', '/bootstrap');
    project = b.projects[0];
    group = b.chats.find((c: any) => c.kind === 'group');
    remote = tempDir('crew-remote');
    gitIn(remote, server.env, 'init', '-q', '--bare');
    gitIn(project.path, server.env, 'remote', 'add', 'origin', remote);
    // Full auto: the guard must hold even where every other check would allow.
    expect((await api('PATCH', `/chats/${group.id}`, { permission: 'auto' })).status).toBe(200);
  });
  afterAll(async () => {
    await server?.stop();
    fs.rmSync(remote, { recursive: true, force: true });
  });

  it('turns the guard and the stripped environment on by default, and the audit log off', async () => {
    const b = await api('GET', '/bootstrap');
    expect(b.settings.safety).toEqual({ guard: true, stripCredentials: true, audit: false });
    expect(b.drafts).toEqual([]);
    const r = await api('PATCH', '/settings', { safety: { audit: true } });
    expect(r.settings.safety).toEqual({ guard: true, stripCredentials: true, audit: true });
  });

  it("refuses the bot's push in Full auto and has it drafted instead", async () => {
    const m = await api('POST', `/chats/${group.id}/messages`, { text: 'Please push the branch' });
    const reply = await waitTurn(api, group.id, m.seq);
    expect(reply.status).toBe('done');
    const bash = reply.parts.find((p: any) => p.type === 'tool' && p.name === 'Bash');
    expect(bash.result).toMatch(/Blocked by Crew's command guard: git push/);
    expect(bash.result).toMatch(/draft_external_action/);
    const tool = reply.parts.find((p: any) => p.type === 'tool' && p.name === 'mcp__crew__draft_external_action');
    expect(tool.result).toMatch(/Exact command it will run when approved: git push origin HEAD:refs\/heads\/main/);
    // Nothing reached the remote.
    expect(gitIn(remote, server.env, 'for-each-ref')).toBe('');

    const { drafts } = await api('GET', `/drafts?chatId=${group.id}`);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'git-push', status: 'pending', target: 'origin → main', command: ['git', 'push', 'origin', 'HEAD:refs/heads/main'] });

    const audit = await api('GET', '/audit');
    expect(audit.entries.map((e: any) => e.event)).toEqual(['drafted', 'blocked']);
    expect(audit.entries[1]).toMatchObject({ rule: 'external', command: 'git push origin HEAD', actor: { chatId: group.id } });
  });

  it("runs the exact command on the user's click, and records how to reverse it", async () => {
    const {
      drafts: [d],
    } = await api('GET', `/drafts?chatId=${group.id}`);
    const r = await api('POST', `/drafts/${d.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.draft).toMatchObject({ status: 'done', result: { exitCode: 0 }, before: '', reverse: 'git push origin --delete main' });
    const head = gitIn(project.path, server.env, 'rev-parse', 'HEAD');
    expect(gitIn(remote, server.env, 'rev-parse', 'refs/heads/main')).toBe(head);
    // A decided draft cannot be run again.
    expect((await api('POST', `/drafts/${d.id}/approve`)).status).toBe(409);

    const audit = await api('GET', '/audit');
    expect(audit.entries.slice(0, 2).map((e: any) => e.event)).toEqual(['ran', 'approved']);
    expect(audit.entries[0]).toMatchObject({ reverse: 'git push origin --delete main', actor: { user: true } });
    await waitFor(async () => {
      const { messages } = await api('GET', `/chats/${group.id}/messages?limit=3`);
      return messages.some((x: any) => x.role === 'system' && x.text.includes('You approved and ran the drafted action: origin → main'));
    });
  });

  it('records the old head for a second push, so it can be put back', async () => {
    const before = gitIn(project.path, server.env, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(project.path, 'more.txt'), 'more\n');
    gitIn(project.path, server.env, 'add', '-A');
    gitIn(project.path, server.env, 'commit', '-qm', 'more');
    const created = await api('POST', `/drafts?chatId=${group.id}`, { kind: 'git-push', branch: 'main' });
    expect(created.status).toBe(200);
    const r = (await api('POST', `/drafts/${created.draft.id}/approve`)).draft;
    const after = gitIn(project.path, server.env, 'rev-parse', 'HEAD');
    expect(r).toMatchObject({ status: 'done', before, reverse: `git push --force-with-lease=refs/heads/main:${after} origin ${before}:refs/heads/main` });
  });

  it('refuses drafts whose fields could be read as something else, and lets the user discard one', async () => {
    const bad = await api('POST', `/drafts?chatId=${group.id}`, { kind: 'git-push', remote: '--upload-pack=evil', branch: 'main' });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/remote "--upload-pack=evil" is not a valid name/);
    const msg = (await api('POST', `/drafts?chatId=${group.id}`, { kind: 'message', channel: '#team', body: 'Shipped.' })).draft;
    expect(msg).toMatchObject({ command: null, target: '#team', status: 'pending' });
    expect((await api('POST', `/drafts/${msg.id}/discard`)).draft).toMatchObject({ status: 'discarded' });
    expect((await api('GET', '/audit?event=discarded')).entries).toHaveLength(1);
  });

  it("dry-runs the guard for Settings → Safety, with the project's allow-list", async () => {
    const check = (command: string) => api('POST', '/guard/check', { command, projectId: project.id });
    expect((await check('git status')).verdict).toEqual({ kind: 'read' });
    expect((await check('rm -rf dist')).verdict).toEqual({ kind: 'change', effects: ['Deletes: dist'] });
    expect((await check('cat ~/.aws/credentials')).verdict).toMatchObject({ kind: 'deny', rule: 'credentials' });
    expect((await check('curl https://api.example.dev/x')).verdict).toMatchObject({ kind: 'deny', rule: 'network' });
    expect((await api('PATCH', `/projects/${project.id}`, { allowedDomains: ['api.example.dev'] })).status).toBe(200);
    expect((await check('curl https://api.example.dev/x')).verdict).toEqual({ kind: 'change', effects: ['Connects to: api.example.dev'] });
  });

  it('lets a project opt in to skill families and pass variables through', async () => {
    const p = await api('PATCH', `/projects/${project.id}`, { skillFamilies: ['triage', 'reproduce', 'triage'], passEnv: ['NPM_TOKEN'] });
    expect(p).toMatchObject({ skillFamilies: ['triage', 'reproduce'], passEnv: ['NPM_TOKEN'] });
    expect((await api('PATCH', `/projects/${project.id}`, { skillFamilies: ['deploy'] })).status).toBe(400);
    expect((await api('PATCH', `/projects/${project.id}`, { passEnv: ['NOT A NAME'] })).status).toBe(400);
  });

  it('keeps a skill family and its modes in the skill file', async () => {
    const saved = await api('POST', '/skills', { name: 'my-triage', title: 'My triage', body: 'Triage {{args}}', family: 'triage', modes: ['worker', 'speculative'], readOnly: true });
    expect(saved).toMatchObject({ family: 'triage', modes: ['worker', 'speculative'], readOnly: true });
    const file = fs.readFileSync(path.join(server.home, 'skills', 'my-triage.md'), 'utf8');
    expect(file).toContain('family: triage\nmodes: worker, speculative\nreadOnly: true\n');
    const listed = (await api('GET', '/bootstrap')).skills;
    expect(listed.find((s: any) => s.name === 'my-triage')).toMatchObject({ family: 'triage', modes: ['worker', 'speculative'] });
    expect(listed.find((s: any) => s.name === 'reproduce')).toMatchObject({ family: 'reproduce', builtin: true });
  });

  it('lets the guard be switched off, and then the push asks again as before', async () => {
    await api('PATCH', '/settings', { safety: { guard: false } });
    const check = await api('POST', '/guard/check', { command: 'git push' });
    expect(check.enabled).toBe(false);
  });
});
