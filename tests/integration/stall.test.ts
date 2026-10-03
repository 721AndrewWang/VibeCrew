// A teammate that reports back without handing on no longer ends the chain silently: the lead is
// told and takes a turn, a bounded number of times per user request.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor } from '../helpers/server';

let crew: CrewServer;
let group: any;
let names: Map<string, string>;

beforeAll(async () => {
  crew = await startServer();
  const b = await crew.api('GET', '/bootstrap');
  group = b.chats.find((c: any) => c.kind === 'group');
  names = new Map(b.bots.map((x: any) => [x.id, x.name]));
});
afterAll(() => crew?.stop());

async function say(text: string) {
  const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text });
  await waitFor(async () => {
    const b = await crew.api('GET', '/bootstrap');
    const { messages } = await crew.api('GET', `/chats/${group.id}/messages?limit=80`);
    return messages.some((m: any) => m.seq > sent.seq && m.role === 'bot' && m.status === 'done') && Object.values(b.statuses).every((s: any) => s.state === 'idle');
  }, 60_000);
  await new Promise((r) => setTimeout(r, 1500));
  return (await crew.api('GET', `/chats/${group.id}/messages?limit=80`)).messages.filter((m: any) => m.seq > sent.seq);
}

describe('a chain that stops without a handoff', () => {
  it('wakes the lead once, which reads the report in full and closes the chain', async () => {
    const lead = names.get(group.leadBotId)!;
    // The demo lead hands off to its first teammate on 交给; the teammate reports back to no one.
    const after = await say(`@${lead} 把任务交给队友`);
    const bots = after.filter((m: any) => m.role === 'bot');
    const teammate = bots[1];
    expect(names.get(bots[0].botId)).toBe(lead);
    expect(teammate.trigger).toEqual({ type: 'mention', by: group.leadBotId });
    const notes = after.filter((m: any) => m.notice === 'stall');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain(`${names.get(teammate.botId)} 交回了结果`);
    expect(notes[0].text).toContain(`@${lead}`);
    const woken = after.filter((m: any) => m.seq > notes[0].seq && m.role === 'bot');
    expect(woken.map((m: any) => names.get(m.botId))).toEqual([lead]);
    expect(woken[0].trigger).toEqual({ type: 'mention', by: teammate.botId });
  });

  it('gives the lead the next turn when it ends with the continue line, once', async () => {
    const lead = names.get(group.leadBotId)!;
    const after = await say(`@${lead} 分两步做`); // the demo lead asks to continue, then finishes
    const notes = after.filter((m: any) => m.notice === 'stall');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain(`${lead} 说下一步还要自己接着做`);
    const turns = after.filter((m: any) => m.role === 'bot');
    expect(turns.map((m: any) => names.get(m.botId))).toEqual([lead, lead]);
    expect(turns[0].text).toContain('【继续】');
    expect(turns[1].trigger).toEqual({ type: 'system' });
    expect(turns[1].text).not.toContain('【继续】');
  });

  it('does not wake anyone when the user only asked a teammate, or the lead answered last', async () => {
    const lead = names.get(group.leadBotId)!;
    const teammate = group.botIds.map((id: string) => names.get(id)).find((n: string) => n !== lead);
    expect((await say(`@${teammate} 看一下首页`)).some((m: any) => m.notice === 'stall')).toBe(false);
    expect((await say(`@${teammate} 看一下首页，看完 @${lead} 核对`)).some((m: any) => m.notice === 'stall')).toBe(false);
  });
});
