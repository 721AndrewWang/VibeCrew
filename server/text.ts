// Counting and cutting words, the one way every prompt, gate and profile does it. Pure.

const range = (from: number, to: number) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
/** Scripts written without spaces between words (kana, CJK ideographs, Hangul): one character, one word. */
const CJK_CLASS = `${range(0x3040, 0x30ff)}${range(0x3400, 0x9fff)}${range(0xac00, 0xd7af)}${range(0xf900, 0xfaff)}`;
const WORD = new RegExp(`[${CJK_CLASS}]|[^\\s${CJK_CLASS}]+`, 'g');
export const CJK = new RegExp(`[${CJK_CLASS}]`, 'g');

/** Where each word ends, in characters. */
export function wordEnds(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(WORD)) ends.push((m.index ?? 0) + m[0].length);
  return ends;
}

export const wordCount = (text: string) => wordEnds(text).length;

/** The first `n` whitespace-separated words, joined by single spaces, and how many were left out. */
export function firstWords(text: string, n: number): { text: string; rest: number } {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > n ? { text: `${words.slice(0, n).join(' ')} …`, rest: words.length - n } : { text: words.join(' '), rest: 0 };
}

/** Whitespace collapsed to one line, at most `max` characters, the last one an ellipsis when cut. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
