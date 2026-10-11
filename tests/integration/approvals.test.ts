// The approval card: it says what made Crew ask, and the user's answer reaches the bot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor, waitTurn } from '../helpers/server';

let crew: CrewServer;
let chatId: string;
let botId: string;

beforeAll(async () => {
  crew = await startServer();
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  botId = chief.id;
  chatId = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
  // The demo bot comes with a few "always allow" rules; start from none.
  await crew.api('PATCH', `/bots/${botId}`, { allowRules: [] });
});
afterAll(() => crew?.stop());

const pendingApproval = async () => {
  const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
  for (const m of messages) for (const p of m.parts || []) if (p.type === 'approval' && p.status === 'pending') return p;
  return null;
};

/** Answers every further request of the turn the same way, until it ends. */
const answerRest = async (sinceSeq: number, decision: 'allow' | 'deny') => {
  for (;;) {
    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
    const bot = messages.filter((m: any) => m.role === 'bot' && m.seq > sinceSeq).at(-1);
    if (bot && bot.status !== 'streaming' && bot.status !== 'pending') return bot;
    const p = await pendingApproval();
    if (p) await crew.api('POST', `/approvals/${p.id}`, { decision });
    else await new Promise((r) => setTimeout(r, 150));
  }
};

describe('approval cards', () => {
  it("say why Crew asked, and carry the user's answer back", async () => {
    await crew.api('PATCH', `/chats/${chatId}`, { permission: 'ask' });
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'make me a page' });
    const part = await waitFor(pendingApproval, 20_000);
    expect(part.toolName).toBe('Bash');
    expect(part.because).toBe('permission mode is "Ask every step"');
    expect(part.rules).toEqual(['Bash(ls*)']);
    expect((await crew.api('GET', '/bootstrap')).statuses[botId].state).toBe('waiting');
    expect((await crew.api('POST', `/approvals/${part.id}`, { decision: 'allow' })).ok).toBe(true);
    await answerRest(sent.seq, 'allow');
    const reply = await waitTurn(crew.api, chatId, sent.seq);
    expect(reply.status).toBe('done');
    const decided = reply.parts.find((p: any) => p.type === 'approval' && p.toolName === 'Bash');
    expect(decided.status).toBe('allowed');
    expect(decided.because).toBe('permission mode is "Ask every step"');
  });

  it('name the project rule that matched, and "always allow" adds the rule to the bot', async () => {
    const project = (await crew.api('GET', '/bootstrap')).projects[0];
    await crew.api('PATCH', `/projects/${project.id}`, { askRules: ['Bash(ls*)'] });
    await crew.api('PATCH', `/chats/${chatId}`, { permission: 'auto' });
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'make another page' });
    const part = await waitFor(pendingApproval, 20_000);
    expect(part.because).toBe('project "always ask" rule Bash(ls*)');
    await crew.api('POST', `/approvals/${part.id}`, { decision: 'always' });
    await answerRest(sent.seq, 'allow');
    await waitTurn(crew.api, chatId, sent.seq);
    expect((await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.id === botId).allowRules).toContain('Bash(ls*)');
  });

  it('a refusal reaches the bot with the reason', async () => {
    await crew.api('PATCH', `/projects/${(await crew.api('GET', '/bootstrap')).projects[0].id}`, { askRules: ['Bash(ls*)'] });
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: 'make another page' });
    const part = await waitFor(pendingApproval, 20_000);
    await crew.api('POST', `/approvals/${part.id}`, { decision: 'deny', message: "Don't list files" });
    await answerRest(sent.seq, 'allow');
    const reply = await waitTurn(crew.api, chatId, sent.seq);
    expect(reply.parts.find((p: any) => p.type === 'approval').status).toBe('denied');
  });

  it('a refusal is recorded as friction; read-only commands asked in "ask every step" mode are not', async () => {
    const r = await crew.api('GET', '/friction?days=7');
    const denied = r.kinds.find((k: any) => k.kind === 'approval-denied');
    expect(denied.groups[0].key).toBe('project "always ask" rule Bash(ls*)');
    expect(denied.groups[0].examples[0].detail).toContain("Don't list files");
    // The second test allowed ls under a project rule in auto mode: a rule that stopped a read-only command.
    const readonly = r.kinds.find((k: any) => k.kind === 'approval-readonly');
    expect(readonly.groups.map((g: any) => g.key)).toEqual(['project "always ask" rule Bash(ls*)']);
    expect(r.brief).toContain('@{lead}');
  });
});
