import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, taskFor } from '../../server/agents/prompts';
import { challengeBlocker, parseVerdict } from '../../server/review';

describe('parseVerdict', () => {
  it('reads the last verdict line', () => {
    expect(parseVerdict('…\nVerdict: not refuted')).toEqual({ refuted: 0 });
    expect(parseVerdict('Verdict: refuted 2')).toEqual({ refuted: 2 });
    expect(parseVerdict('First wrote Verdict: not refuted, then found more\nVerdict: refuted 1')).toEqual({ refuted: 1 });
    expect(parseVerdict('verdict:refuted3')).toEqual({ refuted: 3 });
  });
  it('is null without one', () => {
    expect(parseVerdict('Looks fine to me')).toBeNull();
  });
});

describe('challengeBlocker', () => {
  const v = (head: string, refuted: number) => ({ head, refuted, at: 1, messageId: 'm' });
  it('blocks without a review, after new commits, and while something is refuted', () => {
    expect(challengeBlocker(undefined, 'abc')).toContain("hasn't been one yet");
    expect(challengeBlocker(v('old', 0), 'abc')).toContain('new commits');
    expect(challengeBlocker(v('abc', 2), 'abc')).toContain('refuted 2 claim');
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
    unseen: [
      msg(1, 'user', 'Add a contact section, and the email button has to work'),
      msg(2, 'bot', 'Done. I checked dark mode is fine, and tested on mobile too', 'b_pixel'),
      msg(3, 'bot', '@Skeptic please review', 'b_chief'),
    ],
    names,
    context: ['Time: 10:00'],
    trigger: { type: 'mention', by: 'b_chief' },
    review: { title: 'Uncommitted changes', diff: '+<a href="mailto:x">', how: 'git diff HEAD' },
  });
  it("has the user's words and the diff", () => {
    expect(prompt).toContain('Add a contact section, and the email button has to work');
    expect(prompt).toContain('+<a href="mailto:x">');
    expect(prompt).toContain('look and measure for yourself');
    // The verdict format is Skeptic's own, in its description; a blind Lens does not get it.
    expect(prompt).not.toContain('Verdict: not refuted');
  });
  it('hides what teammates said, only counting it, but shows the task it was handed', () => {
    expect(prompt).not.toContain('dark mode is fine');
    expect(prompt).toContain('1 message in the meantime, hidden from you by design');
    expect(prompt).toContain('The task Chief handed you');
    expect(prompt).toContain('@Skeptic please review');
    expect(prompt).toContain('Do the task handed to you above');
  });

  it('takes only its own part of a handover to several teammates', () => {
    const handover = [
      'My take first: the last change is fine, no worries.',
      '',
      '@Lens review the 4 existing commits; read them yourself with git show.',
      'Focus on the SQL in claim.',
      '',
      '@Skeptic write failing tests for the worker, only in tests/challenge/worker-*.test.ts.',
      'Cover diamond dependencies.',
    ].join('\n');
    const p = buildTurnPrompt({
      bot: { name: 'Skeptic', blindReview: true } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [msg(1, 'user', 'Finish batch 1'), msg(2, 'bot', handover, 'b_chief')],
      names: new Map([...names, ['b_lens', 'Lens'], ['b_skeptic', 'Skeptic']]),
      context: [],
      trigger: { type: 'mention', by: 'b_chief' },
      review: { title: 'Uncommitted changes', diff: '+x', how: 'git diff HEAD' },
    });
    expect(p).toContain('@Skeptic write failing tests for the worker');
    expect(p).toContain('Cover diamond dependencies');
    expect(p).not.toContain('SQL in claim');
    expect(p).not.toContain('no worries');
    expect(p).not.toContain('hidden from you by design');
  });

  it('shows no task when it was not mentioned, or the mention came from the user', () => {
    const p = buildTurnPrompt({
      bot: { name: 'Lens', blindReview: true } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [msg(1, 'user', '@Lens take a look'), msg(2, 'bot', '@Skeptic your turn', 'b_chief')],
      names,
      context: [],
      trigger: { type: 'user' },
      review: { title: 'Uncommitted changes', diff: '+x', how: 'git diff HEAD' },
    });
    expect(p).not.toContain('handed you');
    expect(p).not.toContain('your turn');
    expect(p).toContain('1 message in the meantime, hidden from you by design');
    expect(p).toContain('Review as your role description says');
  });
});

describe('taskFor', () => {
  it('cuts at the next teammate addressed at the start of a line, not at a mention inside the text', () => {
    const text = "@Lens check db.ts against @Skeptic's tests.\n- @Skeptic write tests";
    expect(taskFor('Lens', text, ['Lens', 'Skeptic'])).toBe("@Lens check db.ts against @Skeptic's tests.");
    expect(taskFor('Skeptic', '@Lens only look', ['Lens', 'Skeptic'])).toBeNull();
  });
});
