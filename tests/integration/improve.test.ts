// Self-improvement, lightly: proposals tied to real turns, vetted, decided by the user, kept in a
// ledger, with before/after effects and a way back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

describe('in demo mode', () => {
  let crew: CrewServer;
  let chief: any;
  let dmId: string;
  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    chief = b.bots.find((x: any) => x.name === 'Chief');
    dmId = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
  });
  afterAll(() => crew?.stop());
  const turn = async (text: string) => {
    const sent = await crew.api('POST', `/chats/${dmId}/messages`, { text });
    return waitTurn(crew.api, dmId, sent.seq);
  };

  it('has nothing to analyse before any bot has worked', async () => {
    const r = await crew.api('POST', '/improvements/run');
    expect(r.status).toBe(409);
  });

  it('proposes a change tied to a real turn, and accepting it changes the bot', async () => {
    const reply = await turn('你好');
    const r = await crew.api('POST', '/improvements/run');
    expect(r.added).toHaveLength(1);
    const p = r.added[0];
    expect([p.botName, p.field, p.before, p.after, p.status]).toEqual(['Chief', 'freshSession', null, true, 'pending']);
    expect(p.evidence[0]).toMatchObject({ chatId: dmId, messageId: reply.id });
    // The same proposal is not made twice while pending.
    expect((await crew.api('POST', '/improvements/run')).added).toHaveLength(0);

    const a = await crew.api('POST', `/improvements/${p.id}/accept`);
    expect(a.improvement.status).toBe('accepted');
    expect((await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBe(true);
    expect((await crew.api('POST', `/improvements/${p.id}/accept`)).status).toBe(409);
  });

  it('compares the bot before and after the change', async () => {
    await turn('再来一次');
    const { items, effects } = await crew.api('GET', '/improvements');
    const e = effects[items[0].id];
    expect(e.before.turns).toBe(1);
    expect(e.after.turns).toBe(1);
    expect(e.after.avgCostUsd).toBeCloseTo(0.01, 5);
  });

  it('can be reverted', async () => {
    const { items } = await crew.api('GET', '/improvements');
    const r = await crew.api('POST', `/improvements/${items[0].id}/revert`);
    expect(r.improvement.status).toBe('reverted');
    expect((await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === chief.id).freshSession).toBeUndefined();
  });

  it('remembers a rejection and its reason, and does not propose it again', async () => {
    const p = (await crew.api('POST', '/improvements/run')).added[0];
    const r = (await crew.api('POST', `/improvements/${p.id}/reject`, { note: 'Chief 需要记得前情' })).improvement;
    expect([r.status, r.note]).toEqual(['rejected', 'Chief 需要记得前情']);
    const again = await crew.api('POST', '/improvements/run');
    expect(again.added).toHaveLength(0);
    expect(again.dropped).toContain('用户拒绝过一样的建议');
  });

  it('voids a proposal when the setting was changed by hand in the meantime', async () => {
    // A different bot, so the rejected Chief proposal does not block it.
    await crew.api('PATCH', `/bots/${chief.id}`, { freshSession: true });
    const pixel = (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.name === 'Pixel');
    const pdm = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === pixel.id).id;
    const sent = await crew.api('POST', `/chats/${pdm}/messages`, { text: '你好' });
    await waitTurn(crew.api, pdm, sent.seq);
    const p = (await crew.api('POST', '/improvements/run')).added.find((x: any) => x.botName === 'Pixel');
    await crew.api('PATCH', `/bots/${pixel.id}`, { freshSession: true });
    const r = await crew.api('POST', `/improvements/${p.id}/accept`);
    expect(r.status).toBe(409);
    expect(r.error).toContain('被改过了');
    expect((await crew.api('GET', '/improvements')).items.find((x: any) => x.id === p.id).status).toBe('stale');
  });
});

describe.skipIf(!claudeCli())('with a model', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let ref = '';
  let answer = '[]';

  beforeAll(async () => {
    // The proposer's prompt asks for a JSON array; everything else is an ordinary chat turn.
    mock = await startMockProvider({ token: TOKEN, reply: (r) => (JSON.stringify(r.body.messages || []).includes('只回复 JSON 数组') ? { text: answer } : { text: '好的。' }) });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', { authMode: 'provider', provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' }, providerToken: TOKEN });
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    const dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
    await crew.api('PATCH', `/chats/${dm}`, { permission: 'auto' });
    const sent = await crew.api('POST', `/chats/${dm}/messages`, { text: '你好' });
    const reply = await waitTurn(crew.api, dm, sent.seq, 120_000);
    ref = `${dm}/${reply.id}`;
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  it('sends the evidence and keeps only proposals that pass the checks', async () => {
    const good = { bot: 'Pixel', field: 'effort', after: 'low', rationale: '简单的改动用不着 medium', expected: '更便宜', evidence: [{ ref, note: '一次小改动' }] };
    answer = JSON.stringify([
      good,
      { ...good, bot: 'Nobody' },
      { ...good, bot: 'Lens', field: 'model', after: 'claude-haiku-4-5', evidence: [{ ref: 'c_x/m_none', note: '编的' }] },
      // Past the budget of three: not looked at.
      { ...good, bot: 'Probe', field: 'freshSession', after: true },
    ]);
    const r = await crew.api('POST', '/improvements/run');
    expect(r.status, r.error).toBe(200);
    expect(r.added.map((p: any) => `${p.botName}.${p.field}=${JSON.stringify(p.after)}`)).toEqual(['Pixel.effort="low"']);
    expect(r.dropped).toEqual(['没有叫 Nobody 的机器人', '引用的证据不存在', '超出每次 3 条的上限，多出的 1 条没看']);

    answer = JSON.stringify([{ ...good, after: 'ultra' }, good]);
    expect((await crew.api('POST', '/improvements/run')).dropped).toEqual(['effort 的新值不合法', '已经有一样的建议']);
    // The prompt carried the team, the turn it cited, and the rules.
    const sent = mock.requests.find((q) => JSON.stringify(q.body).includes('只回复 JSON 数组'))!;
    const text = JSON.stringify(sent.body);
    expect(text).toContain(ref.split('/')[1]);
    expect(text).toContain('### Probe');
  });

  it('says so when the model answers out of format', async () => {
    answer = '我觉得都挺好的';
    const r = await crew.api('POST', '/improvements/run');
    expect(r.status).toBe(502);
    expect(r.error).toContain('格式');
  });
});
