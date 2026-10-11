// A resumed session that has grown past the threshold starts over on its next turn, with the
// recent messages again; checking roles that start fresh anyway are left alone.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, tempDir, waitFor, waitTurn } from '../helpers/server';

const dir = tempDir('crew-rotation');

let crew: CrewServer;
let chiefDm: string;
let chief: any;

beforeAll(async () => {
  crew = await startServer({ dir });
  const b = await crew.api('GET', '/bootstrap');
  chief = b.bots.find((x: any) => x.name === 'Chief');
  chiefDm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
});
afterAll(async () => {
  await crew?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const turn = async (chatId: string, text: string) => {
  const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text });
  return waitTurn(crew.api, chatId, sent.seq);
};
const notes = async (chatId: string) => (await crew.api('GET', `/chats/${chatId}/messages?limit=40`)).messages.filter((m: any) => m.role === 'system' && m.text.includes('starts a fresh session'));
const sessionOf = async (chatId: string, botId: string) => (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === chatId).sessions[botId];

describe('session rotation', () => {
  it('defaults to 60k tokens, set in the defaults', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.rotateAtTokens).toBe(60_000);
    // The demo session grows 14k + 5.5k per turn: two turns pass 20k.
    expect((await crew.api('PATCH', '/settings', { rotateAtTokens: 20_000 })).settings.rotateAtTokens).toBe(20_000);
  });

  it('keeps resuming below the threshold', async () => {
    await turn(chiefDm, 'First');
    const first = await sessionOf(chiefDm, chief.id);
    expect(first).toBeTruthy();
    await turn(chiefDm, 'Second'); // the session is now at 25k: marked
    expect(await sessionOf(chiefDm, chief.id)).toBe(first);
    expect(await notes(chiefDm)).toHaveLength(0);
  });

  it('starts over on the next turn, saying so, and keeps working', async () => {
    const before = await sessionOf(chiefDm, chief.id);
    const reply = await turn(chiefDm, 'Third');
    expect(reply.status).toBe('done');
    const n = await notes(chiefDm);
    expect(n).toHaveLength(1);
    expect(n[0].text).toMatch(/Chief's session context reached 25k tokens, so this turn starts a fresh session with the last \d+ messages/);
    expect(await sessionOf(chiefDm, chief.id)).not.toBe(before);
    expect((await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === chiefDm).context[chief.id].used).toBe(19_500);
  });

  it('still starts over when Crew restarted after the session outgrew the threshold', async () => {
    const pixel = (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.name === 'Pixel');
    const pixelDm = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === pixel.id).id;
    await turn(pixelDm, 'one');
    await turn(pixelDm, 'two'); // 25k: marked, but only in memory
    const before = await sessionOf(pixelDm, pixel.id);
    await waitFor(async () => ((await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === pixelDm).context?.[pixel.id]?.used ?? 0) >= 25_000);
    await new Promise((r) => setTimeout(r, 600)); // the debounced save
    await crew.kill();
    crew = await startServer({ dir });
    await turn(pixelDm, 'three');
    const n = await notes(pixelDm);
    expect(n).toHaveLength(1);
    expect(n[0].text).toContain("Pixel's session context reached 25k tokens");
    expect(await sessionOf(pixelDm, pixel.id)).not.toBe(before);
  });

  it('leaves fresh-session roles alone, and does nothing when switched off', async () => {
    const probe = (await crew.api('GET', '/bootstrap')).bots.find((x: any) => x.name === 'Probe');
    const probeDm = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === probe.id).id;
    for (const t of ['one', 'two', 'three']) await turn(probeDm, t);
    expect(await notes(probeDm)).toHaveLength(0);

    await crew.api('PATCH', '/settings', { rotateAtTokens: 0 });
    for (const t of ['four', 'five', 'six']) await turn(chiefDm, t);
    expect(await notes(chiefDm)).toHaveLength(1);
  });
});
