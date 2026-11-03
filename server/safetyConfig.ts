// The safety settings (settings.safety, ADR 007): defaults, and cleaning up what is stored. Pure,
// so the settings store can use it without pulling in the guard or the audit log.

import { DEFAULT_SAFETY } from '../shared/defaults';
import type { SafetySettings } from '../shared/types';
import { fields, flag } from './normalize';

/** Defined in shared/ for the settings forms; re-exported where the tests read it. */
export { DEFAULT_SAFETY };

export function normalizeSafety(raw: unknown): SafetySettings {
  const r = fields<SafetySettings>(raw);
  return {
    guard: flag(r.guard, DEFAULT_SAFETY.guard),
    stripCredentials: flag(r.stripCredentials, DEFAULT_SAFETY.stripCredentials),
    audit: r.audit === true,
  };
}
