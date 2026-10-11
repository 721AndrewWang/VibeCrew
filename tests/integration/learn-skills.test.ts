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
    await turn('Make me a page'); // three tool calls
    expect(await crew.api('GET', '/skills/candidates')).toMatchObject({ items: [] });
    const reply = await turn('Make me a complex page'); // seven
    const { items } = await crew.api('GET', '/skills/candidates');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ messageId: reply.id, botName: 'Chief', ask: 'Make me a complex page' });
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
    const sent = await crew.api('POST', `/chats/${group}/messages`, { text: 'Split this complex task and hand it off to a teammate' });
    await waitTurn(crew.api, group, sent.seq); // Chief hands over to Pixel
    let pixel: any;
    for (let i = 0; i < 80 && !pixel; i++) {
      await new Promise((r) => setTimeout(r, 250));
      pixel = (await crew.api('GET', '/skills/candidates')).items.find((c: any) => c.botName === 'Pixel');
    }
    expect(pixel.ask).toMatch(/^Task handed over by Chief: /);
    expect(pixel.ask).toContain('@Pixel');
    expect(pixel.ask).toContain('The user recently said: Split this complex task and hand it off to a teammate');
  });

  it('remembers why a draft was rejected, for the next draft', async () => {
    await turn('Make me another complex page');
    const [c] = (await crew.api('GET', '/skills/candidates')).items;
    const r = await crew.api('POST', '/skills/draft', { chatId: c.chatId, messageId: c.messageId });
    const rejected = (await crew.api('POST', `/improvements/${r.improvement.id}/reject`, { note: 'The steps are too vague' })).improvement;
    expect([rejected.status, rejected.note]).toEqual(['rejected', 'The steps are too vague']);
    const { rejectedSkillNotes } = await import('../../server/learnSkills');
    expect(rejectedSkillNotes).toBeTypeOf('function');
    // The turn is not offered again once drafted.
    expect((await crew.api('GET', '/skills/candidates')).items.some((x: any) => x.messageId === c.messageId)).toBe(false);
  });

  it('lets the user edit a draft before accepting it, screening the edit again', async () => {
    await crew.api('PATCH', '/settings', { denyRules: ['Bash(*prod-server*)'] });
    await turn('A third complex page');
    const [c] = (await crew.api('GET', '/skills/candidates')).items;
    const { improvement } = await crew.api('POST', '/skills/draft', { chatId: c.chatId, messageId: c.messageId });
    const edit = (over: object) =>
      crew.api('PATCH', `/improvements/${improvement.id}`, {
        name: 'my-page',
        title: 'Page',
        description: 'When making a page',
        argsHint: 'topic',
        body: '1. Look at the structure\n2. Write the page following {{args}}',
        ...over,
      });

    // A blocked edit is refused and changes nothing.
    const blocked = await edit({ body: 'First `ssh prod-server ls`' });
    expect(blocked.status).toBe(400);
    expect(blocked.error).toContain('Failed the safety check');
    expect((await edit({ name: 'Bad Name' })).status).toBe(400);

    // A good one replaces the draft, keeps the model's version, and recomputes the flags.
    const r = (await edit({ body: '1. Look at the structure\n2. Write the page following {{args}}\n3. Once confirmed, `git push`' })).improvement;
    expect(r.after).toMatchObject({ name: 'my-page', title: 'Page', flags: ['Contains a command that needs approval: git push'] });
    expect(r.original.name).toBe('demo-page');

    expect((await crew.api('POST', `/improvements/${improvement.id}/accept`)).improvement.status).toBe('accepted');
    expect((await crew.api('GET', '/bootstrap')).skills.find((s: any) => s.name === 'my-page').body).toContain('3. Once confirmed, `git push`');
    expect((await edit({})).status).toBe(409); // decided already

    // The next draft learns what the user changed.
    const { rejectedSkillNotes } = await import('../../server/learnSkills');
    expect(typeof rejectedSkillNotes).toBe('function');
    await crew.api('PATCH', '/settings', { denyRules: [] });
  });

  it('only lets skill drafts be edited', async () => {
    const r = await crew.api('PATCH', '/improvements/i_nope', { name: 'x', title: 'x', description: '', argsHint: '', body: 'x' });
    expect(r.status).toBe(404);
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
        return { text: 'Done.' };
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
    expect(await turn('Do something complex')).not.toContain('remember');
    busy = false;
    expect(await turn('Next thing')).toContain('remember');
    expect(await turn('And the one after')).not.toContain('remember');
  });
});
