// One vocabulary for every Super-agent view (ADR 107): what each part is called, what its switch
// does and costs, and how a status reads (its words and its tone). Settings, the chat's bars, the
// Triggers, Activity and Watchdog pages and the docs all use these names, so one thing never goes
// by two names. Pure data: no React, no store, so it can be tested on its own.

import type { BackgroundJob, ExternalDraft, PublicSettings, RouterInfo, SpeculationStatus, Trigger, WatchdogInfo, WatchdogTick, WorkerStatus } from '../../shared/types';
import { fmtUsd } from './utils';

// ---------------------------------------------------------------- status tones

/**
 * What a status means to the user, whatever object it belongs to. Orange is kept for "needs you":
 * work in progress is the accent, never orange, so a glance at the badges says where to look.
 */
export type Tone = 'active' | 'attention' | 'ok' | 'failed' | 'neutral';

/** The badge class of each tone (styles/base.css `.badge.*`). */
export const TONE_CLASS: Record<Tone, string> = { active: 'accent', attention: 'orange', ok: 'green', failed: 'red', neutral: '' };

export interface StatusInfo {
  label: string;
  tone: Tone;
}

export const WORKER_STATUS: Record<WorkerStatus, StatusInfo> = {
  starting: { label: 'Starting', tone: 'active' },
  running: { label: 'Working', tone: 'active' },
  waiting: { label: 'Needs you', tone: 'attention' },
  done: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'failed' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

export const JOB_STATUS: Record<BackgroundJob['status'], StatusInfo> = {
  running: { label: 'Running', tone: 'active' },
  waiting: { label: 'Needs you', tone: 'attention' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'failed' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

export const SPECULATION_STATUS: Record<SpeculationStatus, StatusInfo> = {
  skipped: { label: 'Skipped', tone: 'neutral' },
  running: { label: 'Working', tone: 'active' },
  verifying: { label: 'Checking', tone: 'active' },
  ready: { label: 'Fix ready', tone: 'attention' },
  merged: { label: 'Merged', tone: 'ok' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

export const DRAFT_STATUS: Record<ExternalDraft['status'], StatusInfo> = {
  pending: { label: 'Waiting for you', tone: 'attention' },
  running: { label: 'Running', tone: 'active' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'failed' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

export const ROUTER_STATE: Record<RouterInfo['state'], StatusInfo> = {
  idle: { label: 'Idle', tone: 'neutral' },
  thinking: { label: 'Thinking', tone: 'active' },
  error: { label: 'Failed', tone: 'failed' },
};

export const WATCHDOG_STATE: Record<WatchdogInfo['state'], StatusInfo> = {
  off: { label: 'Off', tone: 'neutral' },
  idle: { label: 'Idle', tone: 'neutral' },
  thinking: { label: 'Looking', tone: 'active' },
  error: { label: 'Failed', tone: 'failed' },
};

export const TICK_OUTCOME: Record<WatchdogTick['outcome'], StatusInfo> = {
  ran: { label: 'Looked', tone: 'active' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  error: { label: 'Failed', tone: 'failed' },
};

/** A Trigger the slow path still has to decide on is in progress, not waiting for the user. */
export const TRIGGER_VERDICT: Record<Trigger['filter']['verdict'], StatusInfo> = {
  act: { label: 'Act', tone: 'ok' },
  candidate: { label: 'Deciding', tone: 'active' },
  drop: { label: 'Dropped', tone: 'neutral' },
};

// ---------------------------------------------------------------- money

/**
 * Every cost in the Super-agent views reads the same way: the app's dollar format (`fmtUsd`), and
 * "<$0.01" for the fractions of a cent most calls cost.
 */
export function fmtCost(usd: number | undefined): string {
  const n = usd || 0;
  if (n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return fmtUsd(n);
}

// ---------------------------------------------------------------- the parts

export type PartId = 'triggers' | 'router' | 'direct' | 'recall' | 'watchdog' | 'speculative' | 'github' | 'webhook' | 'jobs' | 'gateway';

/** Where a part's switch lives: Settings → Super-agent, a project's settings, a bot's, or Settings → Model gateway. */
export type PartScope = 'global' | 'project' | 'bot' | 'gateway';

export interface Part {
  id: PartId;
  /** Its one name, in the UI, in settings and in the docs. */
  name: string;
  /** What turning it on does, in a sentence. */
  does: string;
  /** What it costs while on (processes, files and model calls), with the user's current limits. */
  cost: (s: PublicSettings) => string;
  /** The part that has to be on first. */
  needs?: PartId;
  scope: PartScope;
  /** In the recommended set ("Turn on the core"). */
  core?: boolean;
}

/**
 * In the order a user turns them on. The costs are the defaults from ARCHITECTURE.md
 * ("Turning it on, and what each switch costs"); the limits named are adjustable below each switch.
 */
export const PARTS: Part[] = [
  {
    id: 'triggers',
    name: 'Triggers',
    does: 'Every message, routine run, turn result, outside edit and preview console error becomes a Trigger on a Thread; rules settle most of them and a cheap model judges the rest against your policies.',
    cost: (s) =>
      s.superAgent.maxCandidatesPerHour > 0
        ? `About $0.002 per batch of up to 8 events the rules leave open, at most ${s.superAgent.maxCandidatesPerHour} batches an hour. Keeps at most 2,000 Triggers for 14 days.`
        : 'No model call: everything is settled by the rules (0 model decisions an hour). Keeps at most 2,000 Triggers for 14 days.',
    scope: 'global',
    core: true,
  },
  {
    id: 'router',
    name: 'Router and Workers',
    does: 'Each group chat gets a Router that answers you in a few words and dispatches Workers; each Worker does one task in its own session and git worktree, and its work is merged into the chat’s branch.',
    cost: (s) =>
      `A Router turn per batch of events (a lighter model), and each Worker's turns (the strongest model), at most ${s.superAgent.router.maxWorkers} Workers at once per chat. One process per Router and per Worker, closed after 15 idle minutes, and a git worktree per Worker.`,
    needs: 'triggers',
    scope: 'global',
    core: true,
  },
  {
    id: 'direct',
    name: 'Direct routing',
    does: 'Workers subscribe to the Threads of their task; later events there go straight to them, without a Router decision.',
    cost: () => 'Nothing extra: fewer Router turns, a few short events in Workers’ context.',
    needs: 'router',
    scope: 'global',
    core: true,
  },
  {
    id: 'recall',
    name: 'Chain of recall',
    does: 'Prompts carry ids and only the first words of older objects; agents read the rest with a recall tool.',
    cost: () => 'Nothing extra: usually smaller prompts, sometimes one extra lookup. Idle sessions restart when you switch it.',
    needs: 'triggers',
    scope: 'global',
    core: true,
  },
  {
    id: 'watchdog',
    name: 'Watchdog',
    does: 'A timer outside the chats flags stuck, looping or failed work; only then does a light model look, and it may nudge, stop or restart a Worker or tell a chat.',
    cost: (s) => `No model call while nothing is flagged; at most ${s.superAgent.watchdog.maxTicksPerHour} looks an hour and ${fmtCost(s.superAgent.watchdog.dailyBudgetUsd)} a day.`,
    needs: 'triggers',
    scope: 'global',
  },
  {
    id: 'speculative',
    name: 'Speculative fixes',
    does: 'A failing check, a console error or a bug report may start a quiet Worker in a throwaway worktree; only a fix the project’s check command proves is shown, with a one-click merge.',
    cost: (s) =>
      `A full Worker session per run, at most ${s.superAgent.speculative.maxConcurrent} at once, ${s.superAgent.speculative.maxMinutes} minutes each and ${fmtCost(s.superAgent.speculative.dailyBudgetUsd)} a day across projects.`,
    needs: 'triggers',
    scope: 'project',
  },
  {
    id: 'github',
    name: 'GitHub channel',
    does: 'Polls the repositories a project watches with your gh CLI for issues, comments, review comments and check results. It only reads; nothing is posted until you approve a draft.',
    cost: () => 'Read-only gh calls every few minutes (5 by default); no model call of its own.',
    needs: 'triggers',
    scope: 'project',
  },
  {
    id: 'webhook',
    name: 'Router notifications',
    does: 'Sends the Router’s replies of the kinds you pick to a Slack or Feishu webhook.',
    cost: () => 'One request per approved reply; no model call.',
    needs: 'router',
    scope: 'project',
  },
  {
    id: 'jobs',
    name: 'Background jobs',
    does: 'A bot marked full duplex runs long commands and sub-tasks in the background and keeps talking; the result comes back as a new event.',
    cost: () => 'Up to 4 background processes per chat; sub-tasks are the bot’s own spend.',
    scope: 'bot',
  },
  {
    id: 'gateway',
    name: 'Model gateway',
    does: 'Every session’s calls go out under its role (Router, Worker, Watchdog, speculative run), with failover between providers and spend windows.',
    cost: () => 'One local listener; no model call of its own.',
    scope: 'gateway',
  },
];

export const PART: Record<PartId, Part> = Object.fromEntries(PARTS.map((p) => [p.id, p])) as Record<PartId, Part>;

/** Whether a global part's own switch is on (whatever its prerequisites say). Per-project and per-bot parts are counted by the caller. */
export function switchOn(id: PartId, s: PublicSettings): boolean {
  const sa = s.superAgent;
  switch (id) {
    case 'triggers':
      return sa.enabled;
    case 'router':
      return sa.router.enabled;
    case 'direct':
      return sa.router.subscriptions;
    case 'recall':
      return sa.recall.enabled;
    case 'watchdog':
      return sa.watchdog.enabled;
    case 'gateway':
      return s.gateway.enabled;
    default:
      return false;
  }
}

/** The first part this one needs that is off, so the UI can say "Needs Triggers" instead of a dead switch. */
export function blockedBy(id: PartId, s: PublicSettings): Part | undefined {
  for (let need = PART[id].needs; need; need = PART[need].needs) if (!switchOn(need, s)) return PART[need];
  return undefined;
}

/** The settings patch that turns a global part on or off. */
export function partPatch(id: PartId, on: boolean, s: PublicSettings): Partial<PublicSettings['superAgent']> {
  const sa = s.superAgent;
  switch (id) {
    case 'triggers':
      return { enabled: on };
    case 'router':
      return { router: { ...sa.router, enabled: on } };
    case 'direct':
      return { router: { ...sa.router, subscriptions: on } };
    case 'recall':
      return { recall: { ...sa.recall, enabled: on } };
    case 'watchdog':
      return { watchdog: { ...sa.watchdog, enabled: on } };
    default:
      return {};
  }
}

/** The recommended set in one patch: the parts marked `core`, all on. */
export function corePatch(s: PublicSettings): Partial<PublicSettings['superAgent']> {
  const sa = s.superAgent;
  return { enabled: true, router: { ...sa.router, enabled: true, subscriptions: true }, recall: { ...sa.recall, enabled: true } };
}

/** The anchor of a part's block in Settings → Super-agent, so "Turn it on" links land on the switch. */
export const partAnchor = (id: PartId) => `sa-part-${id}`;
