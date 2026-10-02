// Against the real Claude Code CLI, talking to a mock Anthropic-compatible endpoint: other model
// providers, the context usage it reports, and the deny list holding even in 全自动.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, tempDir, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';
const hasCli = !!claudeCli();

describe.skipIf(!hasCli)('another model provider', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  const provider = () => ({ preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' });

  beforeAll(async () => {
    mock = await startMockProvider({ token: TOKEN });
    crew = await startServer({ fakeAgent: false });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('ships the presets and never the token', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.providers.length).toBeGreaterThanOrEqual(8);
    expect(b.providers.some((p: any) => p.id === 'deepseek' && p.baseUrl.includes('deepseek'))).toBe(true);
    expect('providerToken' in b.settings).toBe(false);
    expect(b.settings.hasProviderToken).toBe(false);
  });

  it('reports a wrong key with the reason, sent as a Bearer token, without saving', async () => {
    const t = await crew.api('POST', '/settings/test-connection', { authMode: 'provider', provider: provider(), providerToken: 'wrong' });
    expect(t.ok).toBe(false);
    expect(t.text).toMatch(/401|invalid|auth/i);
    expect(mock.requests.some((r) => r.auth === 'Bearer wrong')).toBe(true);
    expect(mock.requests.every((r) => !r.xApiKey)).toBe(true);
    expect((await crew.api('GET', '/bootstrap')).settings.authMode).toBe('claude-code');
  });

  it('passes the test with the right key', async () => {
    mock.requests.length = 0;
    const t = await crew.api('POST', '/settings/test-connection', { authMode: 'provider', provider: provider(), providerToken: TOKEN });
    expect(t.ok).toBe(true);
    expect(t.text).toContain('连接成功');
    expect(mock.requests.some((r) => r.model === 'mock-model')).toBe(true);
  });

  it('keeps the key on disk only', async () => {
    const saved = await crew.api('PATCH', '/settings', { authMode: 'provider', provider: provider(), providerToken: TOKEN });
    expect(saved.settings.authMode).toBe('provider');
    expect(saved.settings.hasProviderToken).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.parse(fs.readFileSync(path.join(crew.home, 'settings.json'), 'utf8')).providerToken).toBe(TOKEN);
    const auth = await crew.api('GET', '/auth?refresh=1');
    expect(auth.ready).toBe(true);
    expect(auth.method).toBe('provider');
  });

  it('runs a bot turn through the provider, ignoring a Claude model on the bot', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    await crew.api('PATCH', `/bots/${chief.id}`, { model: 'claude-opus-5' });
    mock.requests.length = 0;
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: '你好，请简单回复一句' });
    const reply = await waitTurn(crew.api, dm.id, sent.seq, 120_000);
    expect(reply.status).toBe('done');
    expect(reply.text).toContain('连接成功');
    const models = [...new Set(mock.requests.map((r) => r.model).filter(Boolean))];
    expect(models).toContain('mock-model');
    expect(models.some((m) => /claude/.test(String(m)))).toBe(false);
    const offenders = mock.requests.filter((r) => !(r.auth === `Bearer ${TOKEN}` && !r.xApiKey)).map((r) => ({ url: r.url, auth: r.auth, x: r.xApiKey, model: r.model }));
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
    // The context ring: Claude Code reports usage after the turn.
    const usage = await waitTurnContext(crew, dm.id, chief.id);
    expect(usage.used).toBeGreaterThan(0);
    expect(usage.max).toBeGreaterThan(0);
  });

  it('passes a provider model on the bot through', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    await crew.api('PATCH', `/bots/${chief.id}`, { model: 'mock-special' });
    mock.requests.length = 0;
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: '再回复一句' });
    await waitTurn(crew.api, dm.id, sent.seq, 120_000);
    expect(mock.requests.some((r) => r.model === 'mock-special')).toBe(true);
  });

  it('switches back to the Claude Code login', async () => {
    await crew.api('PATCH', '/settings', { authMode: 'claude-code' });
    expect((await crew.api('GET', '/auth?refresh=1')).method).not.toBe('provider');
  });
});

describe.skipIf(!hasCli)('the deny list', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  const bin = tempDir('crew-fake-bin');
  const ran = path.join(bin, 'ssh-ran');

  beforeAll(async () => {
    // A fake ssh first on PATH: what it was asked to do lands in a file.
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> ${ran}\necho fake\n`, { mode: 0o755 });
    // The model's first move is to ssh into a forbidden host; then it stops.
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) =>
        r.tools.includes('Bash') && !mock.toolResults.length
          ? { tool: { id: 'toolu_deny', name: 'Bash', input: { command: 'ssh prod-server uptime', description: 'Check the load' } } }
          : { text: '好的，不连服务器。' },
    });
    crew = await startServer({ fakeAgent: false, env: { PATH: `${bin}:${process.env.PATH}` } });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
      denyRules: ['Bash(*prod-server*)'],
    });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('refuses the command in 全自动 before it runs, and tells the model why', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.denyRules).toEqual(['Bash(*prod-server*)']);
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    await crew.api('PATCH', `/chats/${dm.id}`, { permission: 'auto' });
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: '看一下服务器的负载' });
    const reply = await waitTurn(crew.api, dm.id, sent.seq, 120_000);
    expect(reply.status).toBe('done');
    // Claude Code's own startup check may run ssh against github.com; the forbidden host never.
    expect(fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '').not.toContain('prod-server');
    expect(mock.toolResults.some((t) => t.includes('这个操作被禁止了'))).toBe(true);
    expect((reply.parts || []).some((p: any) => p.type === 'approval')).toBe(false);
  });

  it('rejects anything but a list of strings, and cleans it up', async () => {
    const r = await crew.api('PATCH', '/settings', { denyRules: [' Bash(*x*) ', '', 'Bash(*x*)', 42] });
    expect(r.settings.denyRules).toEqual(['Bash(*x*)']);
  });
});

/** The context usage Claude Code reported for the bot after its turn (recorded asynchronously). */
async function waitTurnContext(crew: CrewServer, chatId: string, botId: string) {
  for (let i = 0; i < 40; i++) {
    const c = (await crew.api('GET', '/bootstrap')).chats.find((x: any) => x.id === chatId);
    if (c?.context?.[botId]) return c.context[botId];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no context usage recorded');
}
