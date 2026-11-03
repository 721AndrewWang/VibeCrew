// Speculative execution's settings (ADR 008): the shared limits (settings.superAgent.speculative)
// and a project's switch (Project.speculative). Defaults, cleaning up what is stored, and the check
// command a project has when it set none. Pure, so the trigger settings can normalise it.

import { DEFAULT_PROJECT_SPECULATIVE, DEFAULT_SPECULATIVE } from '../../shared/speculative';
import type { ProjectSpeculative, SpeculativeSettings } from '../../shared/types';
import { bounded, fields, flag, modelName } from '../normalize';

export { DEFAULT_PROJECT_SPECULATIVE, DEFAULT_SPECULATIVE };

export const MAX_CONCURRENT_LIMIT = 4;

const num = (v: unknown, fallback: number, min: number, max: number, step: 1 | 0.01 = 1) => bounded(v, min, max, fallback, { step, blank: 'fallback' });

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeSpeculative(raw: unknown): SpeculativeSettings {
  const r = fields<SpeculativeSettings>(raw);
  return {
    model: modelName(r.model, DEFAULT_SPECULATIVE.model),
    dailyBudgetUsd: num(r.dailyBudgetUsd, DEFAULT_SPECULATIVE.dailyBudgetUsd, 0, 100, 0.01),
    maxConcurrent: num(r.maxConcurrent, DEFAULT_SPECULATIVE.maxConcurrent, 1, MAX_CONCURRENT_LIMIT),
    maxMinutes: num(r.maxMinutes, DEFAULT_SPECULATIVE.maxMinutes, 5, 120),
  };
}

/** A project's switch, filled in; undefined (never set) reads as off. */
export function normalizeProjectSpeculative(raw: unknown): ProjectSpeculative {
  const r = fields<ProjectSpeculative>(raw);
  const s = fields<ProjectSpeculative['signals']>(r.signals);
  const d = DEFAULT_PROJECT_SPECULATIVE;
  return {
    enabled: r.enabled === true,
    checkCommand:
      typeof r.checkCommand === 'string'
        ? r.checkCommand
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, 500)
        : '',
    signals: {
      failingChecks: flag(s.failingChecks, d.signals.failingChecks),
      consoleErrors: flag(s.consoleErrors, d.signals.consoleErrors),
      bugReports: flag(s.bugReports, d.signals.bugReports),
    },
    maxFixLines: num(r.maxFixLines, d.maxFixLines, 1, 2000),
  };
}

/** npm's placeholder test script: it always fails, so it verifies nothing. */
const NPM_PLACEHOLDER = /no test specified/i;

/**
 * The check command a project has without setting one: `npm test` when package.json has a real
 * test script, else none (nothing could verify a fix).
 */
export function detectCheckCommand(packageJson: string | null): string {
  if (!packageJson) return '';
  try {
    const test = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> })?.scripts?.test;
    return typeof test === 'string' && test.trim() && !NPM_PLACEHOLDER.test(test) ? 'npm test' : '';
  } catch {
    return '';
  }
}
