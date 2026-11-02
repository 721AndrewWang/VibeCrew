// The chain of recall as the real Claude Code CLI sees it, against the mock model: with recall on,
// the crew server offers recall instead of chat_history, prompts carry message ids, the environment
// spills behind recall id=env, and a recall call returns the object with its next hops.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, type MockRequest, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';

function lastUserText(body: any): string {
  const users = (body.messages || []).filter((m: any) => m.role === 'user');
  const c = users.at(-1)?.content;
  return typeof c === 'string' ? c : (c || []).map((b: any) => (b.type === 'text' ? b.text : '')).join('');
}

describe.skipIf(!claudeCli())('chain of recall through Claude Code', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  let chatId: string;
  let want: string | null = null;

  /** Calls recall(want) once; newer CLIs defer MCP tools behind ToolSearch, so load it first there. */
  const reply = (r: MockRequest) => {
    if (!want || mock.toolResults.some((t) => t.includes(`[message ${want}]`))) return { text: 'Got it.' };
    if (!r.tools.includes('mcp__crew__recall') && r.tools.includes('ToolSearch') && !mock.toolResults.some((t) => t.includes('mcp__crew__recall')))
      return { tool: { id: 'toolu_search', name: 'ToolSearch', input: { query: 'select:mcp__crew__recall', max_results: 1 } } };
    return { tool: { id: `toolu_recall_${mock.requests.length}`, name: 'mcp__crew__recall', input: { id: want } } };
  };

  beforeAll(async () => {
    mock = await startMockProvider({ token: TOKEN, reply: (r) => reply(r) });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
    });
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    chatId = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
    await crew.api('PATCH', `/chats/${chatId}`, { permission: 'auto' });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  const turn = async (text: string) => {
    mock.requests.length = 0;
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text });
    const r = await waitTurn(crew.api, chatId, sent.seq, 120_000);
    expect(r.status).toBe('done');
    const main = mock.requests.find((q) => q.tools.length && lastUserText(q.body).includes(text))!;
    // The system prompt is this session's own; earlier turns in the history may name older tools.
    return { prompt: lastUserText(main.body), request: JSON.stringify(main.body), system: JSON.stringify(main.body.system), reply: r };
  };

  it('offers chat_history and no recall while off', async () => {
    const t = await turn('First: the requirements note');
    expect(t.request).toContain('mcp__crew__chat_history');
    expect(t.request).not.toContain('mcp__crew__recall');
    expect(t.system).toContain('- chat_history: ');
    expect(t.prompt).not.toContain('[User · #');
  });

  it('offers recall instead once on, and gives the user message its id', async () => {
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, recall: { enabled: true } } });
    const t = await turn('Second');
    expect(t.request).toContain('mcp__crew__recall');
    // The session resumed, and Claude Code keeps the system prompt it started with: the turn says what changed.
    expect(t.prompt).toContain('you now have recall, which takes the place of chat_history');
    expect(t.prompt).toMatch(/\[User · #\d+\]\nSecond/);
    expect(t.reply.meta.injected.tokens).toBeGreaterThan(0);
  });

  it('spills the unchanged environment behind recall id=env, and says what changed only once', async () => {
    const t = await turn('Third');
    expect(t.prompt).toMatch(/unchanged: recall id=env\)/);
    expect(t.prompt).not.toContain('you now have recall');
  });

  it('returns the object and its neighbours when the model recalls an id', async () => {
    want = '#1';
    await turn('Look at the first one');
    const r = mock.toolResults.find((x) => x.includes('[message #1]'));
    expect(r).toContain('First: the requirements note');
    expect(r).toContain('- next #2:');
    want = null;
  });
});
