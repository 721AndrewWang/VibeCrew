// Requests that do not fit are refused at the door with a 400 that names the field, before any
// state changes; well-formed ones go through as before.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer } from '../helpers/server';

let crew: CrewServer;
let botId: string;
let groupId: string;
let projectId: string;

beforeAll(async () => {
  crew = await startServer();
  const b = await crew.api('GET', '/bootstrap');
  botId = b.bots[0].id;
  groupId = b.chats.find((c: any) => c.kind === 'group').id;
  projectId = b.projects[0].id;
});
afterAll(() => crew?.stop());

const bad = async (method: string, url: string, payload: unknown, field: string) => {
  const r = await crew.api(method, url, payload);
  expect(r.status, `${method} ${url}`).toBe(400);
  expect(r.error, `${method} ${url}`).toMatch(new RegExp(`^${field.replace('.', '\\.')}: `));
  return r.error as string;
};

describe('request validation', () => {
  it('names the field and what it should be', async () => {
    expect(await bad('PATCH', `/bots/${botId}`, { permission: 'god' }, 'permission')).toContain('must be one of');
    expect(await bad('PATCH', `/bots/${botId}`, { allowRules: 'Bash(*)' }, 'allowRules')).toContain('a list');
    expect(await bad('PATCH', `/bots/${botId}`, { name: 'x'.repeat(41) }, 'name')).toContain('at most 40');
    expect(await bad('PATCH', `/chats/${groupId}`, { effort: 'ultra' }, 'effort')).toContain('must be one of');
    expect(await bad('PATCH', `/chats/${groupId}`, { maxHops: 'ten' }, 'maxHops')).toContain('a number');
    expect(await bad('PATCH', `/chats/${groupId}`, { botIds: [] }, 'botIds')).toContain("can't be empty");
    expect(await bad('POST', '/chats', { title: 'x' }, 'botIds')).toContain('a list');
    expect(await bad('PATCH', `/projects/${projectId}`, { noAttribution: 'yes' }, 'noAttribution')).toContain('true/false');
    expect(await bad('PATCH', '/settings', { maxHops: 99 }, 'maxHops')).toContain('at most 30');
    expect(await bad('PATCH', '/settings', { lanEnabled: 'on' }, 'lanEnabled')).toContain('true/false');
    expect(await bad('POST', `/approvals/a_x`, { decision: 'maybe' }, 'decision')).toContain('must be one of');
    expect(await bad('POST', '/uploads', { mime: 'image/png' }, 'data')).toContain('text');
  });

  it('checks nested shapes: a routine trigger', async () => {
    expect(await bad('POST', '/routines', { name: 'r', botId, prompt: 'go', trigger: { type: 'daily', time: 'noon' } }, 'trigger.time')).toContain('HH:MM');
    expect(await bad('POST', '/routines', { name: 'r', botId, prompt: 'go', trigger: { type: 'weekly' } }, 'trigger.type')).toContain('invalid format');
    await bad('POST', '/routines', { name: 'r', botId, trigger: { type: 'manual' } }, 'prompt');
  });

  it('leaves state untouched after a refusal', async () => {
    const before = (await crew.api('GET', '/bootstrap')).bots.find((b: any) => b.id === botId);
    await bad('PATCH', `/bots/${botId}`, { title: 'New title', permission: 'god' }, 'permission');
    const after = (await crew.api('GET', '/bootstrap')).bots.find((b: any) => b.id === botId);
    expect(after.title).toBe(before.title);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('still accepts what the UI sends', async () => {
    expect((await crew.api('PATCH', `/bots/${botId}`, { title: 'New title', permission: 'edits', askRules: ['Bash(git push:*)'] })).title).toBe('New title');
    expect((await crew.api('PATCH', `/chats/${groupId}`, { permission: 'auto', model: null, maxHops: 3 })).maxHops).toBe(3);
    const r = await crew.api('POST', '/routines', { name: 'Daily', botId, prompt: 'Check on things', trigger: { type: 'daily', time: '09:00' } });
    expect(r.status).toBe(200);
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    expect((await crew.api('PATCH', `/routines/${r.id}`, { enabled: false })).enabled).toBe(false);
    expect((await crew.api('PATCH', '/settings', { maxHops: 5, defaultPermission: 'ask', unknownKey: 1 })).settings.maxHops).toBe(5);
  });
});
