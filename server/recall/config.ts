// The chain of recall's settings (settings.superAgent.recall): defaults, and cleaning up what is
// stored. Pure, so the trigger settings can normalise it without pulling in the graph.

import type { RecallSettings } from '../../shared/types';

export const DEFAULT_RECALL: RecallSettings = { enabled: false, inlineWords: 50 };

export const INLINE_WORDS_RANGE = { min: 20, max: 200 } as const;

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeRecall(raw: unknown): RecallSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RecallSettings>;
  const n = Number(r.inlineWords);
  return {
    enabled: r.enabled === true,
    inlineWords: Number.isFinite(n) ? Math.max(INLINE_WORDS_RANGE.min, Math.min(INLINE_WORDS_RANGE.max, Math.round(n))) : DEFAULT_RECALL.inlineWords,
  };
}
