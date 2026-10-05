import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../../server/agents/prompts';
import { lineChange, notAnEdit } from '../../server/outsideEdits';

describe('notAnEdit', () => {
  it("skips the sandbox's placeholders and atomic-write temporaries, wherever they are", () => {
    for (const p of [
      '.claude/settings.json',
      '.claude/hooks',
      'tests/challenge/.claude/skills',
      '.claude',
      '.mcp.json',
      '.bashrc',
      'app/.gitconfig',
      '.vscode',
      '.idea',
      'app/.vscode/settings.json',
      '.idea/workspace.xml',
      'src/a.ts.tmp.3499639.42f01dde87a4',
    ]) {
      expect(notAnEdit(p), p).toBe(true);
    }
  });
  it('keeps real files, including ones that look alike', () => {
    for (const p of ['index.html', 'docs/claude.md', 'my.claude/x.txt', 'mcp.json', 'config/.env.example', 'notes.tmp', 'a.tmp.txt', '.gitignore', 'docs/vscode.md', 'my.idea/x.txt', '.ideas.md']) {
      expect(notAnEdit(p), p).toBe(false);
    }
  });
});

describe('lineChange', () => {
  it('finds the changed region between the common start and end', () => {
    expect(lineChange('a\nb\n<p>联系</p>\nd', 'a\nb\n<p>Contact</p>\nd')).toEqual({ line: 3, removed: ['<p>联系</p>'], added: ['<p>Contact</p>'] });
    expect(lineChange('a\nb', 'a\nx\ny\nb')).toEqual({ line: 2, removed: [], added: ['x', 'y'] });
    expect(lineChange('a\nb\nc', 'a\nc')).toEqual({ line: 2, removed: ['b'], added: [] });
  });
  it('is null when nothing changed', () => {
    expect(lineChange('same', 'same')).toBeNull();
  });
});

describe('a blind reviewer and files changed outside the chat', () => {
  it('sees the note, though teammates stay hidden', () => {
    const msg = (seq: number, role: string, text: string, extra: object = {}) => ({ id: `m${seq}`, seq, role, text, chatId: 'c', ts: seq, ...extra }) as any;
    const prompt = buildTurnPrompt({
      bot: { id: 'b_lens', name: 'Lens', blindReview: true } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [
        msg(1, 'user', '小标签改成「联系」'),
        msg(2, 'bot', '改好了', { botId: 'b_pixel' }),
        msg(3, 'system', '有文件在聊天之外被改了：\n- index.html 第 18 行起：\n    - 联系\n    + Contact', { notice: 'outside-edit' }),
      ],
      names: new Map(),
      context: [],
      trigger: undefined,
      review: { title: 't', diff: '', how: '' },
    });
    expect(prompt).toContain('聊天之外的文件改动');
    expect(prompt).toContain('+ Contact');
    expect(prompt).toContain('不要按更早的要求把它改回去');
    expect(prompt).not.toContain('改好了');
  });
});
