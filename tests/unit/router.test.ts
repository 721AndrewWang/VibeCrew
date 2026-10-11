import { describe, expect, it } from 'vitest';
import { auroc, combine, parseProbs, wilsonLower } from '../../server/router';

const order = [
  { id: 'b1', name: 'Chief', title: '' },
  { id: 'b2', name: 'Pixel', title: '' },
];

describe('parseProbs', () => {
  it('maps names to bot ids and normalises small rounding', () => {
    expect(parseProbs('{"probabilities": {"Chief": 0.3, "Pixel": 0.69}}', order)).toEqual({ b1: 0.3 / 0.99, b2: 0.69 / 0.99 });
    expect(parseProbs('```json\n{"Chief": 0.5, "Pixel": 0.5}\n```', order)).toEqual({ b1: 0.5, b2: 0.5 });
  });
  it('refuses missing names, bad numbers and sums far from 1', () => {
    expect(() => parseProbs('{"probabilities": {"Chief": 1}}', order)).toThrow('Pixel');
    expect(() => parseProbs('{"probabilities": {"Chief": 0.9, "Pixel": 0.9}}', order)).toThrow('add up');
    expect(() => parseProbs('Either is fine', order)).toThrow();
  });
});

describe('combine', () => {
  it('averages both orders, so a judge that favours the first one listed cancels out', () => {
    // Listed Chief-first it says Chief 0.8; listed Pixel-first it says Pixel 0.6.
    const c = combine({ b1: 0.8, b2: 0.2 }, { b1: 0.4, b2: 0.6 });
    expect(c.probs.b1).toBeCloseTo(0.6, 9);
    expect(c.probs.b2).toBeCloseTo(0.4, 9);
    expect(c.choice).toBe('b1');
    expect(c.confidence).toBeCloseTo(0.6, 9);
  });
});

describe('auroc', () => {
  const s = (q: number, ok: boolean) => ({ q, ok });
  it('is 1 when every right guess is surer than every wrong one, 0.5 when confidence says nothing', () => {
    expect(auroc([s(0.9, true), s(0.8, true), s(0.6, false), s(0.5, false)])).toBe(1);
    expect(auroc([s(0.7, true), s(0.7, false)])).toBe(0.5);
    expect(auroc([s(0.9, true), s(0.6, true), s(0.8, false), s(0.5, false)])).toBe(0.75);
  });
  it('is unknown until there are both right and wrong guesses', () => {
    expect(auroc([s(0.9, true)])).toBeNull();
    expect(auroc([])).toBeNull();
  });
});

describe('wilsonLower', () => {
  it('is cautious with few labels and approaches the rate with many', () => {
    expect(wilsonLower(20, 20)).toBeCloseTo(0.839, 3);
    expect(wilsonLower(95, 100)).toBeCloseTo(0.888, 3);
    expect(wilsonLower(950, 1000)).toBeCloseTo(0.935, 3);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});
