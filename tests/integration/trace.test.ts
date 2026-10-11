// A turn's trajectory, read back from Claude Code's transcript: the real CLI against the mock
// model, so the transcript is the real thing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';

describe.skipIf(!claudeCli())('turn traces', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  let chatId: string;

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) =>
        r.tools.includes('Bash') && !mock.toolResults.some((t) => t.includes('trace-marker'))
          ? { tool: { id: 'toolu_tr1', name: 'Bash', input: { command: 'echo trace-marker', description: 'Say hello' } } }
          : { text: 'OK.' },
    });
    // The transcript folder is keyed by the config dir, which startServer isolates; point it at the real one is not needed: the server reads what the CLI it spawned wrote.
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
      sandbox: { enabled: false },
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

  it('records where the turn is, and reads back its calls, tool result and prompt', async () => {
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'Say hello' });
    const reply = await waitTurn(crew.api, chatId, sent.seq, 120_000);
    expect(reply.status).toBe('done');
    expect(reply.meta.trace).toMatchObject({ sessionId: expect.any(String), cwd: expect.any(String) });
    const t = await crew.api('GET', `/chats/${chatId}/messages/${reply.id}/trace`);
    expect(t.available, t.reason).toBe(true);
    const kinds = t.steps.map((s: any) => s.kind);
    expect(kinds[0]).toBe('prompt');
    expect(t.steps[0].text).toContain('Say hello');
    expect(kinds.filter((k: string) => k === 'model').length).toBeGreaterThanOrEqual(2);
    const call = t.steps.find((s: any) => s.kind === 'model' && s.blocks.some((b: any) => b.type === 'tool_use'));
    expect(call.model).toBe('mock-model');
    expect(call.blocks.find((b: any) => b.type === 'tool_use').input).toContain('trace-marker');
    expect(t.steps.find((s: any) => s.kind === 'tool_result').text).toContain('trace-marker');
    expect(t.totals.calls).toBeGreaterThanOrEqual(2);
    expect(t.totals.tools).toBe(1);
    expect(t.totals.output).toBeGreaterThan(0);
  });

  it('serves the raw rows as JSON Lines', async () => {
    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=5`);
    const m = messages.filter((x: any) => x.role === 'bot').at(-1);
    const r = await fetch(`${crew.base}/api/chats/${chatId}/messages/${m.id}/trace?raw=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('ndjson');
    const lines = (await r.text()).trim().split('\n');
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('says so when a turn has no trace', async () => {
    const r = await crew.api('GET', `/chats/${chatId}/messages/nope/trace`);
    expect(r.status).toBe(404);
  });
});
