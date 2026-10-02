// A resumed session that has grown past the threshold starts over on its next turn, with the
// recent messages again; checking roles that start fresh anyway are left alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitTurn } from '../helpers/server';

let crew: CrewServer;
let chiefDm: string;
let chief: any;

beforeAll(async () => {
  crew = await startServer();
  const b = await crew.api('GET', '/bootstrap');
  chief = b.bots.find((x: any) => x.name === 'Chief');
  chiefDm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
});
afterAll(() => crew?.stop());

const turn = async (chatId: string, text: string) => {
  const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text });
  return waitTurn(crew.api, chatId, sent.seq);
};
const notes = async (chatId: string) => (await crew.api('GET', `/chats/${chatId}/messages?limit=40`)).messages.filter((m: any) => m.role === 'system' && m.text.includes('换成新会话'));
const sessionOf = async (chatId: string, botId: string) => (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === chatId).sessions[botId];

describe('session rotation', () => {
  it('defaults to 60k tokens, set in the defaults', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.rotateAtTokens).toBe(60_000);
    // The demo session grows 14k + 5.5k per turn: two turns pass 20k.
    expect((await crew.api('PATCH', '/settings', { rotateAtTokens: 20_000 })).settings.rotateAtTokens).toBe(20_000);
  });

  it('keeps resuming below the threshold', async () => {
    await turn(chiefDm, '第一条');
    const first = await sessionOf(chiefDm, chief.id);
    expect(first).toBeTruthy();
    await turn(chiefDm, '第二条'); // the session is now at 25k: marked
    expect(await sessionOf(chiefDm, chief.id)).toBe(first);
    expect(await notes(chiefDm)).toHaveLength(0);
  });

  it('starts over on the next turn, saying so, and keeps working', async () => {
    const before = await sessionOf(chiefDm, chief.id);
    const reply = await turn(chiefDm, '第三条');
    expect(reply.status).toBe('done');
    const n = await notes(chiefDm);
    expect(n).toHaveLength(1);
    expect(n[0].text).toMatch(/Chief 的会话上下文到了 25k token，这一轮换成新会话，带上最近 \d+ 条消息/);
    expect(await sessionOf(chiefDm, chief.id)).not.toBe(before);
    expect((await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === chiefDm).context[chief.id].used).toBe(19_500);
  });

  it('leaves fresh-session roles alone, and does nothing when switched off', async () => {
    const probe = (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.name === 'Probe');
    const probeDm = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === probe.id).id;
    for (const t of ['一', '二', '三']) await turn(probeDm, t);
    expect(await notes(probeDm)).toHaveLength(0);

    await crew.api('PATCH', '/settings', { rotateAtTokens: 0 });
    for (const t of ['四', '五', '六']) await turn(chiefDm, t);
    expect(await notes(chiefDm)).toHaveLength(1);
  });
});
