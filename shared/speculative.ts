// Speculative execution's defaults (ADR 008), shared by the server and the settings forms.

import type { ProjectSpeculative, SpeculativeSettings } from './types';

export const DEFAULT_SPECULATIVE: SpeculativeSettings = {
  // Empty: the Workers' model (a fix wants the strongest one).
  model: '',
  dailyBudgetUsd: 2,
  maxConcurrent: 2,
  maxMinutes: 20,
};

export const DEFAULT_PROJECT_SPECULATIVE: ProjectSpeculative = {
  enabled: false,
  checkCommand: '',
  signals: { failingChecks: true, consoleErrors: true, bugReports: true },
  maxFixLines: 120,
};
