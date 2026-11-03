// The chain of recall's settings (settings.superAgent.recall): defaults, and cleaning up what is
// stored. Pure, so the trigger settings can normalise it without pulling in the graph.

import { DEFAULT_RECALL } from '../../shared/defaults';
import type { RecallSettings } from '../../shared/types';
import { bounded, fields } from '../normalize';

export const INLINE_WORDS_RANGE = { min: 20, max: 200 } as const;

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeRecall(raw: unknown): RecallSettings {
  const r = fields<RecallSettings>(raw);
  return {
    enabled: r.enabled === true,
    inlineWords: bounded(r.inlineWords, INLINE_WORDS_RANGE.min, INLINE_WORDS_RANGE.max, DEFAULT_RECALL.inlineWords),
  };
}
