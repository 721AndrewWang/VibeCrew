// The browser tools see a page's dark theme when asked: what a bot reads back is the colour the
// page really renders, through the real CLI calling Crew's tools against the demo site.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';
const BG = 'getComputedStyle(document.body).backgroundColor';

describe.skipIf(!claudeCli())('dark mode in the browser tools', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  let chatId: string;
  let steps: { name: string; input: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        const next = steps[mock.toolResults.filter((t) => t.includes('rgb')).length];
        return r.tools.some((t) => t.endsWith('browser_act')) && next ? { tool: { id: `toolu_dark_${mock.toolResults.length}`, ...next } } : { text: '看过了。' };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    chatId = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
    await crew.api('PATCH', `/chats/${chatId}`, { permission: 'auto' });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('reads the light colours by default, the dark ones with colorScheme dark, and switches back in place', async () => {
    steps = [
      { name: 'mcp__crew__browser_act', input: { path: '/', steps: [{ action: 'eval', value: BG }] } },
      { name: 'mcp__crew__browser_act', input: { colorScheme: 'dark', steps: [{ action: 'eval', value: BG }] } },
      { name: 'mcp__crew__browser_act', input: { colorScheme: 'light', steps: [{ action: 'eval', value: BG }] } },
    ];
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: '看看首页的亮色和暗色' });
    const reply = await waitTurn(crew.api, chatId, sent.seq, 180_000);
    expect(reply.status).toBe('done');
    const colours = mock.toolResults.map((t) => t.match(/rgb\([^)]*\)/)?.[0]).filter(Boolean);
    expect(colours).toHaveLength(3);
    const [light, dark, back] = colours;
    expect(light).not.toBe(dark);
    expect(back).toBe(light);
    // The demo site's dark background is #0f0f14.
    expect(dark).toBe('rgb(15, 15, 20)');
  });
});
