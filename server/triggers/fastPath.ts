// The Trigger bus's fast path: deterministic rules in code, per source, that settle most events
// before any model sees them. Explicit requests are acted on, noise and anything outside the
// allow-lists is dropped, and only what is left goes on to the cheap model as a candidate.
// Pure: everything it needs comes in as arguments, so it is cheap to run and easy to test.

import crypto from 'node:crypto';
import type { FilteredSource, SourceRule, SuperAgentSettings, Thread, Trigger, TriggerFilter, TriggerSource } from '../../shared/types';
import { glob } from '../agents/permissions';
import { DEFAULT_ROUTER, normalizeRouter } from '../layers/config';
import { DEFAULT_WATCHDOG, normalizeWatchdog } from '../watchdog/config';

export const FILTERED_SOURCES: FilteredSource[] = ['turn', 'outside-edit', 'preview-console'];

export const DEFAULT_POLICIES = [
  "- Preview console errors: act when the error comes from the app's own code (an uncaught exception, a module that fails to load, a failed request to the app's own server). Stay quiet about third-party scripts, browser extensions, ads and analytics.",
  '- Failed bot turns: act when the cause is something the user has to fix (login, budget, a missing tool, a broken setup command). Stay quiet about a one-off network blip that a retry would fix.',
  '- Files changed outside the chat: act only when the change can break what the bots are working on, e.g. dependency manifests, build or framework config, or files a bot changed moments ago. Stay quiet about ordinary edits.',
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
  watchdog: DEFAULT_WATCHDOG,
};

const MODES = new Set(['explicit', 'candidate', 'ignore']);

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim().slice(0, 300))
            .filter(Boolean),
        ),
      ].slice(0, max)
    : [];

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeSuperAgent(raw: unknown): SuperAgentSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SuperAgentSettings>;
  const given = (r.sources || {}) as Partial<Record<FilteredSource, Partial<SourceRule>>>;
  const sources = {} as Record<FilteredSource, SourceRule>;
  for (const s of FILTERED_SOURCES) {
    const v = given[s];
    sources[s] = { mode: v?.mode && MODES.has(v.mode) ? v.mode : DEFAULT_SUPER_AGENT.sources[s].mode, allow: strings(v?.allow, 50) };
  }
  const max = Number(r.maxCandidatesPerHour);
  return {
    enabled: r.enabled === true,
    sources,
    projects: strings(r.projects, 200),
    // An emptied policy box stays empty: the user may want the model to see no policy at all.
    policies: typeof r.policies === 'string' ? r.policies.slice(0, 10_000) : DEFAULT_POLICIES,
    maxCandidatesPerHour: Number.isFinite(max) ? Math.max(0, Math.min(1000, Math.round(max))) : DEFAULT_SUPER_AGENT.maxCandidatesPerHour,
    router: normalizeRouter(r.router),
    watchdog: normalizeWatchdog(r.watchdog),
  };
}

/** A thread that got a notice stays quiet this long. */
export const NOTICE_COOLDOWN_MS = 10 * 60_000;
/** The same event within this long of one the model already saw is a duplicate. */
export const DUPLICATE_MS = 30 * 60_000;

/** Console lines that are not about the app: dev-server chatter, browser hints, the favicon. */
const CONSOLE_NOISE = [/favicon\.ico/i, /\[(vite|hmr|webpack-dev-server|wds)\]/i, /ResizeObserver loop/i, /Download the React DevTools/i, /^\s*$/];

export function isConsoleNoise(text: string): boolean {
  return CONSOLE_NOISE.some((re) => re.test(text));
}

/**
 * A short hash of what an event is about, insensitive to what changes between two sightings of
 * the same thing (line and column numbers, ports, counters, cache-busting query strings).
 */
export function fingerprintOf(source: TriggerSource, parts: string[]): string {
  const norm = [
    ...new Set(
      parts.map((p) =>
        p
          .toLowerCase()
          .replace(/\?[^\s)]*/g, '')
          .replace(/\d+/g, '#')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    ),
  ].sort();
  return crypto
    .createHash('sha1')
    .update(`${source}\n${norm.join('\n')}`)
    .digest('hex')
    .slice(0, 12);
}

/** File paths are matched as globs (relative to the project); text as case-insensitive substrings. */
export function allowMatches(pattern: string, subject: string, source: FilteredSource): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (source === 'outside-edit') return glob(p).test(subject);
  return subject.toLowerCase().includes(p.toLowerCase());
}

export interface FastInput {
  source: TriggerSource;
  explicit: boolean;
  /** The trigger's top-level project (a workspace counts as its parent), for the project allow-list. */
  rootProjectId: string | null;
  /** What allow-lists match against: changed file paths, or console error lines. */
  subjects: string[];
  fingerprint: string;
  /** Source facts the noise rules read: how a turn ended, how many console entries were errors, whether code already delivered it. */
  facts: { status?: string; errors?: number; routed?: boolean };
}

export interface FastContext {
  settings: SuperAgentSettings;
  thread: Thread;
  /** The thread's recent triggers, newest first. */
  recent: Trigger[];
  /** Triggers (any thread) that went to the slow path in the last hour. */
  candidatesLastHour: number;
  now: number;
  /** The Workers that would receive it straight away, by their subscriptions to the thread (ADR 003). */
  subscribers?: string[];
}

/** Whether a trigger got as far as the cheap model (or is waiting for it). */
export function reachedSlowPath(t: Trigger): boolean {
  return t.filter.stage === 'slow' || t.filter.verdict === 'candidate';
}

const SOURCE_NAME: Record<TriggerSource, string> = {
  user: 'User messages',
  routine: 'Routine runs',
  turn: 'Bot turn results',
  'outside-edit': 'Outside edits',
  'preview-console': 'Preview console errors',
  landing: "Workers' merges",
};

export function fastPath(t: FastInput, ctx: FastContext): TriggerFilter {
  const act = (rule: string, reason: string): TriggerFilter => ({ verdict: 'act', stage: 'fast', rule, reason });
  const drop = (rule: string, reason: string): TriggerFilter => ({ verdict: 'drop', stage: 'fast', rule, reason });
  const subscribers = ctx.subscribers ?? [];
  const direct = () => act('subscribed', `Sent straight to ${subscribers.length === 1 ? 'the Worker' : `${subscribers.length} Workers`} subscribed to this thread; no Router decision`);
  // The user's own messages and routines, and a bot handing work to a teammate: the chat acts on them as always.
  if (t.explicit || t.source === 'user' || t.source === 'routine') return subscribers.length ? direct() : act('explicit-request', 'An explicit request; handled by the chat without a model');
  // A Worker's turn result already went straight to the Router that dispatched it.
  if (t.facts.routed) return act('routed', 'A Worker reported back; delivered to its Router directly');
  // Another Worker's merge matters only to the Workers sharing the workspace; the Router has its report.
  if (t.source === 'landing') return subscribers.length ? direct() : drop('no-subscribers', 'No other Worker is working on this branch right now');

  const source = t.source;
  const rule = ctx.settings.sources[source];
  if (rule.mode === 'ignore') return drop('source-ignored', `${SOURCE_NAME[source]} are set to be ignored`);
  if (rule.mode === 'explicit') return drop('explicit-only', `${SOURCE_NAME[source]} are acted on only when explicitly requested`);

  let subjects = t.subjects;
  if (source === 'turn') {
    if (t.facts.status === 'stopped') return drop('stopped-by-user', 'The user stopped this turn');
    if (t.facts.status !== 'error') return drop('reported-back', 'The turn finished normally; the chat already shows its reply');
  }
  if (source === 'preview-console') {
    if (!t.facts.errors) return drop('no-errors', 'Only warnings or logs, no errors');
    subjects = subjects.filter((s) => !isConsoleNoise(s));
    if (!subjects.length) return drop('known-noise', 'Only known noise (dev-server messages, favicon, browser hints)');
  }

  // Subscribed: the thread's Workers take it, so the rules that save model calls (allow-lists, cooldown, budget) do not apply.
  if (subscribers.length) {
    const twin = ctx.recent.find((r) => r.fingerprint === t.fingerprint && ctx.now - r.at < DUPLICATE_MS && r.filter.rule === 'subscribed');
    if (twin) return drop('duplicate', `Same as ${twin.id}, which already went to this thread's Workers`);
    return direct();
  }

  const projects = ctx.settings.projects;
  if (projects.length && !(t.rootProjectId && projects.includes(t.rootProjectId))) return drop('project-not-allowed', 'The project is not on the allow-list');
  if (rule.allow.length && !subjects.some((s) => rule.allow.some((p) => allowMatches(p, s, source)))) return drop('not-allow-listed', 'Nothing in it matches the allow-list for this source');

  if (ctx.thread.lastNoticeAt && ctx.now - ctx.thread.lastNoticeAt < NOTICE_COOLDOWN_MS) {
    return drop('cooldown', `This thread got a notice ${Math.max(1, Math.round((ctx.now - ctx.thread.lastNoticeAt) / 60_000))} min ago; staying quiet`);
  }
  const twin = ctx.recent.find((r) => r.fingerprint === t.fingerprint && ctx.now - r.at < DUPLICATE_MS && reachedSlowPath(r));
  if (twin) return drop('duplicate', `Same as ${twin.id}, which the model already saw`);
  if (ctx.candidatesLastHour >= ctx.settings.maxCandidatesPerHour) return drop('over-budget', `The hourly budget of ${ctx.settings.maxCandidatesPerHour} model decisions is used up`);
  return { verdict: 'candidate', stage: 'fast', rule: 'candidate', reason: 'Passed the rules; waiting for the cheap model' };
}
