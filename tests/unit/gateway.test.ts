// The model gateway (ADR 009): routing rules, spend windows, masking, the SSE parser, and the
// request handler driven against local fake upstreams (failover order, streaming pass-through,
// windows answered before any provider is asked, masking round-trips).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { membersOf, normalizeGateway, routeFor } from '../../server/gateway/config';
import { Masker, restoreMessage, restoreText, StreamRestorer } from '../../server/gateway/mask';
import { estimateCost, priceOf } from '../../server/gateway/pricing';
import { type GatewayDeps, handleGateway, parsePath, shouldHandOn } from '../../server/gateway/proxy';
import { SseParser } from '../../server/gateway/sse';
import { windowState } from '../../server/gateway/windows';
import type { GatewayCall, GatewaySettings } from '../../shared/types';

const H = 3_600_000;

describe('routing', () => {
  const gw = normalizeGateway({
    providers: [
      { id: 'a', baseUrl: 'http://127.0.0.1:1', models: ['m1'] },
      { id: 'b', baseUrl: 'http://127.0.0.1:2', auth: 'x-api-key' },
      { id: 'bad id', baseUrl: 'http://x' },
      { id: 'nourl', baseUrl: 'ftp://x' },
    ],
    groups: [{ id: 'strong', members: ['a/m1', 'b/m2', 'not-an-address'] }],
    defaultTarget: 'a/m1',
    roles: { router: 'b/light', bogus: 'x' },
    windows: [{ role: 'worker', hours: 5, maxUsd: 1 }, { role: 'nope' }],
  });

  it('keeps what parses and drops the rest', () => {
    expect(gw.providers.map((p) => p.id)).toEqual(['a', 'b']);
    expect(gw.providers[1].auth).toBe('x-api-key');
    expect(gw.groups[0].members).toEqual(['a/m1', 'b/m2']);
    expect(gw.roles).toEqual({ router: 'b/light' });
    expect(gw.windows).toHaveLength(1);
    expect(gw.enabled).toBe(false);
    expect(gw.masking).toBe(false);
  });

  it('the role override first, then an address asked for, then the default', () => {
    expect(routeFor(gw, { role: 'router', botId: 'x' }, 'strong')).toBe('b/light');
    expect(routeFor(gw, { role: 'bot', botId: 'x' }, 'strong')).toBe('strong');
    expect(routeFor(gw, { role: 'worker', botId: 'x' }, 'b/whatever[1m]')).toBe('b/whatever');
    expect(routeFor(gw, { role: 'bot' }, 'claude-opus-5-5')).toBe('a/m1');
    expect(routeFor(gw, { role: 'bot' }, 'zz/unknown-provider')).toBe('a/m1');
    expect(routeFor({ ...gw, defaultTarget: '' }, { role: 'bot' }, 'claude-opus-5-5')).toBeUndefined();
  });

  it('expands a group in order and passes the asked-for model to a * member', () => {
    expect(membersOf(gw, 'strong')).toEqual(['a/m1', 'b/m2']);
    expect(membersOf(gw, 'a/x')).toEqual(['a/x']);
    const pass = { ...gw, groups: [{ id: 'p', members: ['a/*', 'b/m2'] }] };
    expect(membersOf(pass, 'p', 'claude-sonnet-5')).toEqual(['a/claude-sonnet-5', 'b/m2']);
    expect(membersOf(pass, 'p', 'p')).toEqual(['a/*', 'b/m2']);
  });

  it('parses the scope from the path', () => {
    expect(parsePath('/s/worker/b_1/v1/messages?beta=true')).toEqual({ scope: { role: 'worker', botId: 'b_1' }, endpoint: 'messages', search: '?beta=true' });
    expect(parsePath('/s/oneshot/_/v1/messages/count_tokens')?.scope).toEqual({ role: 'oneshot', botId: undefined });
    expect(parsePath('/s/root/_/v1/messages')).toBeNull();
    expect(parsePath('/v1/messages')).toBeNull();
  });

  it('hands on rate limits, outages and quota errors, not bad requests', () => {
    expect(shouldHandOn(429, '')).toBe(true);
    expect(shouldHandOn(529, '')).toBe(true);
    expect(shouldHandOn(503, '')).toBe(true);
    expect(shouldHandOn(402, '{"error":{"message":"Insufficient balance"}}')).toBe(true);
    expect(shouldHandOn(403, 'You exceeded your current quota')).toBe(true);
    expect(shouldHandOn(400, '{"error":{"type":"invalid_request_error","message":"messages: field required"}}')).toBe(false);
    expect(shouldHandOn(401, 'invalid x-api-key')).toBe(false);
  });

  it('estimates cost from the provider price, else Claude list prices', () => {
    const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(estimateCost(t, priceOf({ price: { input: 1, output: 2 } }, 'x'))).toBeCloseTo(3.1);
    expect(estimateCost(t, priceOf(undefined, 'claude-opus-5-5'))).toBeCloseTo(24.4);
    expect(priceOf(undefined, 'deepseek-flash')).toEqual({ input: 0, output: 0 });
  });
});

const call = (at: number, p: Partial<GatewayCall> = {}): GatewayCall => ({
  id: `c${at}`,
  at,
  role: 'worker',
  botId: 'b1',
  requested: 'x',
  target: 'x',
  outcome: 'ok',
  status: 200,
  tries: [],
  costUsd: 0.4,
  tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
  latencyMs: 1,
  stream: false,
  ...p,
});

describe('spend windows', () => {
  const now = 1_800_000_000_000;
  const w = { id: 'five', role: 'worker' as const, hours: 5, maxUsd: 1, maxTokens: 0 };

  it('sums the calls of its role inside the window', () => {
    const calls = [call(now - 6 * H), call(now - 4 * H), call(now - 1 * H), call(now - H, { role: 'router' }), call(now - H, { outcome: 'limited' })];
    const s = windowState(w, calls, now);
    expect(s.usedUsd).toBeCloseTo(0.8);
    expect(s.spent).toBe(false);
  });

  it('is spent at the limit, and reopens when the oldest calls age out', () => {
    const calls = [call(now - 4 * H), call(now - 2 * H), call(now - 1 * H)];
    const s = windowState(w, calls, now);
    expect(s.spent).toBe(true);
    // Dropping the call from 4 h ago leaves $0.8: one hour from now.
    expect(s.retryAfterSec).toBe(3600);
  });

  it('can be about one bot, and about tokens', () => {
    const bot = { ...w, botId: 'b2', maxUsd: 0, maxTokens: 150 };
    expect(windowState(bot, [call(now - H), call(now - H)], now).spent).toBe(false);
    expect(windowState(bot, [call(now - H, { botId: 'b2' }), call(now - H, { botId: 'b2' })], now).spent).toBe(true);
  });
});

describe('masking', () => {
  const secrets = 'Email ana@example.org, key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF, PASSWORD=hunter2!, token: ghp_abcdefghijklmnopqrstuvwxyz0123456789';

  it('replaces keys, passwords and emails, the same way every time', () => {
    const m = new Masker('salt');
    const out = m.text(secrets);
    expect(out).not.toMatch(/ana@example|sk-ant|hunter2|ghp_/);
    expect(out).toMatch(/CREW_MASKED_EMAIL_[0-9a-f]{8}/);
    expect(out).toMatch(/PASSWORD=CREW_MASKED_PASSWORD_[0-9a-f]{8}/);
    expect(new Masker('salt').text(secrets)).toBe(out);
    expect(m.count).toBe(4);
    expect(restoreText(out, m.map)).toBe(secrets);
  });

  it('leaves code and plain words alone', () => {
    const m = new Masker('salt');
    const code = 'function f(token: string, password = getPassword()) { return max_tokens = 4096 }';
    expect(m.text(code)).toBe(code);
    expect(m.count).toBe(0);
  });

  it('masks the prompt but never thinking, images or tool definitions', () => {
    const m = new Masker('salt');
    const body = {
      model: 'x',
      tools: [{ name: 'login', description: 'password=hunter2! example' }],
      system: [{ type: 'text', text: 'Contact ana@example.org' }],
      messages: [
        { role: 'user', content: 'my password: s3cr3t-pw' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'ana@example.org', signature: 'sig' },
            { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" x' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok ana@example.org' }] }] },
      ],
    };
    const out = m.request(body) as any;
    const s = JSON.stringify(out);
    expect(s).not.toContain('s3cr3t-pw');
    expect(s).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(out.messages[1].content[0].thinking).toBe('ana@example.org');
    expect(out.tools).toEqual(body.tools);
    expect(out.messages[2].content[0].content[0].text).toMatch(/^ok CREW_MASKED_EMAIL_/);
  });

  it('restores a whole answer: text and tool input, not thinking', () => {
    const m = new Masker('salt');
    const p = m.text('ana@example.org');
    const msg = restoreMessage(
      {
        content: [
          { type: 'thinking', thinking: p },
          { type: 'text', text: `Sent to ${p}` },
          { type: 'tool_use', input: { to: [p] } },
        ],
      },
      m.map,
    ) as any;
    expect(msg.content[0].thinking).toBe(p);
    expect(msg.content[1].text).toBe('Sent to ana@example.org');
    expect(msg.content[2].input.to[0]).toBe('ana@example.org');
  });

  it('restores a placeholder split across stream deltas, JSON-escaped in tool input', () => {
    // A value that needs escaping inside JSON (a password with a quote and a backslash).
    const m = new Masker('salt');
    const placeholder = 'CREW_MASKED_PASSWORD_0123abcd';
    m.map.set(placeholder, 'pa"ss\\1');
    const text = `pw is ${placeholder}.`;
    for (const size of [1, 3, 7, 13]) {
      const r = new StreamRestorer(m.map);
      let out = '';
      for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
      out += r.flush();
      expect(out).toBe('pw is pa"ss\\1.');
    }
    const json = new StreamRestorer(m.map, true);
    const out = json.push(`{"p":"${placeholder.slice(0, 15)}`) + json.push(`${placeholder.slice(15)}"}`) + json.flush();
    expect(JSON.parse(out)).toEqual({ p: 'pa"ss\\1' });
    // Text that only looks like the start of one is released at the end.
    const r = new StreamRestorer(m.map);
    expect(r.push('see CREW_MAS')).toBe('see ');
    expect(r.flush()).toBe('CREW_MAS');
  });
});

describe('the SSE parser', () => {
  it('yields whole events, whatever the chunking, with their raw text', () => {
    const text = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type": "ping"}\n\n';
    const p = new SseParser();
    const evs = [...text].flatMap((ch) => p.push(ch));
    expect(evs.map((e) => e.event)).toEqual(['message_start', 'ping']);
    expect(evs.map((e) => e.raw).join('')).toBe(text);
    expect((evs[1].data as any).type).toBe('ping');
  });
});

// ------------------------------------------------------------------ the handler

type Behaviour = (body: any, req: http.IncomingMessage, res: http.ServerResponse) => void;

interface Fake {
  url: string;
  hits: { body: any; auth: string; xApiKey: string; url: string }[];
  behave: Behaviour;
  close(): Promise<void>;
}

async function fakeUpstream(behave: Behaviour): Promise<Fake> {
  const fake: Fake = { url: '', hits: [], behave, close: async () => {} };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      fake.hits.push({ body, auth: String(req.headers.authorization || ''), xApiKey: String(req.headers['x-api-key'] || ''), url: req.url || '' });
      fake.behave(body, req, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => srv.close(() => r()));
  return fake;
}

const json = (status: number, data: unknown) => (_b: any, _q: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
const answer = (text: string) => json(200, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } });

/** A streamed answer, written in small pieces so events straddle chunks. */
function sseEvents(text: string, model = 'm'): string {
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    ev('message_start', { type: 'message_start', message: { id: 'msg_s', model, role: 'assistant', content: [], usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 1 } } }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...text.match(/.{1,4}/gs)!.map((t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    ev('message_stop', { type: 'message_stop' }),
  ].join('');
}

const stream = (text: string) => (_b: any, _q: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const all = sseEvents(text);
  let i = 0;
  const tick = () => {
    if (i >= all.length) return res.end();
    res.write(all.slice(i, i + 37));
    i += 37;
    setImmediate(tick);
  };
  tick();
};

describe('the gateway handler', () => {
  let a: Fake;
  let b: Fake;
  let c: Fake;
  let gw: GatewaySettings;
  let log: GatewayCall[];
  let base = '';
  let srv: http.Server;
  let n = 0;
  const deps: GatewayDeps = {
    settings: () => gw,
    token: (id) => `key-${id}`,
    verify: (scope, token) => token === `tok-${scope.role}`,
    calls: () => log,
    record: (x) => log.push(structuredClone(x)),
    maskSalt: () => 'salt',
    newId: () => `gc_${++n}`,
  };

  beforeAll(async () => {
    a = await fakeUpstream(answer('from a'));
    b = await fakeUpstream(answer('from b'));
    c = await fakeUpstream(answer('from c'));
    srv = http.createServer((req, res) => void handleGateway(req, res, deps));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all([a, b, c].map((f) => f.close()));
    await new Promise<void>((r) => srv.close(() => r()));
  });
  afterEach(() => {
    for (const f of [a, b, c]) f.hits.length = 0;
  });

  const setup = (patch: Partial<GatewaySettings> = {}) => {
    log = [];
    gw = normalizeGateway({
      enabled: true,
      providers: [
        { id: 'a', baseUrl: a.url, models: ['ma'] },
        { id: 'b', baseUrl: b.url, auth: 'x-api-key' },
        { id: 'c', baseUrl: c.url, price: { input: 1, output: 1 } },
      ],
      groups: [{ id: 'g', members: ['a/ma', 'b/mb', 'c/mc'] }],
      defaultTarget: 'g',
      ...patch,
    });
    a.behave = answer('from a');
    b.behave = answer('from b');
    c.behave = answer('from c');
  };

  const post = (body: unknown, role = 'worker', bot = 'b1') =>
    fetch(`${base}/s/${role}/${bot}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: `Bearer tok-${role}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });

  it('refuses a credential made for another scope', async () => {
    setup();
    const r = await post({ model: 'g', messages: [] }, 'worker');
    expect(r.status).toBe(200);
    const bad = await fetch(`${base}/s/router/_/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer tok-worker' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(a.hits).toHaveLength(1);
  });

  it('asks the members in order and hands on 429, 5xx and quota errors', async () => {
    setup();
    a.behave = json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    b.behave = json(402, { type: 'error', error: { type: 'billing_error', message: 'Insufficient balance' } });
    const r = await post({ model: 'g', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect((await r.json()).content[0].text).toBe('from c');
    // Each member got its own model and its own credential.
    expect(a.hits[0].body.model).toBe('ma');
    expect(a.hits[0].auth).toBe('Bearer key-a');
    expect(b.hits[0].xApiKey).toBe('key-b');
    expect(b.hits[0].auth).toBe('');
    expect(c.hits[0].body.model).toBe('mc');
    expect(c.hits[0].url).toBe('/v1/messages?beta=true');
    const [rec] = log;
    expect(rec).toMatchObject({ role: 'worker', botId: 'b1', target: 'g', provider: 'c', model: 'mc', outcome: 'ok', status: 200, tokens: { input: 10, output: 5 } });
    expect(rec.tries.map((t) => [t.member, t.outcome, t.status])).toEqual([
      ['a/ma', 'handed-on', 429],
      ['b/mb', 'handed-on', 402],
      ['c/mc', 'answered', 200],
    ]);
    expect(rec.costUsd).toBeCloseTo(15 / 1e6);
    expect(r.headers.get('x-crew-call')).toBe(rec.id);
  });

  it('hands on a provider that cannot be reached', async () => {
    setup({ providers: [{ id: 'dead', baseUrl: 'http://127.0.0.1:1', models: [], auth: 'bearer' }, ...normalizeGateway({ providers: [{ id: 'b', baseUrl: b.url }] }).providers], groups: [{ id: 'g', members: ['dead/x', 'b/mb'] }] });
    const r = await post({ model: 'g', messages: [] });
    expect((await r.json()).content[0].text).toBe('from b');
    expect(log[0].tries[0]).toMatchObject({ member: 'dead/x', outcome: 'handed-on' });
  });

  it('passes a request error back at once, without trying the others', async () => {
    setup();
    a.behave = json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: required' } });
    const r = await post({ model: 'g', messages: [] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe('max_tokens: required');
    expect(b.hits).toHaveLength(0);
    expect(log[0]).toMatchObject({ outcome: 'error', provider: 'a', status: 400 });
    expect(log[0].tries[0].outcome).toBe('failed');
  });

  it('when every member refuses, passes on the last refusal', async () => {
    setup({ groups: [{ id: 'g', members: ['a/ma', 'b/mb'] }] });
    a.behave = json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
    b.behave = (_b, _q, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }).end('{"type":"error","error":{"type":"rate_limit_error","message":"b is out"}}');
    const r = await post({ model: 'g', messages: [] });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('7');
    expect((await r.json()).error.message).toBe('b is out');
    expect(log[0].outcome).toBe('error');
  });

  it('streams through byte for byte, and fails over before the first byte', async () => {
    setup();
    a.behave = (_b, _q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
    };
    b.behave = stream('Hello from the second member, streamed in pieces.');
    const r = await post({ model: 'g', stream: true, messages: [] });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(await r.text()).toBe(sseEvents('Hello from the second member, streamed in pieces.'));
    expect(log[0]).toMatchObject({ provider: 'b', stream: true, outcome: 'ok', tokens: { input: 20, cacheRead: 5, output: 7 } });
    expect(log[0].tries.map((t) => t.outcome)).toEqual(['handed-on', 'answered']);
    expect(c.hits).toHaveLength(0);
  });

  it('answers a spent window with 429 and Retry-After before any provider is asked', async () => {
    setup({ windows: [{ id: 'workers-5h', role: 'worker', hours: 5, maxUsd: 1, maxTokens: 0 }] });
    log.push(call(Date.now() - H, { costUsd: 1.2 }));
    const r = await post({ model: 'g', messages: [] });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(3 * 3600);
    expect(r.headers.get('x-should-retry')).toBe('false');
    expect((await r.json()).error.message).toContain('workers-5h');
    expect(a.hits.length + b.hits.length + c.hits.length).toBe(0);
    expect(log[1]).toMatchObject({ outcome: 'limited', window: 'workers-5h' });
    // Another role is not covered by it.
    expect((await post({ model: 'g', messages: [] }, 'router', '_')).status).toBe(200);
  });

  it('masks what leaves and restores what comes back, streamed or not', async () => {
    setup({ masking: true });
    const secret = 'my key is sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF and mail ana@example.org';
    a.behave = (body, _q, res) => {
      const text = body.messages[0].content as string;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text: `echo: ${text}` }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: text } }], usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    const r = await post({ model: 'g', messages: [{ role: 'user', content: secret }] });
    const j = await r.json();
    expect(a.hits[0].body.messages[0].content).not.toMatch(/sk-ant|ana@/);
    expect(j.content[0].text).toBe(`echo: ${secret}`);
    expect(j.content[1].input.command).toBe(secret);
    expect(log[0].masked).toBe(2);

    a.hits.length = 0;
    a.behave = (body, q, res) => stream(`echo: ${body.messages[0].content}`)(body, q, res);
    const s = await post({ model: 'g', stream: true, messages: [{ role: 'user', content: secret }] });
    const text = await s.text();
    expect(a.hits[0].body.messages[0].content).not.toMatch(/sk-ant|ana@/);
    const deltas = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
      .filter((d) => d.type === 'content_block_delta')
      .map((d) => d.delta.text)
      .join('');
    expect(deltas).toBe(`echo: ${secret}`);
  });

  it('routes a non-address to the default, and refuses when there is none', async () => {
    setup({ defaultTarget: 'c/fallback' });
    await post({ model: 'claude-haiku-4-5', messages: [] });
    expect(c.hits[0].body.model).toBe('fallback');
    setup({ defaultTarget: '' });
    const r = await post({ model: 'claude-haiku-4-5', messages: [] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/No gateway route/);
  });

  it('forwards count_tokens without logging it', async () => {
    setup();
    const r = await fetch(`${base}/s/bot/b1/v1/messages/count_tokens`, { method: 'POST', headers: { authorization: 'Bearer tok-bot' }, body: JSON.stringify({ model: 'g', messages: [] }) });
    expect(r.status).toBe(200);
    expect(a.hits[0].url).toBe('/v1/messages/count_tokens');
    expect(log).toHaveLength(0);
  });
});
