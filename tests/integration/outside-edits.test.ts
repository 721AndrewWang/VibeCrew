// Edits made outside the chat get a note in the project's chats, so the bots (blind reviewers
// included) start from the files as they are; the bots' own edits and Crew's own writes do not.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor, waitTurn } from '../helpers/server';

let crew: CrewServer;
let project: any;
let groupId: string;
let chiefDm: string;

beforeAll(async () => {
  crew = await startServer();
  const b = await crew.api('GET', '/bootstrap');
  project = b.projects[0];
  groupId = b.chats.find((c: any) => c.kind === 'group').id;
  chiefDm = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === b.bots.find((x: any) => x.name === 'Chief').id).id;
  // Let the watcher settle on the fresh project.
  await new Promise((r) => setTimeout(r, 1500));
});
afterAll(() => crew?.stop());

const notes = async (chatId: string) => (await crew.api('GET', `/chats/${chatId}/messages?limit=60`)).messages.filter((m: any) => m.notice === 'outside-edit');
const file = (rel: string) => path.join(project.path, rel);

describe('files changed outside the chat', () => {
  it('get one note per burst in every chat on the project, showing what changed', async () => {
    const html = fs.readFileSync(file('index.html'), 'utf8');
    fs.writeFileSync(file('index.html'), html.replace('<h1>', '<h1 data-x="1">'));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(file('notes.txt'), 'first line\nsecond line\n');
    const [n] = await waitFor(async () => {
      const list = await notes(groupId);
      return list.length ? list : null;
    }, 15_000);
    expect(n.role).toBe('system');
    expect(n.text).toContain('Files were changed outside the chat');
    expect(n.text).toMatch(/index\.html, from line \d+:/);
    expect(n.text).toContain('+ ');
    expect(n.text).toContain('notes.txt: new file');
    expect(await notes(chiefDm)).toHaveLength(1);
    expect(await notes(groupId)).toHaveLength(1);
  });

  it("say when it was Crew's own editor", async () => {
    const before = (await notes(groupId)).length;
    await crew.api('PUT', `/projects/${project.id}/file`, { path: 'notes.txt', content: 'first line\nedited second line\n' });
    const n = await waitFor(async () => {
      const list = await notes(groupId);
      return list.length > before ? list.at(-1) : null;
    }, 15_000);
    expect(n.text).toContain("The user edited files in Crew's editor");
    expect(n.text).toContain('- second line');
    expect(n.text).toContain('+ edited second line');
  });

  it("leave out the sandbox's placeholders and atomic-write temporaries", async () => {
    const before = (await notes(groupId)).length;
    // What a sandboxed command does in the folder it runs in, and what a Write tool does.
    const placeholders = ['.claude/settings.json', '.claude/hooks', 'sub/.claude/skills', '.mcp.json', '.bashrc', '.vscode/settings.json', '.idea/workspace.xml', 'notes.txt.tmp.4242.9f3c1a'];
    for (const p of placeholders) {
      fs.mkdirSync(path.dirname(file(p)), { recursive: true });
      fs.writeFileSync(file(p), '');
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const p of placeholders) fs.rmSync(file(p));
    fs.writeFileSync(file('notes.txt'), 'first line\nreally changed\n');
    const n = await waitFor(async () => {
      const list = await notes(groupId);
      return list.length > before ? list.at(-1) : null;
    }, 15_000);
    expect(n.text).toContain('notes.txt, from line 2');
    for (const p of placeholders) expect(n.text).not.toContain(p);
  });

  it("are not raised for the bots' own edits, or for undoing a turn", async () => {
    const before = (await notes(chiefDm)).length;
    const sent = await crew.api('POST', `/chats/${chiefDm}/messages`, { text: 'Please make a page' }); // the demo bot writes crew-demo.md
    const reply = await waitTurn(crew.api, chiefDm, sent.seq);
    expect(fs.existsSync(file('crew-demo.md'))).toBe(true);
    await new Promise((r) => setTimeout(r, 5000));
    expect(await notes(chiefDm)).toHaveLength(before);

    const undo = await crew.api('POST', `/chats/${chiefDm}/turns/${reply.turnId}/revert`, {});
    expect(undo.status, undo.error).toBe(200);
    await new Promise((r) => setTimeout(r, 5000));
    expect(fs.existsSync(file('crew-demo.md'))).toBe(false);
    expect(await notes(chiefDm)).toHaveLength(before);
  });
});
