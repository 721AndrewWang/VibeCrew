import { describe, expect, it } from 'vitest';
import { WRAP_UP_AGAIN, wrapUpNote } from '../../server/agents/wrapUp';

describe('wrapUpNote', () => {
  it('stays quiet below the limit, and when switched off', () => {
    expect(wrapUpNote(119_999, 120_000, null)).toBeNull();
    expect(wrapUpNote(500_000, 0, null)).toBeNull();
  });

  it('asks once to finish the step in hand and hand back with a summary', () => {
    const note = wrapUpNote(123_400, 120_000, null)!;
    expect(note).toContain("This turn's context has reached 123k tokens");
    expect(note).toContain('what is done, what is left, and where the next step starts');
    expect(note).toContain('@ the lead');
    expect(note).toContain('The next turn starts a new session');
  });

  it('then again only after the context grew by another step, more briefly', () => {
    expect(wrapUpNote(123_400 + WRAP_UP_AGAIN - 1, 120_000, 123_400)).toBeNull();
    const again = wrapUpNote(123_400 + WRAP_UP_AGAIN, 120_000, 123_400)!;
    expect(again).toContain('Wrap up now');
    expect(again.split('\n')).toHaveLength(1);
  });
});
