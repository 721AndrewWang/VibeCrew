// A role is a capability profile, not only a persona: the template sets its model tier, effort,
// permission and edit scope; edits outside the scope are refused; spend is tracked per bot and a
// monthly budget stops the bot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor, waitTurn } from '../helpers/server';

let crew: CrewServer;
let projectId: string;

beforeAll(async () => {
  crew = await startServer();
  projectId = (await crew.api('GET', '/bootstrap')).projects[0].id;
});
afterAll(() => crew?.stop());

const lastSystem = async (chatId: string) => {
  const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
  return messages.filter((m: any) => m.role === 'system').at(-1)?.text || '';
};

describe('templates', () => {
  it('give each role a model tier, effort, permission and (for the tester) an edit scope', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const by = (name: string) => b.bots.find((x: any) => x.name === name);
    expect(by('Chief').effort).toBe('high');
    expect([by('Pixel').model, by('Pixel').effort, by('Pixel').permission]).toEqual(['claude-sonnet-5', 'medium', 'edits']);
    expect([by('Lens').model, by('Lens').effort, by('Lens').permission, by('Lens').blindReview]).toEqual(['claude-sonnet-5', 'low', 'plan', true]);
    expect(by('Probe').editScope).toContain('tests/**');
    expect(by('Chief').editScope).toBeUndefined();
    expect([by('Probe').freshSession, by('Lens').freshSession, by('Chief').freshSession, by('Pixel').freshSession]).toEqual([true, true, undefined, undefined]);
    expect(b.models.find((m: any) => m.id === 'claude-haiku-4-5').tier).toBe('low');
    const quill = await crew.api('POST', '/bots', { template: 'quill' });
    expect([quill.model, quill.effort]).toEqual(['claude-haiku-4-5', 'low']);
  });
  it('shows the profile on the template cards', async () => {
    const t = (await crew.api('GET', '/bootstrap')).templates.find((x: any) => x.id === 'probe');
    expect(t.model).toBe('claude-sonnet-5');
    expect(t.editScope.length).toBeGreaterThan(0);
  });
});

describe('edit scope', () => {
  it('is saved cleaned, and cleared by an empty list', async () => {
    const bot = await crew.api('POST', '/bots', { name: 'Scoped', title: 't', editScope: [' docs/** ', '', 'docs/**'] });
    expect(bot.editScope).toEqual(['docs/**']);
    expect((await crew.api('PATCH', `/bots/${bot.id}`, { editScope: [] })).editScope).toBeUndefined();
    expect((await crew.api('PATCH', `/bots/${bot.id}`, { editScope: 'docs/**' })).status).toBe(400);
  });
  it("refuses the demo bot's write outside its lane, with the reason in the chat", async () => {
    const bot = await crew.api('POST', '/bots', { name: 'Tester', title: 't', permission: 'auto', editScope: ['tests/**'], projectId });
    const chatId = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === bot.id).id;
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'Make me a page' });
    const reply = await waitTurn(crew.api, chatId, sent.seq);
    expect(reply.status).toBe('done');
    const write = reply.parts.find((p: any) => p.type === 'tool' && p.name === 'Write');
    expect(write.status).toBe('error');
    expect(JSON.stringify(write)).toContain('outside your area');
    expect(JSON.stringify(write)).toContain('tests/**');
  });
});

describe('spend and budget', () => {
  let bot: any;
  let chatId: string;
  beforeAll(async () => {
    bot = await crew.api('POST', '/bots', { name: 'Thrifty', title: 't', permission: 'auto', projectId });
    chatId = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === bot.id).id;
  });
  const turn = async (text: string) => {
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text });
    return waitTurn(crew.api, chatId, sent.seq);
  };

  it("adds each turn's cost to the bot's usage, today and this month", async () => {
    await turn('Hello');
    const u = await waitFor(async () => (await crew.api('GET', '/usage'))[bot.id]);
    expect(u.month.turns).toBe(1);
    expect(u.today.costUsd).toBeCloseTo(0.01, 5);
    expect((await crew.api('GET', '/bootstrap')).usage[bot.id].month.costUsd).toBeCloseTo(0.01, 5);
  });

  it("counts each turn's own share of the session's running totals, with the cache it read", async () => {
    await turn('Again');
    await turn('Round three');
    const u = (await crew.api('GET', '/usage'))[bot.id].month;
    expect(u.turns).toBe(3);
    // The demo agent reports 0.01, 0.02, 0.03 as the session goes: three cents, not six.
    expect(u.costUsd).toBeCloseTo(0.03, 5);
    expect(u.tokenTurns).toBe(3);
    // Re-reads of 17.5k, 23k and 28.5k; 2k written to the cache and 50 uncached each turn.
    expect(u.tokens).toEqual({ input: 150, cacheRead: 69_000, cacheWrite: 6_000, output: 360 });
    expect(u.peak.cacheRead).toBe(28_500);
    expect(u.peak.chatId).toBe(chatId);
  });

  it('stops the bot once the monthly budget is spent, and tells the chat once', async () => {
    expect((await crew.api('PATCH', `/bots/${bot.id}`, { monthlyBudgetUsd: 0.035 })).monthlyBudgetUsd).toBe(0.035);
    await turn('One more time'); // 0.04 ≥ 0.035 after this one
    const before = (await crew.api('GET', `/chats/${chatId}/messages?limit=30`)).messages.length;
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'Can you still work?' });
    await waitFor(async () => (await lastSystem(chatId)).includes('budget'), 10_000);
    expect(await lastSystem(chatId)).toContain('$0.04');
    await new Promise((r) => setTimeout(r, 1500));
    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
    expect(messages.some((m: any) => m.role === 'bot' && m.seq > sent.seq)).toBe(false);
    expect(messages.length).toBe(before + 2); // the user's message and one notice
    expect((await crew.api('GET', '/bootstrap')).statuses[bot.id].state).toBe('idle');
  });

  it('works again once the budget is raised or removed', async () => {
    expect((await crew.api('PATCH', `/bots/${bot.id}`, { monthlyBudgetUsd: null })).monthlyBudgetUsd).toBeUndefined();
    expect((await turn('How about now')).status).toBe('done');
  });
});
