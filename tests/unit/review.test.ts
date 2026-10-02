import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../../server/agents/prompts';
import { challengeBlocker, parseVerdict } from '../../server/review';

describe('parseVerdict', () => {
  it('reads the last verdict line', () => {
    expect(parseVerdict('…\n结论：未推翻')).toEqual({ refuted: 0 });
    expect(parseVerdict('结论：推翻 2 条')).toEqual({ refuted: 2 });
    expect(parseVerdict('先写了结论：未推翻，后来又发现\n结论：推翻 1 条')).toEqual({ refuted: 1 });
    expect(parseVerdict('结论: 推翻3条')).toEqual({ refuted: 3 });
  });
  it('is null without one', () => {
    expect(parseVerdict('看起来没问题')).toBeNull();
  });
});

describe('challengeBlocker', () => {
  const v = (head: string, refuted: number) => ({ head, refuted, at: 1, messageId: 'm' });
  it('blocks without a review, after new commits, and while something is refuted', () => {
    expect(challengeBlocker(undefined, 'abc')).toContain('还没做过');
    expect(challengeBlocker(v('old', 0), 'abc')).toContain('新提交');
    expect(challengeBlocker(v('abc', 2), 'abc')).toContain('推翻了 2 条');
  });
  it('lets a review that refuted nothing at this commit through', () => {
    expect(challengeBlocker(v('abc', 0), 'abc')).toBeNull();
  });
});

describe("the blind reviewer's prompt", () => {
  const names = new Map([
    ['b_pixel', 'Pixel'],
    ['b_chief', 'Chief'],
  ]);
  const msg = (seq: number, role: 'user' | 'bot', text: string, botId?: string) => ({ id: `m${seq}`, seq, role, text, botId, chatId: 'c', ts: seq }) as any;
  const prompt = buildTurnPrompt({
    bot: { name: 'Skeptic', blindReview: true } as any,
    chat: { kind: 'group', title: 'g' } as any,
    unseen: [msg(1, 'user', '加一个联系区块，邮件按钮要能用'), msg(2, 'bot', '改好了，我确认暗色模式没问题，手机也测过', 'b_pixel'), msg(3, 'bot', '@Skeptic 请审', 'b_chief')],
    names,
    context: ['时间：10:00'],
    trigger: { type: 'mention', by: 'b_chief' },
    review: { title: '还没提交的改动', diff: '+<a href="mailto:x">', how: 'git diff HEAD' },
  });
  it("has the user's words and the diff", () => {
    expect(prompt).toContain('加一个联系区块，邮件按钮要能用');
    expect(prompt).toContain('+<a href="mailto:x">');
    expect(prompt).toContain('按你的角色说明审查');
    // The verdict format is Skeptic's own, in its description; a blind Lens does not get it.
    expect(prompt).not.toContain('结论：未推翻');
  });
  it('hides what teammates said, only counting it', () => {
    expect(prompt).not.toContain('暗色模式没问题');
    expect(prompt).not.toContain('请审');
    expect(prompt).toContain('2 条消息，按规则对你隐藏');
  });
});
