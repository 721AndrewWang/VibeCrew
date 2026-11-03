// Reading stored settings field by field: what every normalize* function does with a value it
// cannot trust (an older format, a hand edit, a partial patch). Pure.

/** A stored value as an object whose fields can be read one by one; anything else reads as empty. */
export const fields = <T>(raw: unknown): Partial<T> => (raw && typeof raw === 'object' ? raw : {}) as Partial<T>;

/** A boolean when one is stored, else the default. */
export const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** A model name: trimmed and at most 200 characters; the default when none is stored. */
export const modelName = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.trim().slice(0, 200) : fallback);

/**
 * A stored number clamped to [min, max] and rounded to `step` (1: whole numbers, 0.01: cents, 0:
 * as it is). What is not a number reads as the fallback; a blank value (null, '') reads as 0
 * unless `blank` is 'fallback'.
 */
export function bounded(v: unknown, min: number, max: number, fallback: number, opts: { step?: 1 | 0.01 | 0; blank?: 'zero' | 'fallback' } = {}): number {
  const { step = 1, blank = 'zero' } = opts;
  const n = Number(v);
  if (!Number.isFinite(n) || (blank === 'fallback' && (v === undefined || v === null || v === ''))) return fallback;
  const rounded = step === 1 ? Math.round(n) : step === 0.01 ? Math.round(n * 100) / 100 : n;
  return Math.max(min, Math.min(max, rounded));
}
