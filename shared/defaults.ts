// Every Super-agent setting's default, shared by the server (which normalises what is stored
// against them) and the UI (which shows them until the settings arrive).

import type { GithubChannel, ProjectSpeculative, RecallSettings, RouterSettings, SafetySettings, SpeculativeSettings, SuperAgentSettings, WatchdogSettings } from './types';

export const DEFAULT_ROUTER: RouterSettings = {
  enabled: false,
  // Routing, batching events and short replies: a lighter model is enough.
  model: 'claude-sonnet-5',
  // Empty: the chat's model switch, else the default model, which is Claude Code's strongest unless changed.
  workerModel: '',
  maxWorkers: 3,
  // ADR 003: off keeps every event going through the Router, as in ADR 002.
  subscriptions: false,
};

export const DEFAULT_RECALL: RecallSettings = { enabled: false, inlineWords: 50 };

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: false,
  // Judging progress from a compact snapshot: a lighter model is enough.
  model: 'claude-sonnet-5',
  everyMinutes: 15,
  maxTicksPerHour: 4,
  maxActionsPerTick: 3,
  dailyBudgetUsd: 1,
  stuckMinutes: 20,
};

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

export const DEFAULT_POLICIES = [
  "- Preview console errors: act when the error comes from the app's own code (an uncaught exception, a module that fails to load, a failed request to the app's own server). Stay quiet about third-party scripts, browser extensions, ads and analytics.",
  '- Failed bot turns: act when the cause is something the user has to fix (login, budget, a missing tool, a broken setup command). Stay quiet about a one-off network blip that a retry would fix.',
  '- Files changed outside the chat: act only when the change can break what the bots are working on, e.g. dependency manifests, build or framework config, or files a bot changed moments ago. Stay quiet about ordinary edits.',
  '- GitHub: act on a new issue that reports a bug or asks for a change, a review comment that asks for a change, and a failing check on an open pull request. Stay quiet about thanks, chatter and questions already answered.',
  '- When unsure, stay quiet.',
].join('\n');

export const DEFAULT_SUPER_AGENT: SuperAgentSettings = {
  enabled: false,
  sources: {
    turn: { mode: 'candidate', allow: [] },
    'outside-edit': { mode: 'candidate', allow: [] },
    'preview-console': { mode: 'candidate', allow: [] },
  },
  projects: [],
  policies: DEFAULT_POLICIES,
  maxCandidatesPerHour: 30,
  router: DEFAULT_ROUTER,
  recall: DEFAULT_RECALL,
  watchdog: DEFAULT_WATCHDOG,
  speculative: DEFAULT_SPECULATIVE,
};

/** The guard and the stripped environment are on by default (ADR 007 says why); the audit log is opt-in. */
export const DEFAULT_SAFETY: SafetySettings = { guard: true, stripCredentials: true, audit: false };

export const DEFAULT_GITHUB: GithubChannel = {
  enabled: false,
  repos: [],
  everyMinutes: 5,
  authors: [],
  events: { issues: true, comments: true, reviewComments: true, checks: true },
  candidates: true,
};
