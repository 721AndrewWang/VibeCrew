// Shadow routing: for untargeted group messages a cheap model's guess is recorded beside what the
// lead actually did; nothing about where the message goes changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitFor } from '../helpers/server';

async function sayInGroup(crew: CrewServer, groupId: string, text: string) {
  const sent = await crew.api('POST', `/chats/${groupId}/messages`, { text });
  await waitFor(async () => {
    const b = await crew.api('GET', '/bootstrap');
    const { messages } = await crew.api('GET', `/chats/${groupId}/messages?limit=40`);
    return messages.some((m: any) => m.seq > sent.seq && m.role === 'bot' && m.status === 'done') && Object.values(b.statuses).every((s: any) => s.state === 'idle');
  }, 60_000);
  return sent;
}

describe('in demo mode', () => {
  let crew: CrewServer;
  let group: any;
  let names: Record<string, string>;
  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    names = Object.fromEntries(b.bots.map((x: any) => [x.id, x.name]));
  });
  afterAll(() => crew?.stop());

  it('is on by default and records a guess without changing who answers', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.routing.mode).toBe('shadow');
    await sayInGroup(crew, group.id, '你好');
    const r = await waitFor(async () => (await crew.api('GET', '/routing')).recent[0]);
    expect(r.backend).toBe('fake');
    expect(names[r.leadId]).toBe('Chief');
    expect(r.candidates).toHaveLength(4);
    expect(r.confidence).toBeCloseTo(0.55, 5);
    // The lead did it alone: that is the label, and the guess (the lead) agrees.
    expect(r.label).toBe(r.leadId);
  });

  it('labels a handover with the teammate the lead handed to', async () => {
    await sayInGroup(crew, group.id, '把这个任务拆分一下交给队友');
    const report = await crew.api('GET', '/routing');
    const r = report.recent[0];
    expect(names[r.label]).toBe('Pixel');
    expect(r.choice).toBe(r.leadId);
    expect(report.labeled).toBe(2);
    expect(report.agreement).toBe(0.5);
    expect(report.needed).toBe(98);
    expect(report.threshold).toBeNull();
    // The handover was guessed at 0.95 and wrong, the solo turn at 0.55 and right: confidence points the wrong way.
    expect(report.auroc).toBe(0);
    expect(report.confident).toEqual({ n: 1, wrong: 1 });
  });

  it('records nothing for @-mentions, direct chats, or when switched off', async () => {
    const before = (await crew.api('GET', '/routing')).recent.length;
    await sayInGroup(crew, group.id, '@Pixel 改一下标题');
    await crew.api('PATCH', '/settings', { routing: { mode: 'off' } });
    await sayInGroup(crew, group.id, '再看看');
    expect((await crew.api('GET', '/routing')).recent).toHaveLength(before);
    expect((await crew.api('GET', '/routing')).mode).toBe('off');
  });
});

describe.skipIf(!claudeCli())('with a model', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let answer: (order: string[]) => string;

  beforeAll(async () => {
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        const text = JSON.stringify(r.body.messages || []);
        if (!text.includes('probabilities')) return { text: '好的。' };
        // The order the candidates were listed in, as the router sent them.
        const order = [...text.matchAll(/- (\w+)：/g)].map((m) => m[1]);
        return { text: answer(order) };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('asks in both orders with a bare prompt and averages away a first-position bias', async () => {
    // A judge that gives whoever is listed first 0.7 and splits the rest.
    answer = (order) => JSON.stringify({ probabilities: Object.fromEntries(order.map((n, i) => [n, i === 0 ? 0.7 : 0.3 / (order.length - 1)])) });
    const group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
    mock.requests.length = 0;
    await crew.api('POST', `/chats/${group.id}/messages`, { text: '首页标题改一下' });
    const r = await waitFor(async () => (await crew.api('GET', '/routing')).recent[0], 60_000);
    const asks = mock.requests.filter((q) => JSON.stringify(q.body.messages ?? []).includes('probabilities'));
    expect(asks, JSON.stringify(r)).toHaveLength(2);
    // Bare: no tools offered, Crew's own short system prompt.
    expect(asks.every((q) => q.tools.length === 0)).toBe(true);
    expect(JSON.stringify(asks[0].body.system)).toContain('分类器');
    // First and last listed each get (0.7 + 0.1) / 2; the middle two 0.1. Low confidence: escalate.
    expect(r.backend).toBe('haiku');
    expect(r.confidence).toBeCloseTo(0.4, 5);
    expect(r.invalid).toBeUndefined();
  });

  it('records an unusable answer as invalid', async () => {
    answer = () => '我觉得 Pixel 比较合适';
    const group = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
    await crew.api('POST', `/chats/${group.id}/messages`, { text: '再改一下' });
    const r = await waitFor(async () => {
      const top = (await crew.api('GET', '/routing')).recent[0];
      return top?.text === '再改一下' ? top : null;
    }, 60_000);
    expect(r.invalid).toBeTruthy();
    expect(r.choice).toBeUndefined();
  });
});
