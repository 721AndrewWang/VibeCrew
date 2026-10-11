// What reaches the model each turn, as the real Claude Code CLI sends it to the mock endpoint:
// the full environment once per session, then only what changed; chat_history returns full text.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitFor, waitTurn } from '../helpers/server';

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
          : { text: 'Got it.' },
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
    const sent = await turn('First: a very, very long requirements note');
    expect(sent).toContain('Bash(*prod-server*)');
    expect(sent).toMatch(/preview/i);
  });

  it('then only the time and what changed', async () => {
    const sent = await turn('Second');
    expect(sent).toMatch(/<context>\n[^\n]*\d{1,2}:\d{2}/);
    expect(sent).toContain('The rest of the environment is unchanged');
    expect(sent).not.toContain('Bash(*prod-server*)');
    await crew.api('PATCH', '/settings', { denyRules: ['Bash(*prod-server*)', 'Bash(*db-server*)'] });
    // A changed deny list restarts the sessions, so the next turn gets everything again.
    expect(await turn('Third')).toContain('Bash(*db-server*)');
  });

  it('lets the bot read an older message in full', async () => {
    wantHistory = true;
    await turn('Look at the first one');
    const r = mock.toolResults.find((t) => t.includes('#1'));
    expect(r).toContain('First: a very, very long requirements note');
    expect(r).toContain('[User · #1]');
  });

  it('starts a fresh-session role in a new conversation every turn', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    await crew.api('PATCH', `/bots/${chief.id}`, { freshSession: true });
    wantHistory = false;
    await turn('Fourth');
    const sent = await turn('Fifth');
    // A new conversation: the earlier turns are not in it, the environment comes in full, and the bot is told.
    const main = mock.requests.filter((r) => r.tools.length && lastUserText(r.body).includes('Fifth'));
    const users = main[0].body.messages.filter((m: any) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(JSON.stringify(main[0].body.messages)).not.toContain('Fourth');
    expect(sent).toContain('Bash(*prod-server*)');
    expect(sent).toContain('start every turn in a new session');
    await crew.api('PATCH', `/bots/${chief.id}`, { freshSession: false });
    expect((await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBeUndefined();
  });

  it("gives a blind reviewer the user's words and the change, and hides the bots' replies, even in chat_history", async () => {
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    await crew.api('PATCH', `/bots/${chief.id}`, { blindReview: true });
    wantHistory = true;
    mock.toolResults.length = 0;
    const sent = await turn('Review the first one');
    expect(sent).toContain('What the user asked for');
    expect(sent).toContain('Changes to review');
    expect(sent).toContain('Review as your role description says');
    expect(sent).not.toContain('Got it.'); // the bot's own earlier replies are not replayed
    const history = mock.toolResults.find((t) => t.includes('#1'))!;
    expect(history).toContain('[User · #1]');
    expect(history).not.toContain('[@Chief');
    await crew.api('PATCH', `/bots/${chief.id}`, { blindReview: false });
    wantHistory = false;
  });

  it('starts an oversized session over: a new conversation carrying the recent messages, its own replies included', async () => {
    // The mock model reports a handful of tokens per call: any session is over 1.
    await crew.api('PATCH', '/settings', { rotateAtTokens: 1 });
    const chief = (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.name === 'Chief');
    const before = Date.now();
    await turn('Sixth: the session is already huge');
    // The size is recorded after the turn, in the background; the next turn decides from it.
    await waitFor(async () => {
      const chat = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === chatId);
      return (chat.context?.[chief.id]?.at ?? 0) >= before;
    }, 15_000);
    const sent = await turn('Seventh');
    const main = mock.requests.filter((r) => r.tools.length && lastUserText(r.body).includes('Seventh'));
    const users = main[0].body.messages.filter((m: any) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(sent).toContain('This is a new session');
    expect(sent).toContain('Sixth: the session is already huge');
    expect(sent).toContain('You (@Chief)');
    await crew.api('PATCH', '/settings', { rotateAtTokens: 60_000 });
  });
});
