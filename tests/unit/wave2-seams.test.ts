// The seams between the second wave of Super-agent branches (ADR 011), where they are pure.
import { describe, expect, it } from 'vitest';
import { asyncProfileFor, asyncRefusal, FOLD_LINES, shapeAsync } from '../../server/channels/profiles';
import { asyncBody } from '../../server/github/gates';

describe('GitHub drafts follow the channel profiles (ADR 102 × 103)', () => {
  it('writes a reply to a review comment as a comment', () => {
    expect(asyncProfileFor('review-reply')).toBe('comment');
  });

  it('accepts draft_github’s three sections as a pull request and folds long output in them', () => {
    const log = Array.from({ length: FOLD_LINES + 5 }, (_, i) => `ok ${i}`).join('\n');
    const body = asyncBody({
      background: 'Issue #12: the cart total ignores the discount when the basket holds more than ten items, which customers noticed at checkout.',
      change: 'src/cart.ts applies the discount before rounding; a regression test covers baskets of eleven and twelve items.',
      verification: `npm test passes:\n\n\`\`\`\n${log}\n\`\`\``,
    });
    expect(asyncRefusal('pull-request', body)).toBeNull();
    expect(asyncRefusal('comment', body)).toBeNull();
    const shaped = shapeAsync('comment', body);
    expect(shaped).toContain(`<details><summary>Output (${FOLD_LINES + 5} lines)</summary>`);
    expect(shaped.startsWith('### Background')).toBe(true);
  });

  it('refuses a loose stack trace in a GitHub draft like in any other', () => {
    const body = asyncBody({ background: 'Crash.', change: 'TypeError: x is undefined\n    at f (src/a.ts:1:2)\n    at g (src/b.ts:3:4)', verification: 'Ran it.' });
    expect(asyncRefusal('comment', body)).toMatch(/outside a code block/);
  });
});
