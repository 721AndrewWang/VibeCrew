// The model gateway (ADR 009) in a real Crew server: settings and keys through the API, failover
// and spend windows over the real 127.0.0.1 listener, and, with the Claude Code CLI installed, a
// bot turn whose calls go through the gateway to the provider that answers.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitFor, waitTurn } from '../helpers/server';

const KEY_A = 'key-of-account-a';
const KEY_B = 'key-of-account-b';

/** An account that is out of quota: every message is answered 429. */
async function outOfQuota(): Promise<{ url: string; hits: number; close(): Promise<void> }> {
  const out = { url: '', hits: 0, close: async () => {} };
  const srv = http.createServer((req, res) => {
    req.resume();
    out.hits++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' }).end('{"type":"error","error":{"type":"rate_limit_error","message":"quota used up"}}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  out.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  out.close = () => new Promise<void>((r) => srv.close(() => r()));
  return out;
}

describe('the model gateway', () => {
  let a: Awaited<ReturnType<typeof outOfQuota>>;
  let b: MockProvider;
  let crew: CrewServer;

  beforeAll(async () => {
    a = await outOfQuota();
    b = await startMockProvider({ token: KEY_B });
    crew = await startServer();
  });
  afterAll(async () => {
    await crew?.stop();
    await a?.close();
    await b?.close();
  });

  const settingsBody = () => ({
    gateway: {
      enabled: true,
      providers: [
        { id: 'acct-a', name: 'Account A', baseUrl: a.url, models: ['model-a'] },
        { id: 'acct-b', name: 'Account B', baseUrl: b.url, models: ['model-b'] },
      ],
      groups: [{ id: 'strong', members: ['acct-a/model-a', 'acct-b/model-b'] }],
      defaultTarget: 'strong',
    },
    gatewayTokens: { 'acct-a': KEY_A, 'acct-b': KEY_B },
  });

  it('is off by default: nothing listens and the connection is as before', async () => {
    const boot = await crew.api('GET', '/bootstrap');
    expect(boot.settings.gateway.enabled).toBe(false);
    expect((await crew.api('GET', '/gateway')).running).toBe(false);
    expect(fs.existsSync(path.join(crew.home, 'gateway'))).toBe(false);
  });

  it('saves providers and keys, keeps the keys on the server, and starts on 127.0.0.1', async () => {
    const r = await crew.api('PATCH', '/settings', settingsBody());
    expect(r.status).toBe(200);
    expect(r.settings.gateway.providers.map((p: any) => [p.id, p.hasToken])).toEqual([
      ['acct-a', true],
      ['acct-b', true],
    ]);
    const boot = JSON.stringify(await crew.api('GET', '/bootstrap'));
    expect(boot).not.toContain(KEY_A);
    expect(boot).not.toContain(KEY_B);
    const disk = JSON.parse(fs.readFileSync(path.join(crew.home, 'settings.json'), 'utf8'));
    expect(disk.gatewayTokens).toEqual({ 'acct-a': KEY_A, 'acct-b': KEY_B });
    const g = await crew.api('GET', '/gateway');
    expect(g.running).toBe(true);
    expect(g.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // A check started before the change (at startup) may still be answering: wait for a fresh one.
    await waitFor(async () => (await crew.api('GET', '/auth?refresh=1')).method === 'gateway', 30_000);
  });

  it('refuses requests without a scope credential', async () => {
    const { url } = await crew.api('GET', '/gateway');
    const r = await fetch(`${url}/s/bot/_/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${KEY_A}` }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('fails over to the next account when one is out of quota, and logs who answered', async () => {
    b.requests.length = 0;
    const t = await crew.api('POST', '/gateway/test', { target: 'strong' });
    expect(t.ok).toBe(true);
    expect(t.text).toContain('Connected');
    expect([t.provider, t.model]).toEqual(['acct-b', 'model-b']);
    expect(t.tries.map((x: any) => [x.member, x.outcome, x.status])).toEqual([
      ['acct-a/model-a', 'handed-on', 429],
      ['acct-b/model-b', 'answered', 200],
    ]);
    // Account b got its own key, and the model it was asked for.
    expect(b.requests[0].auth).toBe(`Bearer ${KEY_B}`);
    expect(b.requests[0].model).toBe('model-b');
    const g = await crew.api('GET', '/gateway');
    expect(g.calls[0]).toMatchObject({ role: 'oneshot', provider: 'acct-b', outcome: 'ok', tokens: { input: 10, output: 4 } });
    expect(g.byProvider['acct-b'].calls).toBe(1);
    expect(fs.existsSync(path.join(crew.home, 'gateway', 'calls.jsonl'))).toBe(true);
  });

  it('answers a spent window with 429 before any provider is asked', async () => {
    await crew.api('PATCH', '/settings', { gateway: { windows: [{ id: 'bg', role: 'oneshot', hours: 5, maxUsd: 0, maxTokens: 10 }] } });
    const before = a.hits + b.requests.length;
    const t = await crew.api('POST', '/gateway/test', { target: 'strong' });
    // (t.status is the API call's own status in this helper.)
    expect(t.ok).toBe(false);
    expect(t.text).toContain('"bg"');
    expect(a.hits + b.requests.length).toBe(before);
    const g = await crew.api('GET', '/gateway');
    expect(g.calls[0]).toMatchObject({ outcome: 'limited', window: 'bg' });
    expect(g.windows[0]).toMatchObject({ id: 'bg', spent: true });
    await crew.api('PATCH', '/settings', { gateway: { windows: [] } });
  });

  it('drops a removed provider’s key, and stops when turned off', async () => {
    const body = settingsBody();
    body.gateway.providers = body.gateway.providers.slice(1);
    await crew.api('PATCH', '/settings', { gateway: { providers: body.gateway.providers } });
    expect(JSON.parse(fs.readFileSync(path.join(crew.home, 'settings.json'), 'utf8')).gatewayTokens).toEqual({ 'acct-b': KEY_B });
    await crew.api('PATCH', '/settings', { gateway: { enabled: false } });
    expect((await crew.api('GET', '/gateway')).running).toBe(false);
    await waitFor(async () => (await crew.api('GET', '/auth?refresh=1')).method !== 'gateway', 30_000);
  });

  it('copies the current provider connection, key included', async () => {
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: b.url, model: 'conn-model', fastModel: '' }, providerToken: KEY_B });
    const r = await crew.api('POST', '/gateway/import-connection');
    expect(r.provider).toMatchObject({ id: 'custom', baseUrl: b.url, models: ['conn-model'] });
    expect(JSON.stringify(r)).not.toContain(KEY_B);
    expect(r.settings.gateway.providers.find((p: any) => p.id === 'custom').hasToken).toBe(true);
    await crew.api('PATCH', '/settings', { authMode: 'claude-code' });
  });

  it('refuses to copy the Claude Code login', async () => {
    expect((await crew.api('POST', '/gateway/import-connection')).status).toBe(400);
  });
});

describe.skipIf(!claudeCli())('a bot turn through the gateway (real Claude Code)', () => {
  let b: MockProvider;
  let crew: CrewServer;

  beforeAll(async () => {
    b = await startMockProvider({ token: KEY_B });
    crew = await startServer({ fakeAgent: false });
  });
  afterAll(async () => {
    await crew?.stop();
    await b?.close();
  });

  it('sends every call to the gateway, which routes it by the bot’s group, with the provider’s key', async () => {
    const boot = await crew.api('GET', '/bootstrap');
    const chief = boot.bots.find((x: any) => x.name === 'Chief');
    const dm = boot.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id);
    // Account a's endpoint is wrong (nothing listens): every call hands on to b.
    await crew.api('PATCH', '/settings', {
      gateway: {
        enabled: true,
        providers: [
          { id: 'acct-a', baseUrl: 'http://127.0.0.1:1', models: ['model-a'] },
          { id: 'acct-b', baseUrl: b.url, models: ['model-b'] },
        ],
        groups: [{ id: 'strong', members: ['acct-a/model-a', 'acct-b/model-b'] }],
        defaultTarget: 'acct-b/model-b',
      },
      gatewayTokens: { 'acct-a': KEY_A, 'acct-b': KEY_B },
    });
    await crew.api('PATCH', `/bots/${chief.id}`, { model: 'strong' });
    b.requests.length = 0;
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: 'Hi, please reply with one short line' });
    const reply = await waitTurn(crew.api, dm.id, sent.seq, 120_000);
    expect(reply.status).toBe('done');
    expect(reply.text).toContain('Connected');
    const calls = b.requests.filter((r) => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'));
    expect(calls.length).toBeGreaterThan(0);
    // Only the provider's own key reaches it, never the gateway's scope credential.
    expect(calls.every((r) => r.auth === `Bearer ${KEY_B}` && !r.xApiKey)).toBe(true);
    expect(calls.some((r) => r.model === 'model-b')).toBe(true);
    const g = await crew.api('GET', '/gateway');
    const turn = g.calls.find((c: any) => c.role === 'bot' && c.target === 'strong');
    expect(turn).toMatchObject({ botId: chief.id, provider: 'acct-b', outcome: 'ok' });
    expect(turn.tries[0]).toMatchObject({ member: 'acct-a/model-a', outcome: 'handed-on' });
  });
});
