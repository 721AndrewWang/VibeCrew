// Crew dies mid-turn (power cut, kill -9) and starts again: what the bot had written is kept and
// labelled, the schema version is stamped, and a workspace's uncommitted changes land on its branch.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, git, startServer, tempDir, waitFor } from '../helpers/server';

const dir = tempDir('crew-recovery');
let crew: CrewServer;
let chatId: string;
let worktree: string;

const onDisk = (id: string) =>
  fs
    .readFileSync(path.join(crew.home, 'messages', `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

beforeAll(async () => {
  crew = await startServer({ dir });
  const b = await crew.api('GET', '/bootstrap');
  const chief = b.bots.find((x: any) => x.name === 'Chief');
  await crew.api('PATCH', `/bots/${chief.id}`, { allowRules: [] });
  chatId = (await crew.api('POST', '/chats', { title: 'Recover', botIds: [chief.id], projectId: b.projects[0].id, permission: 'ask' })).id;
  worktree = (await crew.api('POST', `/chats/${chatId}/workspace`)).workspace.worktree;
});
afterAll(async () => {
  await crew?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('after a crash mid-turn', () => {
  it('keeps and labels the interrupted turn, and commits what the workspace had', async () => {
    expect(JSON.parse(fs.readFileSync(path.join(crew.home, 'settings.json'), 'utf8')).schemaVersion).toBeGreaterThanOrEqual(1);
    await crew.api('POST', `/chats/${chatId}/messages`, { text: '帮我做一个页面' });
    // The turn blocks at the first approval; its progress so far reaches the disk within seconds.
    const saved = await waitFor(() => onDisk(chatId).find((m) => m.role === 'bot' && m.status === 'streaming' && m.parts?.some((p: any) => p.type === 'approval')), 15_000);
    expect(saved.parts.some((p: any) => p.type === 'text' && p.text.includes('演示模式'))).toBe(true);

    await crew.kill();
    fs.writeFileSync(path.join(worktree, 'half-done.txt'), 'written just before the crash\n');
    crew = await startServer({ dir });

    const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
    const turn = messages.find((m: any) => m.id === saved.id);
    expect(turn.status).toBe('stopped');
    expect(turn.interrupted).toBe(true);
    expect(turn.parts.find((p: any) => p.type === 'approval').status).toBe('expired');
    expect(turn.parts.find((p: any) => p.type === 'text').text).toContain('演示模式');
    expect(onDisk(chatId).some((m) => m.id === saved.id && m.interrupted)).toBe(true);
    expect((await crew.api('GET', '/bootstrap')).statuses).not.toHaveProperty(turn.botId + '.state', 'waiting');

    expect(git(worktree, crew.env, 'log', '-1', '--format=%s')).toBe('恢复：上次中断前未提交的改动');
    expect(git(worktree, crew.env, 'status', '--porcelain')).toBe('');
    expect(messages.some((m: any) => m.role === 'system' && m.text.includes('已经提交到分支上了'))).toBe(true);
  });

  it('the chat works again: a new message gets a reply', async () => {
    await crew.api('PATCH', `/chats/${chatId}`, { permission: 'auto' });
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text: '你好' });
    const reply = await waitFor(async () => {
      const { messages } = await crew.api('GET', `/chats/${chatId}/messages?limit=30`);
      return messages.find((m: any) => m.role === 'bot' && m.seq > sent.seq && m.status === 'done');
    }, 30_000);
    expect(reply.interrupted).toBeUndefined();
  });
});
