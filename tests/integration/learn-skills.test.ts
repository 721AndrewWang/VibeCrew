// Learning skills from experience, gated: complex finished turns become candidates, a draft is
// written on request and becomes a pending proposal; only accepting it saves the skill.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

describe('in demo mode', () => {
  let crew: CrewServer;
  let dm: string;
  beforeAll(async () => {
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
  });
  afterAll(() => crew?.stop());
  const turn = async (text: string) => {
    const sent = await crew.api('POST', `/chats/${dm}/messages`, { text });
    return waitTurn(crew.api, dm, sent.seq);
  };

  it('lists only turns that took real work', async () => {
    await turn('帮我做一个页面'); // three tool calls
    expect(await crew.api('GET', '/skills/candidates')).toMatchObject({ items: [] });
    const reply = await turn('帮我做一个复杂的页面'); // seven
    const { items } = await crew.api('GET', '/skills/candidates');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ messageId: reply.id, botName: 'Chief', ask: '帮我做一个复杂的页面' });
    expect(items[0].tools).toBeGreaterThanOrEqual(5);
  });

  it('drafts a skill as a pending proposal, and saves it only when accepted', async () => {
    const [c] = (await crew.api('GET', '/skills/candidates')).items;
    const r = await crew.api('POST', '/skills/draft', { chatId: c.chatId, messageId: c.messageId });
    expect(r.improvement).toMatchObject({ field: 'skill', status: 'pending', botName: 'Chief' });
    expect(r.improvement.after).toMatchObject({ name: 'demo-page', flags: [] });
    expect(r.improvement.evidence[0].messageId).toBe(c.messageId);
    expect((await crew.api('GET', '/skills/candidates')).items).toHaveLength(0); // drafted once
    expect((await crew.api('GET', '/bootstrap')).skills.some((s: any) => s.name === 'demo-page')).toBe(false);

    expect((await crew.api('POST', `/improvements/${r.improvement.id}/accept`)).improvement.status).toBe('accepted');
    const skill = (await crew.api('GET', '/bootstrap')).skills.find((s: any) => s.name === 'demo-page');
    expect(skill.body).toContain('{{args}}');

    expect((await crew.api('POST', `/improvements/${r.improvement.id}/revert`)).improvement.status).toBe('reverted');
    expect((await crew.api('GET', '/bootstrap')).skills.some((s: any) => s.name === 'demo-page')).toBe(false);
  });

  it("takes a teammate's handover as the task of a handed-over turn", async () => {
    const b = await crew.api('GET', '/bootstrap');
    const group = b.chats.find((c: any) => c.kind === 'group').id;
    const sent = await crew.api('POST', `/chats/${group}/messages`, { text: '把这个复杂任务拆分一下交给队友' });
    await waitTurn(crew.api, group, sent.seq); // Chief hands over to Pixel
    let pixel: any;
    for (let i = 0; i < 80 && !pixel; i++) {
      await new Promise((r) => setTimeout(r, 250));
      pixel = (await crew.api('GET', '/skills/candidates')).items.find((c: any) => c.botName === 'Pixel');
    }
    expect(pixel.ask).toMatch(/^Chief 交代的任务：/);
    expect(pixel.ask).toContain('我把任务拆一下：@Pixel');
    expect(pixel.ask).toContain('用户最近说的：把这个复杂任务拆分一下交给队友');
  });

  it('remembers why a draft was rejected, for the next draft', async () => {
    await turn('再帮我做一个复杂的页面');
    const [c] = (await crew.api('GET', '/skills/candidates')).items;
    const r = await crew.api('POST', '/skills/draft', { chatId: c.chatId, messageId: c.messageId });
    const rejected = (await crew.api('POST', `/improvements/${r.improvement.id}/reject`, { note: '步骤太笼统' })).improvement;
    expect([rejected.status, rejected.note]).toEqual(['rejected', '步骤太笼统']);
    const { rejectedSkillNotes } = await import('../../server/learnSkills');
    expect(rejectedSkillNotes).toBeTypeOf('function');
    // The turn is not offered again once drafted.
    expect((await crew.api('GET', '/skills/candidates')).items.some((x: any) => x.messageId === c.messageId)).toBe(false);
  });

  it('refuses turns that are not candidates', async () => {
    const r = await crew.api('POST', '/skills/draft', { chatId: dm, messageId: 'm_nope' });
    expect(r.status).toBe(404);
  });
});

describe.skipIf(!claudeCli())('the memory nudge, with a model', () => {
  const TOKEN = 'mock-secret-token';
  let mock: MockProvider;
  let crew: CrewServer;
  let dm: string;
  let calls = 0;
  let busy = false;

  beforeAll(async () => {
    // While busy, the model makes five Bash calls before answering: a complex turn.
    mock = await startMockProvider({
      token: TOKEN,
      reply: (r) => {
        if (busy && r.tools.includes('Bash') && calls < 5) {
          calls += 1;
          return { tool: { id: `toolu_n${calls}`, name: 'Bash', input: { command: `echo step-${calls}`, description: 'step' } } };
        }
        return { text: '好了。' };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
      sandbox: { enabled: false },
    });
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    dm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
    await crew.api('PATCH', `/chats/${dm}`, { permission: 'auto' });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
  });

  const lastUserText = (body: any) => {
    const c = (body.messages || []).filter((m: any) => m.role === 'user').at(-1)?.content;
    return typeof c === 'string' ? c : (c || []).map((x: any) => x.text || '').join('');
  };
  const turn = async (text: string) => {
    mock.requests.length = 0;
    const sent = await crew.api('POST', `/chats/${dm}/messages`, { text });
    await waitTurn(crew.api, dm, sent.seq, 120_000);
    return lastUserText(mock.requests.find((r) => r.tools.length && lastUserText(r.body).includes(text))!.body);
  };

  it('reminds the bot to remember after a complex turn, once', async () => {
    busy = true;
    expect(await turn('做一件复杂的事')).not.toContain('remember');
    busy = false;
    expect(await turn('下一件事')).toContain('先用 remember 记下来');
    expect(await turn('再下一件')).not.toContain('remember');
  });
});
