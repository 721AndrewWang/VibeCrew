import { describe, expect, it } from 'vitest';
import { WRAP_UP_AGAIN, wrapUpNote } from '../../server/agents/wrapUp';

describe('wrapUpNote', () => {
  it('stays quiet below the limit, and when switched off', () => {
    expect(wrapUpNote(119_999, 120_000, null)).toBeNull();
    expect(wrapUpNote(500_000, 0, null)).toBeNull();
  });

  it('asks once to finish the step in hand and hand back with a summary', () => {
    const note = wrapUpNote(123_400, 120_000, null)!;
    expect(note).toContain('这一轮的上下文已经到 123k token');
    expect(note).toContain('做完了什么、还剩什么、下一步从哪里开始');
    expect(note).toContain('@ 负责人');
    expect(note).toContain('下一轮会换成新会话');
  });

  it('then again only after the context grew by another step, more briefly', () => {
    expect(wrapUpNote(123_400 + WRAP_UP_AGAIN - 1, 120_000, 123_400)).toBeNull();
    const again = wrapUpNote(123_400 + WRAP_UP_AGAIN, 120_000, 123_400)!;
    expect(again).toContain('请现在就收尾');
    expect(again.split('\n')).toHaveLength(1);
  });
});
