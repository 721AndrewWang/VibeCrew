// The adversarial reviewer called by itself: when a chain of turns ends with a change that matches
// the project's fixed rules, Skeptic joins if needed and reviews it once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor } from '../helpers/server';

let crew: CrewServer;
let groupId: string;
let projectId: string;
let skeptic: any;

beforeAll(async () => {
  crew = await startServer();
  const b = await crew.api('GET', '/bootstrap');
  groupId = b.chats.find((c: any) => c.kind === 'group').id;
  projectId = b.projects[0].id;
  skeptic = await crew.api('POST', '/bots', { template: 'skeptic', projectId });
});
afterAll(() => crew?.stop());

async function say(text: string) {
  const sent = await crew.api('POST', `/chats/${groupId}/messages`, { text });
  await waitFor(async () => {
    const b = await crew.api('GET', '/bootstrap');
    const { messages } = await crew.api('GET', `/chats/${groupId}/messages?limit=60`);
    return messages.some((m: any) => m.seq > sent.seq && m.role === 'bot' && m.status === 'done') && Object.values(b.statuses).every((s: any) => s.state === 'idle');
  }, 60_000);
  await new Promise((r) => setTimeout(r, 800));
  return (await crew.api('GET', `/chats/${groupId}/messages?limit=60`)).messages.filter((m: any) => m.seq > sent.seq);
}

describe('automatic adversarial review', () => {
  it('stays off until the project turns it on', async () => {
    const after = await say('帮我做一个页面'); // the demo lead writes crew-demo.md
    expect(after.some((m: any) => m.botId === skeptic.id)).toBe(false);
  });

  it('brings Skeptic in once the change matches a rule, and says why', async () => {
    const p = await crew.api('PATCH', `/projects/${projectId}`, { autoChallenge: { enabled: true, paths: ['**/*.md', ' ', '**/*.md'], minLines: 0 } });
    expect(p.autoChallenge).toEqual({ enabled: true, paths: ['**/*.md'], minLines: 0 });
    const after = await say('再做一个页面');
    const note = after.find((m: any) => m.role === 'system' && m.text.includes('自动对抗审查规则'));
    expect(note.text).toContain('crew-demo.md（规则 **/*.md）');
    expect(after.some((m: any) => m.role === 'system' && m.text === 'Skeptic 加入了对话')).toBe(true);
    const review = after.filter((m: any) => m.botId === skeptic.id);
    expect(review).toHaveLength(1);
    expect(review[0].meta.verdict).toEqual({ refuted: 0 });
    expect((await crew.api('GET', '/bootstrap')).chats.find((c: any) => c.id === groupId).botIds).toContain(skeptic.id);
  });

  it('does not review a change that matches no rule', async () => {
    await crew.api('PATCH', `/projects/${projectId}`, { autoChallenge: { enabled: true, paths: ['**/*.css'], minLines: 0 } });
    const after = await say('又做一个页面');
    expect(after.some((m: any) => m.botId === skeptic.id)).toBe(false);
  });
});
