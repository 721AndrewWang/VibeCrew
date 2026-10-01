// Adversarial review end to end with the demo agent: /challenge reaches Skeptic, which sees the
// diff and not its teammates; its verdict lands on the workspace and gates the merge.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, initRepo, startServer, waitFor } from '../helpers/server';

let crew: CrewServer;
let chatId: string;
let projectId: string;
let worktree: string;
let skeptic: any;

beforeAll(async () => {
  crew = await startServer();
  const repo = path.join(crew.dir, 'repo');
  initRepo(repo, crew.env, { 'index.html': '<h1>hi</h1>\n' });
  projectId = (await crew.api('POST', '/projects', { mode: 'open', path: repo })).id;
  skeptic = await crew.api('POST', '/bots', { template: 'skeptic', projectId });
  const pixel = (await crew.api('GET', '/bootstrap')).bots.find((b: any) => b.name === 'Pixel');
  chatId = (await crew.api('POST', '/chats', { title: 'Contact', botIds: [pixel.id], projectId })).id;
  worktree = (await crew.api('POST', `/chats/${chatId}/workspace`)).workspace.worktree;
});
afterAll(() => crew?.stop());

/** Sends a message and waits until every bot it set off has finished. */
async function say(text: string) {
  const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text });
  await waitFor(async () => {
    const b = await crew.api('GET', '/bootstrap');
    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=40`);
    const after = messages.filter((m: any) => m.seq > sent.seq && m.role === 'bot');
    return after.length && after.every((m: any) => m.status !== 'streaming') && Object.values(b.statuses).every((s: any) => s.state === 'idle') ? after : null;
  }, 60_000);
  return (await crew.api('GET', `/chats/${chatId}/messages?limit=40`)).messages.filter((m: any) => m.seq > sent.seq);
}

describe('the Skeptic template', () => {
  it('is blind, starts fresh, thinks hard and may only write counterexample tests', () => {
    expect([skeptic.blindReview, skeptic.freshSession, skeptic.effort, skeptic.model, skeptic.permission, skeptic.editScope]).toEqual([true, true, 'high', '', 'review', ['tests/challenge/**']]);
    expect(skeptic.allowRules).toContain('Bash(node tests/challenge/*)');
    expect(skeptic.allowRules).toContain('Bash(npm run *)');
  });
});

describe('/challenge in a workspace', () => {
  it('brings Skeptic in, records "not refuted" against the commit it saw, and lets the merge through', async () => {
    await crew.api('PATCH', `/projects/${projectId}`, { requireChallenge: true });
    await say('帮我做一个页面'); // Pixel (demo) writes crew-demo.md
    const blocked = await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: 'x' });
    expect(blocked.status).toBe(409);
    expect(blocked.error).toContain('还没做过');

    const out = await say('/challenge');
    const verdict = out.find((m: any) => m.role === 'bot' && m.botId === skeptic.id);
    expect(verdict.text).toContain('结论：未推翻');
    expect(verdict.meta.verdict).toEqual({ refuted: 0 });
    expect((await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === chatId).botIds).toContain(skeptic.id);

    const st = await crew.api('GET', `/chats/${chatId}/workspace`);
    expect(st.challenge.refuted).toBe(0);
    expect(st.requireChallenge).toBe(true);
    expect((await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: 'Add the page' })).ok).toBe(true);
  });

  it('blocks the merge after a refutation, and again after new commits', async () => {
    fs.writeFileSync(path.join(worktree, 'index.html'), '<h1>hi</h1>\n<!-- REFUTE_ME -->\n');
    const out = await say('/challenge 看看首页');
    expect(out.find((m: any) => m.botId === skeptic.id).meta.verdict).toEqual({ refuted: 1 });
    const refused = await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.error).toContain('推翻了 1 条');

    fs.writeFileSync(path.join(worktree, 'index.html'), '<h1>hi</h1>\n');
    await say('/challenge');
    await say('再改一下'); // Pixel commits again after the review
    const stale = await crew.api('POST', `/chats/${chatId}/workspace/merge`, { message: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.error).toContain('新提交');
  });
});
