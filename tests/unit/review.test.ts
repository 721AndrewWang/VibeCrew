import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, taskFor } from '../../server/agents/prompts';
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
    expect(prompt).toContain('自己去看、去量');
    // The verdict format is Skeptic's own, in its description; a blind Lens does not get it.
    expect(prompt).not.toContain('结论：未推翻');
  });
  it('hides what teammates said, only counting it, but shows the task it was handed', () => {
    expect(prompt).not.toContain('暗色模式没问题');
    expect(prompt).toContain('1 条消息，按规则对你隐藏');
    expect(prompt).toContain('Chief 交给你的任务');
    expect(prompt).toContain('@Skeptic 请审');
    expect(prompt).toContain('按上面交给你的任务做');
  });

  it('takes only its own part of a handover to several teammates', () => {
    const handover = [
      '我先说一下判断：上次的改动没问题，放心。',
      '',
      '@Lens 审查 4 个已有提交，用 git show 自己看。',
      '重点看 claim 的 SQL。',
      '',
      '@Skeptic 写 worker 的失败测试，只写 tests/challenge/worker-*.test.ts。',
      '覆盖菱形依赖。',
    ].join('\n');
    const p = buildTurnPrompt({
      bot: { name: 'Skeptic', blindReview: true } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [msg(1, 'user', '补齐第 1 批'), msg(2, 'bot', handover, 'b_chief')],
      names: new Map([...names, ['b_lens', 'Lens'], ['b_skeptic', 'Skeptic']]),
      context: [],
      trigger: { type: 'mention', by: 'b_chief' },
      review: { title: '还没提交的改动', diff: '+x', how: 'git diff HEAD' },
    });
    expect(p).toContain('@Skeptic 写 worker 的失败测试');
    expect(p).toContain('覆盖菱形依赖');
    expect(p).not.toContain('claim 的 SQL');
    expect(p).not.toContain('放心');
    expect(p).not.toContain('按规则对你隐藏');
  });

  it('shows no task when it was not mentioned, or the mention came from the user', () => {
    const p = buildTurnPrompt({
      bot: { name: 'Lens', blindReview: true } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [msg(1, 'user', '@Lens 看看'), msg(2, 'bot', '@Skeptic 你来', 'b_chief')],
      names,
      context: [],
      trigger: { type: 'user' },
      review: { title: '还没提交的改动', diff: '+x', how: 'git diff HEAD' },
    });
    expect(p).not.toContain('交给你的任务');
    expect(p).not.toContain('你来');
    expect(p).toContain('1 条消息，按规则对你隐藏');
    expect(p).toContain('按你的角色说明审查');
  });
});

describe('taskFor', () => {
  it('cuts at the next teammate addressed at the start of a line, not at a mention inside the text', () => {
    const text = '@Lens 看 db.ts，和 @Skeptic 的测试对一下。\n- @Skeptic 写测试';
    expect(taskFor('Lens', text, ['Lens', 'Skeptic'])).toBe('@Lens 看 db.ts，和 @Skeptic 的测试对一下。');
    expect(taskFor('Skeptic', '@Lens 只看', ['Lens', 'Skeptic'])).toBeNull();
  });
});
