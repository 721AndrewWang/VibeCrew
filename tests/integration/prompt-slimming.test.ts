// What reaches the model each turn, as the real Claude Code CLI sends it to the mock endpoint:
// the full environment once per session, then only what changed; chat_history returns full text.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';

/** The text of the last user message in a request: what Crew sent for this turn. */
function lastUserText(body: any): string {
  const users = (body.messages || []).filter((m: any) => m.role === 'user');
  const c = users.at(-1)?.content;
  return typeof c === 'string' ? c : (c || []).map((b: any) => (b.type === 'text' ? b.text : '')).join('');
}

describe.skipIf(!claudeCli())('slimmer prompts', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  let chatId: string;
  let wantHistory = false;

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) =>
        wantHistory && r.tools.some((t) => t.endsWith('chat_history')) && !mock.toolResults.some((t) => t.includes('#1'))
          ? { tool: { id: 'toolu_hist', name: 'mcp__crew__chat_history', input: { seqs: [1] } } }
          : { text: '收到。' },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
      denyRules: ['Bash(*prod-server*)'],
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
    const reply = await waitTurn(crew.api, chatId, sent.seq, 120_000);
    expect(reply.status).toBe('done');
    const main = mock.requests.filter((r) => r.tools.length && lastUserText(r.body).includes(text));
    return lastUserText(main[0].body);
  };

  it('sends the whole environment on the first turn of a session', async () => {
    const sent = await turn('第一条：一个很长很长的需求说明');
    expect(sent).toContain('禁止的操作');
    expect(sent).toContain('预览：');
  });

  it('then only the time and what changed', async () => {
    const sent = await turn('第二条');
    expect(sent).toMatch(/时间：/);
    expect(sent).toContain('其余环境信息和之前一样');
    expect(sent).not.toContain('禁止的操作');
    await crew.api('PATCH', '/settings', { denyRules: ['Bash(*prod-server*)', 'Bash(*db-server*)'] });
    // A changed deny list restarts the sessions, so the next turn gets everything again.
    expect(await turn('第三条')).toContain('Bash(*db-server*)');
  });

  it('lets the bot read an older message in full', async () => {
    wantHistory = true;
    await turn('看一下第一条');
    const r = mock.toolResults.find((t) => t.includes('#1'));
    expect(r).toContain('第一条：一个很长很长的需求说明');
    expect(r).toContain('【用户 · #1】');
  });

  it('starts a fresh-session role in a new conversation every turn', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    await crew.api('PATCH', `/bots/${chief.id}`, { freshSession: true });
    wantHistory = false;
    await turn('第四条');
    const sent = await turn('第五条');
    // A new conversation: the earlier turns are not in it, the environment comes in full, and the bot is told.
    const main = mock.requests.filter((r) => r.tools.length && lastUserText(r.body).includes('第五条'));
    const users = main[0].body.messages.filter((m: any) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(JSON.stringify(main[0].body.messages)).not.toContain('第四条');
    expect(sent).toContain('禁止的操作');
    expect(sent).toContain('从新会话开始');
    await crew.api('PATCH', `/bots/${chief.id}`, { freshSession: false });
    expect((await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBeUndefined();
  });
});
