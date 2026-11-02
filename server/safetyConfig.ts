// The safety settings (settings.safety, ADR 007): defaults, and cleaning up what is stored. Pure,
// so the settings store can use it without pulling in the guard or the audit log.

import type { SafetySettings } from '../shared/types';

/** The guard and the stripped environment are on by default (ADR 007 says why); the audit log is opt-in. */
export const DEFAULT_SAFETY: SafetySettings = { guard: true, stripCredentials: true, audit: false };

export function normalizeSafety(raw: unknown): SafetySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SafetySettings>;
  return {
    guard: typeof r.guard === 'boolean' ? r.guard : DEFAULT_SAFETY.guard,
    stripCredentials: typeof r.stripCredentials === 'boolean' ? r.stripCredentials : DEFAULT_SAFETY.stripCredentials,
    audit: r.audit === true,
  };
}
