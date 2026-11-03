// Recall of speculative runs (ADR 005 × 008, ADR 110): a verified fix made in demo mode stays ready
// across a restart; the real Claude Code CLI, against the mock model, then recalls its sp_… id and
// gets the compact Inline & Spill form (summary, verdict, diff stats, the links to follow), and the
// full diff only when it recalls sp_…/diff, as untrusted data, a page at a time.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, type MockRequest, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';
const CHECK = 'sh check.sh';

describe.skipIf(!claudeCli())('recall of a speculative run through Claude Code', () => {
  const dir = tempDir('crew-spec-recall');
  let mock: MockProvider;
  let crew: CrewServer;
  let chatId: string;
  let askId: string;
  let sp: any;
  /** The ids the model recalls in the current turn, in order, one call each. */
  let wants: string[] = [];
  let turnNo = 0;
  const callId = (i: number) => `toolu_recall_${turnNo}_${i}`;

  const reply = (r: MockRequest) => {
    const seen = JSON.stringify(r.body.messages || []);
    const i = wants.findIndex((_, k) => !seen.includes(callId(k)));
    if (i < 0) return { text: 'Got it.' };
    // Newer CLIs defer MCP tools behind ToolSearch: load recall first there.
    if (!r.tools.includes('mcp__crew__recall') && r.tools.includes('ToolSearch') && !seen.includes('toolu_search'))
      return { tool: { id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__crew__recall', max_results: 1 } } };
    return { tool: { id: callId(i), name: 'mcp__crew__recall', input: { id: wants[i] } } };
  };
  /** A tool result's text, whether it came back as a string or as content blocks. */
  const textOf = (t: string): string => {
    try {
      const blocks = JSON.parse(t);
      return Array.isArray(blocks) ? blocks.map((b: any) => b?.text ?? '').join('') : t;
    } catch {
      return t;
    }
  };
  /** What recall returned for an id, as the model read it. */
  const resultFor = (id: string) => mock.toolResults.map(textOf).find((t) => t.includes(`[speculation ${id}]`) || t.includes(`[diff ${id}]`) || (t.includes('No speculative run') && t.includes(id)));

  beforeAll(async () => {
    // Demo mode makes the verified fix.
    crew = await startServer({ dir });
    const b = await crew.api('GET', '/bootstrap');
    const project = b.projects[0];
    const lead = b.chats.find((c: any) => c.kind === 'group').leadBotId;
    const projectId = project.id;
    const chat = await crew.api('POST', '/chats', { title: 'Bugs', botIds: [lead], projectId: project.id });
    chatId = chat.id;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project.path, env: { ...process.env, ...crew.env }, encoding: 'utf8' });
    fs.writeFileSync(path.join(project.path, 'app.txt'), 'Title: BUG\n');
    fs.writeFileSync(path.join(project.path, 'check.sh'), 'for f in repro/*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done\n');
    git('add', '-A');
    git('commit', '-qm', 'the app and its checks');
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, recall: { enabled: true } } });
    await crew.api('PATCH', `/projects/${project.id}`, { speculative: { enabled: true, checkCommand: CHECK } });
    await crew.api('POST', `/chats/${chatId}/messages`, { text: 'The home page title looks wrong, it shows a weird word' });
    sp = await waitFor(async () => (await crew.api('GET', `/speculations?chatId=${chatId}`)).speculations.find((s: any) => s.status === 'ready'), 60_000);
    await crew.stop();

    // The same data, now with the real Claude Code against the mock model.
    mock = await startMockProvider({ token: TOKEN, reply: (r) => reply(r) });
    crew = await startServer({ dir, fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
    });
    // Asked from another chat on the same project (the demo chat's sessions are the demo agent's):
    // a run made for the project is in scope there too.
    const ask = await crew.api('POST', '/chats', { title: 'Questions', botIds: [lead], projectId });
    askId = ask.id;
    await crew.api('PATCH', `/chats/${askId}`, { permission: 'auto' });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const turn = async (text: string, ids: string[]) => {
    turnNo++;
    wants = ids;
    const sent = await crew.api('POST', `/chats/${askId}/messages`, { text });
    const r = await waitTurn(crew.api, askId, sent.seq, 100_000);
    expect(r.status, r.error).toBe('done');
  };

  it('keeps the ready fix across the restart', async () => {
    expect((await crew.api('GET', `/speculations/${sp.id}`)).speculation).toMatchObject({ status: 'ready' });
  });

  it('resolves sp_… to the compact form: summary, verdict, diff stats, and where the full diff is', async () => {
    await turn(`What did ${sp.id} find?`, [sp.id]);
    const text = resultFor(sp.id) as string;
    expect(text).toBeDefined();
    expect(text).toContain('status: ready');
    expect(text).toContain(`verdict: verified: \`${CHECK}\` fails without the fix (exit 1), passes with it (exit 0)`);
    expect(text).toContain('diff: 2 files, +2 −1 (reproduction: 1 file)');
    // The run's own summary is a model's words: data, fenced.
    expect(text).toMatch(/<untrusted source="speculation"[^>]*>[\s\S]*The run's summary: app\.txt still contained BUG/);
    expect(text).toContain(`- full diff ${sp.id}/diff`);
    expect(text).toContain(`- signal ${sp.triggerId}`);
    // Compact: the diff itself is not in it.
    expect(text).not.toContain('+Title: FIXED');
  });

  it('returns the full diff on request, as untrusted data', async () => {
    await turn('Show me its diff.', [`${sp.id}/diff`]);
    const text = resultFor(`${sp.id}/diff`) as string;
    expect(text).toBeDefined();
    expect(text).toMatch(/<untrusted source="diff"[^>]*>[\s\S]*-Title: BUG[\s\S]*\+Title: FIXED[\s\S]*<\/untrusted>/);
    expect(text).toContain('repro/crew-repro.sh');
  });

  it('says plainly when a run is not this conversation’s or does not exist', async () => {
    await turn('And sp_doesnotexist?', ['sp_doesnotexist']);
    expect(resultFor('sp_doesnotexist')).toContain('No speculative run sp_doesnotexist');
  });
});
