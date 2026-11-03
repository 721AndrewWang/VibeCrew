// Measured (ADR 103): a fixture conversation with the real Claude Code and a mock model. The Worker
// reads a file with a tool and pastes the tool's output, a stack trace and a log into its report;
// the mock Router tries to pass that on and to ramble. Asserted: every message in the chat fits the
// chat profile (≤100 words, ≤6 lines, no tool output), nothing the tool returned reaches the chat or
// the webhook, the full report is one click away under Details, and the Worker's drafts follow the
// asynchronous profile.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolOutputIn } from '../../server/channels/profiles';
import { wordCount } from '../../server/layers/prompts';
import { fromCrewSession, type MockProvider, type MockRequest, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, git, gitEnv, startServer, waitFor } from '../helpers/server';

/** What only the file the Worker reads contains: it must never reach the chat or the webhook. */
const SENTINEL = 'FIXTURE_TOOL_OUTPUT_7f3a';
const STACK = 'TypeError: header is null\n    at render (src/header.js:12:5)\n    at main (src/index.js:3:1)';
const LOG = '2026-11-02T10:00:01 INFO build started\n2026-11-02T10:00:04 ERROR header.test.js failed';
const ROUTER = 'coordinator of the group chat';
const WORKER = 'You are working as a Worker';

/** The last user message of the conversation: its text, and its tool results (id, error, content). */
function lastUser(r: MockRequest): { text: string; results: { id: string; error: boolean; text: string }[] } {
  const m = [...(r.body.messages || [])].reverse().find((x: any) => x.role === 'user');
  const blocks = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : m?.content || [];
  return {
    text: blocks.map((b: any) => b.text || '').join('\n'),
    results: blocks
      .filter((b: any) => b.type === 'tool_result')
      .map((b: any) => ({ id: String(b.tool_use_id), error: !!b.is_error, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) })),
  };
}

/** Every tool result in the conversation with this id. */
function resultOf(r: MockRequest, id: string): string {
  for (const m of r.body.messages || [])
    for (const c of Array.isArray(m.content) ? m.content : [])
      if (c.type === 'tool_result' && c.tool_use_id === id) return typeof c.content === 'string' ? c.content : c.content.map((x: any) => x.text || '').join('\n');
  return '';
}

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ tool: { id, name, input } });
const reply = (id: string, text: string, kind: string) => tool(id, 'mcp__crew_router__reply', { text, kind });

describe.skipIf(!claudeCli())('channel norms, measured (real Claude Code, mock model)', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let group: any;
  const hook: { body: any }[] = [];
  let hookServer: http.Server;
  let firstSeq = 0;

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        if (!fromCrewSession(r)) return { text: 'OK' };
        const system = JSON.stringify(r.body.system || '');
        const last = lastUser(r);
        const done = (id: string) => last.results.find((x) => x.id === id);
        if (system.includes(ROUTER)) {
          // After a tool call: the refused replies are tried again, shorter and plainer, as a model would.
          if (done('toolu_dispatch_1')) return reply('toolu_reply_ack', 'On it: Pixel is looking at the failing header test.', 'decision');
          if (done('toolu_reply_leak')?.error)
            return reply('toolu_reply_ok', 'Pixel found why the header test failed and fixed the selector; it is merged into the chat branch. Take a look?', 'acceptance');
          if (done('toolu_reply_long')?.error) return reply('toolu_reply_q', 'Should the footer get the same fix as the header?', 'question');
          if (last.results.length) return { text: 'Handled.' };
          // The Worker's report: first, the Router pastes what it read.
          if (last.text.includes('kind="worker"')) {
            const report = last.text.match(/Report: ([\s\S]*?)\n<\/event>/)?.[1] || '';
            return reply('toolu_reply_leak', `Pixel reports:\n${report}`, 'decision');
          }
          // Only what the user wrote: the <workers> line quotes reports too.
          const user = [...last.text.matchAll(/<event [^>]*kind="user"[^>]*>\n([\s\S]*?)\n<\/event>/g)].map((m) => m[1]).join('\n');
          if (user.includes('header test'))
            return tool('toolu_dispatch_1', 'mcp__crew_router__dispatch_worker', { title: 'Header test', task: 'Find out why the header test fails and fix it.', bot: 'Pixel' });
          if (user.includes('footer')) return reply('toolu_reply_long', `About the footer: ${'there is a lot to say here and '.repeat(20)}done.`, 'decision');
          return { text: 'Nothing to do.' };
        }
        if (system.includes(WORKER)) {
          const read = resultOf(r, 'toolu_grep_1');
          if (done('toolu_draft_good')) return { text: `Fixed the header test: the selector was wrong.\n\n\`\`\`\n${read}\n\`\`\`\n${STACK}\n${LOG}\nAll green now.` };
          if (done('toolu_draft_bad')?.error)
            return tool('toolu_draft_good', 'mcp__crew__draft_external_action', {
              kind: 'pr-open',
              title: 'Fix the header selector',
              body: `## Summary\nThe header test failed because the selector pointed at a removed element. ${'It now targets the new header. '.repeat(8)}\n\n## Testing\nRan the header test:\n\`\`\`\n${`${read}\n`.repeat(20)}\`\`\``,
            });
          if (done('toolu_grep_1'))
            return tool('toolu_draft_bad', 'mcp__crew__draft_external_action', {
              kind: 'pr-open',
              title: 'Fix the header selector',
              body: `Fixed it. ${'The selector pointed at a removed element and now targets the new one. '.repeat(6)}\n${STACK}`,
            });
          // Its own worktree, as Claude Code's environment section names it.
          const cwd = system.match(/[Ww]orking directory: (\/[^\\"\s]+)/)?.[1] || '.';
          return tool('toolu_grep_1', 'Read', { file_path: `${cwd}/fixture.log` });
        }
        return { text: 'OK.' };
      },
    });

    hookServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hook.push({ body: JSON.parse(raw || '{}') });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));

    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true, model: 'mock-router', workerModel: 'mock-worker' } } });
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    // The file only a tool can read, committed so the Worker's worktree has it.
    const project = b.projects.find((p: any) => p.id === group.projectId);
    fs.writeFileSync(path.join(project.path, 'fixture.log'), `${SENTINEL} header.test.js: expected 1 header, found 0\n`);
    const env = gitEnv(crew.dir);
    git(project.path, env, 'add', 'fixture.log');
    git(project.path, env, 'commit', '-qm', 'Add the fixture log');
    const { port } = hookServer.address() as AddressInfo;
    await crew.api('PUT', `/projects/${project.id}/webhook`, { url: `http://127.0.0.1:${port}/hook`, enabled: true });
    firstSeq = (await crew.api('GET', `/chats/${group.id}/messages?limit=1`)).messages.at(-1)?.seq ?? 0;
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
    await new Promise((r) => hookServer?.close(r));
  });

  it('runs the fixture conversation within the chat profile, with no tool output in the chat', async () => {
    const chatReplies = (n: number) =>
      waitFor(async () => {
        const list = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.filter((m: any) => m.seq > firstSeq && m.router);
        return list.length >= n ? list : null;
      }, 60_000);

    await crew.api('POST', `/chats/${group.id}/messages`, { text: 'The header test fails, please fix it' });
    const first = await chatReplies(2);
    await crew.api('POST', `/chats/${group.id}/messages`, { text: 'And what about the footer?' });
    const all = await chatReplies(3);
    expect(all.map((m: any) => [m.channel.kind, m.text])).toEqual([
      ['decision', 'On it: Pixel is looking at the failing header test.'],
      ['acceptance', 'Pixel found why the header test failed and fixed the selector; it is merged into the chat branch. Take a look?'],
      ['question', 'Should the footer get the same fix as the header?'],
    ]);
    expect(first).toHaveLength(2);

    // The tool really ran, and its output went into the report the Router read.
    expect(mock.toolResults.some((t) => t.includes(SENTINEL))).toBe(true);
    const w = (await crew.api('GET', `/workers?chatId=${group.id}`)).items.find((x: any) => x.title === 'Header test');
    expect(w.report.text).toContain(SENTINEL);

    // Measured: everything the user sees in the chat since the start fits the chat profile.
    const shown = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.filter((m: any) => m.seq > firstSeq && m.role !== 'user');
    for (const m of shown) {
      expect(wordCount(m.text)).toBeLessThanOrEqual(100);
      expect(m.text.split('\n').filter((l: string) => l.trim()).length).toBeLessThanOrEqual(6);
      expect(toolOutputIn(m.text)).toBeNull();
      expect(m.text).not.toContain(SENTINEL);
      expect(m.text).not.toContain('src/header.js:12');
      expect(m.text).not.toContain('ERROR header.test.js');
    }
    const lengths = all.map((m: any) => wordCount(m.text));
    expect(Math.max(...lengths)).toBeLessThanOrEqual(25);

    // The Router's two attempts that broke the profile were refused, and never reached the chat.
    const log = (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages;
    const refused = log.flatMap((m: any) => m.parts).filter((p: any) => p.type === 'tool' && p.name === 'mcp__crew_router__reply' && p.status === 'error');
    expect(refused.map((p: any) => String(p.result || '').match(/contains a stack trace|has \d+ words/)?.[0])).toEqual(['contains a stack trace', expect.stringMatching(/has \d+ words/)]);

    // The full report is one click away: under Details of the acceptance request, tool output included.
    const details = all[1].channel.details;
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ workerId: w.id, status: 'done', report: w.report.text, gist: 'Fixed the header test: the selector was wrong. All green now.' });
    expect(details[0].gist).not.toContain(SENTINEL);

    // The webhook got the approved kinds only (question, acceptance), as text, and no tool output.
    await waitFor(() => (hook.length >= 2 ? true : null));
    expect(hook.map((h) => h.body.text.split(' · ')[0])).toEqual(['Ready for your OK', 'Question']);
    for (const h of hook) {
      expect(JSON.stringify(h.body)).not.toContain(SENTINEL);
      expect(toolOutputIn(h.body.text)).toBeNull();
    }
  });

  it("shaped the Worker's pull request draft for its surface", async () => {
    const { drafts } = await crew.api('GET', `/drafts?chatId=${group.id}`);
    // The first, unstructured draft with a loose stack trace was refused; the second was saved, its long output folded.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'pr-open', title: 'Fix the header selector', status: 'pending' });
    expect(drafts[0].body).toMatch(/^## Summary\n/);
    expect(drafts[0].body).toMatch(/\n## Testing\nRan the header test:\n<details><summary>Output \(4\d lines\)<\/summary>\n\n```\n1\tFIXTURE/);
    expect(drafts[0].body).toMatch(/```\n\n<\/details>$/);
    const bad = mock.toolResults.find((t) => t.includes('The draft was not saved'));
    expect(bad).toMatch(/stack trace outside a code block/);
  });
});
