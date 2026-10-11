// Settings and per-chat switches through the API: logo, composer switches, context usage, validation.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, ROOT, startServer, waitFor, waitTurn } from '../helpers/server';

let crew: CrewServer;
beforeAll(async () => {
  crew = await startServer();
});
afterAll(() => crew?.stop());

const text = async (url: string) => (await fetch(crew.base + url)).text();
const bytes = async (url: string) => Buffer.from(await (await fetch(crew.base + url)).arrayBuffer());

describe('the logo', () => {
  it('defaults to C and serves it as the favicon', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.logo).toBe('c');
    expect(await text('/icon.svg')).toContain('M85.1 44.9A27 27 0 1 0 85.1 83.1');
  });

  it('switches every icon the server hands out, and persists', async () => {
    const r = await crew.api('PATCH', '/settings', { logo: 'code' });
    expect(r.settings.logo).toBe('code');
    expect(await text('/icon.svg')).toContain('M49 42');
    const dist = path.join(ROOT, 'web/dist/logos/code-192.png');
    if (fs.existsSync(dist)) expect((await bytes('/icon-192.png')).equals(fs.readFileSync(dist))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(crew.home, 'settings.json'), 'utf8')).logo).toBe('code');
  });

  it('ignores unknown logos', async () => {
    await crew.api('PATCH', '/settings', { logo: '../../etc' });
    expect((await crew.api('GET', '/bootstrap')).settings.logo).toBe('code');
  });
});

describe('a chat’s switches', () => {
  let chat: any;
  beforeAll(async () => {
    chat = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.kind === 'group');
  });

  it('saves mode, model and effort, and clears them with null', async () => {
    let c = await crew.api('PATCH', `/chats/${chat.id}`, { permission: 'review', model: 'claude-sonnet-5', effort: 'max' });
    expect([c.permission, c.model, c.effort]).toEqual(['review', 'claude-sonnet-5', 'max']);
    c = await crew.api('PATCH', `/chats/${chat.id}`, { permission: null, model: null, effort: null });
    expect([c.permission, c.model, c.effort]).toEqual([undefined, undefined, undefined]);
  });

  it('refuses unknown values', async () => {
    expect((await crew.api('PATCH', `/chats/${chat.id}`, { permission: 'yolo' })).status).toBe(400);
    expect((await crew.api('PATCH', `/chats/${chat.id}`, { effort: 'ludicrous' })).status).toBe(400);
  });

  it('keeps bot turns working with them set', async () => {
    await crew.api('PATCH', `/chats/${chat.id}`, { permission: 'review', effort: 'high' });
    const sent = await crew.api('POST', `/chats/${chat.id}/messages`, { text: 'Hello' });
    expect((await waitTurn(crew.api, chat.id, sent.seq)).status).toBe('done');
  });
});

describe('context usage', () => {
  it('is recorded per bot after a reply, with the model, and cleared by a new topic', async () => {
    const b = await crew.api('GET', '/bootstrap');
    const dm = b.chats.find((c: any) => c.kind === 'dm');
    const botId = dm.botIds[0];
    const sent = await crew.api('POST', `/chats/${dm.id}/messages`, { text: 'Are you there?' });
    const reply = await waitTurn(crew.api, dm.id, sent.seq);
    expect(reply.meta.model).toBe('claude-opus-5-5');
    const usage = await waitFor(async () => (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === dm.id)?.context?.[botId]);
    expect(usage).toMatchObject({ used: 19_500, max: 200_000, percentage: 10, model: 'claude-opus-5-5' });
    await crew.api('POST', `/chats/${dm.id}/reset`);
    const after = (await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === dm.id);
    expect(after.context).toEqual({});
  });
});

describe('phone push (Bark)', () => {
  const KEY = 'https://api.day.app/SecretKey123';
  it('is off by default, and testing it without an address says so', async () => {
    expect((await crew.api('GET', '/bootstrap')).settings.push).toEqual({ configured: false, afterMinutes: 10 });
    const r = await crew.api('POST', '/settings/push-test');
    expect(r.status).toBe(400);
  });

  it('refuses an address that is not a Bark URL', async () => {
    for (const barkUrl of ['http://api.day.app/K', 'https://api.day.app/K/title/body', 'not a url']) {
      expect((await crew.api('PATCH', '/settings', { push: { barkUrl } })).status, barkUrl).toBe(400);
    }
    expect((await crew.api('PATCH', '/settings', { push: { afterMinutes: 0 } })).status).toBe(400);
  });

  it('keeps the address on the server: the app only learns that one is set', async () => {
    const r = await crew.api('PATCH', '/settings', { push: { barkUrl: KEY, afterMinutes: 15 } });
    expect(r.settings.push).toEqual({ configured: true, afterMinutes: 15 });
    expect(JSON.stringify(await crew.api('GET', '/bootstrap'))).not.toContain('SecretKey123');
    const file = path.join(crew.home, 'settings.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).push).toEqual({ barkUrl: KEY, afterMinutes: 15 });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    // Changing the delay alone keeps the address; an empty address turns it off.
    expect((await crew.api('PATCH', '/settings', { push: { afterMinutes: 5 } })).settings.push).toEqual({ configured: true, afterMinutes: 5 });
    expect((await crew.api('PATCH', '/settings', { push: { barkUrl: '' } })).settings.push).toEqual({ configured: false, afterMinutes: 5 });
  });
});
