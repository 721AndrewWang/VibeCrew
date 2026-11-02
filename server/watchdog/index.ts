// The Watchdog (ADR 006): an external control loop outside the chats it watches. A croner timer
// ticks; each tick gathers a compact snapshot (Workers and their progress, approvals waiting,
// turn errors, friction, interface errors, watched failures) and computes flags in code. With no
// flags the tick ends there, without a model call. Otherwise the snapshot goes to the Watchdog's
// own session, which can act only through its crew_watchdog tools, each gated in code. Maintainers
// can chat with the same session to ask why something failed; it can propose changes, never apply
// them.
//
// Behind settings.superAgent.watchdog.enabled, which only counts while superAgent.enabled is on:
// off, there is no timer, no folder and no model call.

import fs from 'node:fs';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { Cron } from 'croner';
import type { ChatMessage, WatchdogAction, WatchdogActionKind, WatchdogInfo, WatchdogOverview, WatchdogProposal, WatchdogTick, WatchdogWatch, Worker } from '../../shared/types';
import { type AgentSession, BotSession, FakeSession, type SessionConfig } from '../agents/session';
import type { TurnStream } from '../agents/stream';
import { bus, notify } from '../bus';
import { botModel } from '../claudeAuth';
import { DATA, FAKE_AGENT } from '../config';
import { updateBot } from '../entities';
import { FRICTION_LABEL, readFriction } from '../friction';
import type { Scope } from '../gateway/config';
import { messageWorker, restartWorker, routerEvent, routerInfos, routerMode, stopWorker } from '../layers';
import { BatchQueue } from '../layers/batch';
import { nextSeq, runLogged } from '../layers/turn';
import { logger } from '../log';
import { systemMessage } from '../orchestrator/chatLog';
import { deniedReason, openApprovals } from '../orchestrator/permissionGate';
import { agentEnv } from '../orchestrator/turnContext';
import { HttpError } from '../projects';
import { auditLog, bots, chats, messages, settings, triggerLog, uid, WATCHDOG_LOG, watchdogActions, watchdogProposals, watchdogTicks, watchdogWatches, workers } from '../store';
import { normalizeSuperAgent } from '../triggers/fastPath';
import { cronExpr } from './config';
import { tickRefusal } from './gates';
import { maintainerPrompt, tickPrompt, watchdogRecap, watchdogSystemPrompt } from './prompts';
import { registerWatchdogRecall } from './recall';
import { isTransient, nextCheck, progressOf, WATCH_MAX_CHECKS } from './signals';
import { auditSnaps, isQuiet, renderSnapshot, type Snapshot, snapshotFlags, type WorkerSnap } from './snapshot';
import { type WatchdogTurn, watchdogMcpServer, watchdogTools } from './tools';

const log = logger('watchdog');

/** Stands in for a bot id on the Watchdog's turns: it is not a bot, and its cost counts toward no bot. */
export const WATCHDOG_ID = 'watchdog';
/** Who its model calls are for, in the model gateway's terms (ADR 009). */
const WATCHDOG_SCOPE: Scope = { role: 'watchdog' };
const HOUR = 3600_000;
/** The snapshot never looks further back than this. */
const MAX_WINDOW_MS = 6 * HOUR;
/** A code-opened watch on a transient failure is first re-checked after this many minutes. */
const TRANSIENT_RECHECK_MIN = 5;
const MAX_WORKERS = 12;
const MAX_LIST = 10;
const ACTIVE = new Set(['starting', 'running', 'waiting']);

type Job = { kind: 'tick' | 'manual'; tick: WatchdogTick; reason: string; since: number } | { kind: 'maintainer'; tick: WatchdogTick; messageId: string; text: string };

const startOfToday = (now = Date.now()) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function watchdogOn(): boolean {
  const sa = settings.get().superAgent;
  return sa.enabled && sa.watchdog.enabled;
}

// ---------------------------------------------------------------- the ledger

function recordTick(t: WatchdogTick) {
  watchdogTicks.append(t);
  emitInfo();
}

function spentToday(now = Date.now()): number {
  const from = startOfToday(now);
  return watchdogTicks.recent(Number.MAX_SAFE_INTEGER, (t) => t.at >= from).reduce((s, t) => s + (t.costUsd || 0), 0);
}

function ticksLastHour(now = Date.now()): number {
  return watchdogTicks.recent(Number.MAX_SAFE_INTEGER, (t) => t.at >= now - HOUR && t.outcome !== 'skipped' && t.kind !== 'maintainer').length;
}

function actionsToday(now = Date.now()): WatchdogAction[] {
  const from = startOfToday(now);
  return watchdogActions.recent(Number.MAX_SAFE_INTEGER, (a) => a.at >= from);
}

function countToday(kind: WatchdogActionKind | WatchdogActionKind[], target: string): number {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return actionsToday().filter((a) => !a.refused && a.target === target && kinds.includes(a.kind)).length;
}

/** The last tick that called the model: the snapshot shows what happened since. */
function lastLook(now: number): number {
  const t = watchdogTicks.recent(1, (x) => x.outcome !== 'skipped' && x.kind !== 'maintainer')[0];
  return Math.max(t?.at ?? now - HOUR, now - MAX_WINDOW_MS);
}

// ---------------------------------------------------------------- watches

function openWatches(): WatchdogWatch[] {
  return watchdogWatches
    .all()
    .filter((w) => !w.resolvedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function openWatch(subject: string, note: string, minutes: number, by: WatchdogWatch['by'], now = Date.now()): string {
  const w: WatchdogWatch = { id: uid('ww_'), subject, note, createdAt: now, nextAt: nextCheck(now, minutes, 0), checks: 0, by };
  watchdogWatches.set(w);
  emitInfo();
  return w.id;
}

function resolveWatch(id: string, why: string): boolean {
  const w = watchdogWatches.get(id);
  if (!w || w.resolvedAt) return false;
  watchdogWatches.set({ ...w, resolvedAt: Date.now(), resolution: why.slice(0, 300) });
  emitInfo();
  return true;
}

/**
 * Before each tick, in code: open watches for Workers that failed on something transient, close
 * the ones whose subject is healthy again, and give up on those checked too often.
 */
export function housekeepWatches(now = Date.now()) {
  const open = openWatches();
  for (const w of workers.all()) {
    if (w.dismissedAt || w.speculation || w.status !== 'error' || !isTransient(w.detail || w.report?.text)) continue;
    const since = w.report?.at ?? w.updatedAt;
    if (watchdogWatches.all().some((x) => x.subject === w.id && x.createdAt >= since)) continue;
    openWatch(w.id, `Failed on what looks transient: ${(w.detail || '').slice(0, 200)}`, TRANSIENT_RECHECK_MIN, 'code', now);
  }
  for (const x of open) {
    if (x.subject.startsWith('wk_')) {
      const w = workers.get(x.subject);
      if (!w || w.dismissedAt) {
        resolveWatch(x.id, 'The Worker is gone');
        continue;
      }
      if (w.status !== 'error' && w.status !== 'stopped') {
        resolveWatch(x.id, `Healthy again: the Worker is ${w.status}`);
        continue;
      }
    }
    if (x.checks >= WATCH_MAX_CHECKS && x.nextAt <= now) {
      resolveWatch(x.id, `Gave up after ${x.checks} checks`);
      const w = workers.get(x.subject);
      if (w) tellChat(w.chatId, `The Watchdog gave up re-checking Worker "${w.title}" (${w.id}) after ${x.checks} checks: ${x.note}`, uid('wa_'));
    }
  }
}

/** The tick looked at the due watches: each one's next check backs off. */
function checkedWatches(now: number) {
  for (const x of openWatches()) if (x.nextAt <= now) watchdogWatches.set({ ...x, checks: x.checks + 1, nextAt: nextCheck(now, TRANSIENT_RECHECK_MIN, x.checks + 1) });
}

// ---------------------------------------------------------------- the snapshot

function workerSnap(w: Worker, now: number): WorkerSnap {
  const p = progressOf(messages.sorted(w.id), w.createdAt);
  const chat = chats.get(w.chatId);
  return {
    id: w.id,
    chatId: w.chatId,
    chatTitle: chat?.title || '(deleted chat)',
    bot: bots.get(w.botId)?.name || 'deleted bot',
    title: w.title,
    task: w.task,
    status: w.status,
    detail: w.detail,
    createdAt: w.createdAt,
    lastProgressAt: Math.min(now, Math.max(p.lastAt, w.updatedAt)),
    turns: w.turns,
    costUsd: w.costUsd,
    recent: p.recent,
    repeats: p.repeats,
    repeated: p.repeated,
    report: w.report && { status: w.report.status, text: w.report.text, at: w.report.at },
    transient: w.status === 'error' && isTransient(w.detail || w.report?.text),
    nudgesToday: countToday(['nudge', 'stop'], w.id),
    restartsToday: countToday('restart', w.id),
  };
}

/** `since`: the window's start; by default the last tick that looked (the tick being run is already recorded, so it passes its own). */
export function gatherSnapshot(now = Date.now(), actionsLeft = settings.get().superAgent.watchdog.maxActionsPerTick, since = lastLook(now)): Snapshot {
  const ws = workers
    .all()
    // Speculative runs (ADR 008) have their own time limit and never need the user: not the Watchdog's to steer.
    .filter((w) => !w.dismissedAt && !w.speculation && (ACTIVE.has(w.status) || w.updatedAt >= since || openWatches().some((x) => x.subject === w.id)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_WORKERS);
  const title = (chatId?: string) => (chatId ? chats.get(chatId)?.title : undefined);
  const friction = readFriction(since);
  const grouped = new Map<string, { count: number; keys: Map<string, number> }>();
  for (const f of friction) {
    if (f.kind === 'turn-error') continue;
    const g = grouped.get(f.kind) ?? { count: 0, keys: new Map() };
    g.count++;
    g.keys.set(f.key, (g.keys.get(f.key) || 0) + 1);
    grouped.set(f.kind, g);
  }
  return {
    at: now,
    since,
    stuckMinutes: settings.get().superAgent.watchdog.stuckMinutes,
    actionsLeft,
    workers: ws.map((w) => workerSnap(w, now)),
    approvals: openApprovals()
      .slice(0, MAX_LIST)
      .map((a) => ({
        id: a.id,
        chatId: a.chatId,
        chatTitle: title(a.chatId) || '',
        who: bots.get(a.botId)?.name || 'a bot',
        title: a.title,
        askedAt: a.askedAt,
        workerId: a.logId.startsWith('wk_') ? a.logId : undefined,
      })),
    turnErrors: friction
      .filter((f) => f.kind === 'turn-error')
      .slice(-MAX_LIST)
      .map((f) => ({ at: f.at, chatId: f.chatId, chatTitle: f.chatTitle, who: f.botName, text: f.detail || f.key })),
    friction: [...grouped.entries()].map(([kind, g]) => ({
      kind,
      label: FRICTION_LABEL[kind as keyof typeof FRICTION_LABEL] || kind,
      count: g.count,
      keys: [...g.keys.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, n]) => (n > 1 ? `${k} (${n}x)` : k)),
    })),
    interfaceErrors: [
      ...routerInfos()
        .filter((r) => r.state === 'error')
        .map((r) => ({ kind: 'router' as const, id: r.chatId, at: r.since, chatId: r.chatId, chatTitle: title(r.chatId), text: `The Router hit an error: ${r.detail || 'unknown'}` })),
      ...triggerLog
        .recent(MAX_LIST, (t) => t.source === 'preview-console' && t.at >= since && t.filter.verdict !== 'drop')
        .map((t) => ({ kind: 'console' as const, id: t.id, at: t.at, chatId: t.chatId ?? undefined, chatTitle: title(t.chatId ?? undefined), text: t.summary })),
    ],
    watches: openWatches().map((w) => ({ id: w.id, subject: w.subject, note: w.note, checks: w.checks, nextAt: w.nextAt, by: w.by })),
    // The lifecycle audit log (ADR 007): the guard's refusals and failed draft runs since the last look.
    audit: auditSnaps(
      auditLog.recent(200, (e) => e.at >= since && (e.event === 'blocked' || e.event === 'failed')),
      (chatId) => title(chatId),
    ),
  };
}

// ---------------------------------------------------------------- effects of the tools

function tellChat(chatId: string, text: string, actionId: string) {
  const chat = chats.get(chatId);
  if (!chat) return;
  if (routerMode(chat)) routerEvent(chat.id, { kind: 'environment', id: actionId, at: Date.now(), source: 'watchdog', summary: text, reason: "Crew's Watchdog flagged this" });
  else systemMessage(chat, `Watchdog: ${text}`, { uiOnly: true, notice: 'watchdog' });
  notify('Watchdog', text.slice(0, 140), { chatId: chat.id, level: 'warn' });
}

let currentTick = '';

const effects = {
  nudge: (w: Worker, note: string) => void messageWorker(w, note),
  stop: (w: Worker, why: string) => stopWorker(w.id, { why: `The Watchdog stopped it: ${why}` }),
  restart: (w: Worker, recap: string) => restartWorker(w, recap),
  notify: tellChat,
  record(a: { kind: WatchdogActionKind; target: string; chatId?: string; text: string; refused?: string }) {
    const rec: WatchdogAction = { id: uid('wa_'), at: Date.now(), tickId: currentTick, ...a, text: a.text.slice(0, 600) };
    watchdogActions.append(rec);
    if (!a.refused) log.info(`${a.kind} ${a.target}: ${rec.text}`);
    emitInfo();
    return rec.id;
  },
  countToday,
  watch: (subject: string, note: string, minutes: number) => openWatch(subject, note, minutes, 'watchdog'),
  resolveWatch,
  propose(p: Omit<WatchdogProposal, 'id' | 'at' | 'status'>) {
    const rec: WatchdogProposal = { id: uid('wp_'), at: Date.now(), status: 'pending', ...p };
    watchdogProposals.set(rec);
    notify('The Watchdog proposes a change', p.target === 'bot' ? `${p.botName}'s role description` : 'Trigger policies', { level: 'info' });
    emitInfo();
    return rec.id;
  },
};

// ---------------------------------------------------------------- the session

/** Who the Watchdog is in the audit log, when the guard refuses one of its calls. */
const WATCHDOG_ACTOR = { botName: 'Watchdog' };

/**
 * The Watchdog's session, like the Router's: no built-in tools, its own system prompt, no settings
 * files, only its crew_watchdog tools. It also gets the deny hook every agent session has (blocked
 * actions, then the command guard, ADR 007), so the same hard rules hold for it as for chat bots,
 * Workers and background jobs, whatever tool it might ever be offered.
 */
export function watchdogSessionConfig(tools: ReturnType<typeof watchdogTools>): SessionConfig {
  const wd = settings.get().superAgent.watchdog;
  return {
    cwd: DATA.watchdog,
    // With the model gateway on (ADR 009) its calls go out under the watchdog scope: its route, windows and usage log.
    model: botModel(wd.model, WATCHDOG_SCOPE),
    systemAppend: '',
    systemPrompt: watchdogSystemPrompt({ maxActions: wd.maxActionsPerTick, stuckMinutes: wd.stuckMinutes }),
    // No Bash, Read, Edit, Write, WebFetch or Task: it watches and steers, never works.
    tools: [],
    permissionMode: 'default',
    allowRules: ['mcp__crew_watchdog'],
    askRules: [],
    denyRules: settings.get().denyRules || [],
    deniedReason: (toolName, input) => deniedReason(toolName, input, DATA.watchdog, { actor: WATCHDOG_ACTOR }),
    mcpServers: { crew_watchdog: watchdogMcpServer(tools) as McpServerConfig },
    settingSources: [],
    env: agentEnv(WATCHDOG_SCOPE, wd.model || settings.get().defaultModel || undefined),
    role: 'watchdog',
    fakeTools: tools,
  };
}

class WatchdogLoop {
  readonly queue: BatchQueue<Job>;
  session: AgentSession | null = null;
  stream: TurnStream | null = null;
  current: WatchdogTurn | null = null;
  state: 'idle' | 'thinking' | 'error' = 'idle';
  detail?: string;
  cron: Cron | null = null;
  private cronExpr = '';
  /** The settings the session was made with. */
  private applied = '';
  /** Why the next turn starts a new session (with a recap of recent actions), if it does. */
  private recapWhy: string | undefined = 'Crew started, or the Watchdog was switched on';
  /** Its model route changed during a turn: the session closes once that turn ends. */
  private staleSession = false;
  private readonly tools = watchdogTools(() => this.current, effects);

  constructor() {
    this.queue = new BatchQueue(
      async (batch) => {
        for (const job of batch) await this.turn(job);
      },
      () => emitInfo(),
    );
  }

  private getSession(): AgentSession {
    if (this.session && !this.session.closed) return this.session;
    fs.mkdirSync(DATA.watchdog, { recursive: true });
    const cfg = watchdogSessionConfig(this.tools);
    this.session = FAKE_AGENT ? new FakeSession(cfg, 'Watchdog', [], () => {}) : new BotSession(cfg, () => {});
    return this.session;
  }

  private recap(): string | undefined {
    const why = this.recapWhy;
    this.recapWhy = undefined;
    if (!why) return undefined;
    const lines = watchdogActions
      .recent(12, (a) => !a.refused)
      .reverse()
      .map((a) => `- ${new Date(a.at).toLocaleString('en-US')}: ${a.kind} ${a.target}: ${a.text}`);
    return watchdogRecap({ why, lines });
  }

  private async turn(job: Job) {
    const wd = settings.get().superAgent.watchdog;
    if (!watchdogOn()) {
      recordTick({ ...job.tick, outcome: 'skipped', reason: 'off: switched off before the turn started' });
      return;
    }
    currentTick = job.tick.id;
    this.current = { tickId: job.tick.id, maintainer: job.kind === 'maintainer', used: 0 };
    this.setState('thinking');
    const { msg, session } = await runLogged({
      logId: WATCHDOG_LOG,
      botId: WATCHDOG_ID,
      cwd: DATA.watchdog,
      trigger: { type: job.kind === 'maintainer' ? 'user' : 'system' },
      batch: [job.tick.id],
      session: () => this.getSession(),
      forgetResume: () => false,
      content: () => {
        const recap = this.recap();
        const snap = renderSnapshot(gatherSnapshot(Date.now(), wd.maxActionsPerTick, job.kind === 'maintainer' ? undefined : job.since), {
          reason: job.kind === 'maintainer' ? 'a maintainer asked' : job.reason,
        });
        if (job.kind !== 'maintainer') checkedWatches(Date.now());
        return job.kind === 'maintainer' ? maintainerPrompt(job.text, snap, recap) : tickPrompt(snap, recap);
      },
      hooks: () => ({
        beforeEdit: () => {},
        canUseTool: async (name, input) =>
          name.startsWith('mcp__crew_watchdog__')
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: 'The Watchdog has no tools of its own; it acts only through its crew_watchdog tools.' },
      }),
      onActivity: (state, detail) => this.setState('thinking', state === 'tool' ? detail?.replace(/^mcp__crew_watchdog__/, '') : undefined),
      started: (stream, s) => {
        this.stream = stream;
        this.session = s;
      },
    });
    const used = this.current?.used ?? 0;
    this.current = null;
    this.stream = null;
    currentTick = '';
    if (!session) {
      this.session = null;
      this.recapWhy = 'the previous session failed';
    } else if (this.staleSession) {
      this.staleSession = false;
      this.recapWhy = 'its model route changed';
      this.close();
    } else void this.measure(session);
    recordTick({ ...job.tick, outcome: msg.status === 'error' ? 'error' : 'ran', actions: used, costUsd: msg.meta?.costUsd || 0, messageId: msg.id });
    if (msg.status === 'error') this.setState('error', (msg.error || 'Unknown error').split('\n')[0].slice(0, 160));
    else this.setState('idle');
  }

  /** Every call re-reads the whole session: past rotateAtTokens, the next turn starts over with a recap. */
  private async measure(session: AgentSession) {
    const usage = await session.contextUsage?.().catch(() => null);
    const limit = settings.get().rotateAtTokens;
    if (usage && limit > 0 && usage.used >= limit) {
      session.close();
      if (this.session === session) this.session = null;
      this.recapWhy = `the previous one had grown to ${Math.round(usage.used / 1000)}k tokens of context`;
    }
  }

  setState(state: WatchdogLoop['state'], detail?: string) {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    emitInfo();
  }

  /** Starts, reschedules or stops the timer to match the settings. */
  sync() {
    if (!watchdogOn()) {
      this.cron?.stop();
      this.cron = null;
      this.cronExpr = '';
      this.applied = '';
      if (!this.queue.busy) this.close();
      emitInfo();
      return;
    }
    const wd = settings.get().superAgent.watchdog;
    const expr = cronExpr(wd.everyMinutes);
    if (!this.cron || expr !== this.cronExpr) {
      this.cron?.stop();
      this.cronExpr = expr;
      this.cron = new Cron(expr, { protect: true, unref: true, name: 'watchdog' }, () => {
        void tick('tick').catch((e) => log.warn('tick failed:', e));
      });
    }
    // The system prompt carries the model and the limits: a new session picks up changed settings.
    const applied = JSON.stringify(wd);
    if (applied !== this.applied && !this.queue.busy) {
      if (this.applied) this.close();
      this.applied = applied;
    }
    emitInfo();
  }

  close() {
    this.session?.close();
    this.session = null;
    this.recapWhy ??= 'the Watchdog was switched off and on, or its settings changed';
  }

  /** The model gateway's routes changed: a new session at the next turn, never in the middle of one. */
  invalidate() {
    if (this.queue.busy) this.staleSession = true;
    else if (this.session) {
      this.recapWhy ??= 'its model route changed';
      this.close();
    }
  }

  info(): WatchdogInfo {
    const on = watchdogOn();
    const now = Date.now();
    return {
      enabled: on,
      state: !on ? 'off' : this.state,
      detail: this.detail,
      nextTickAt: on ? this.cron?.nextRun()?.getTime() : undefined,
      ticksLastHour: ticksLastHour(now),
      actionsToday: actionsToday(now).filter((a) => !a.refused).length,
      spentTodayUsd: spentToday(now),
      lastTick: watchdogTicks.recent(1)[0],
      pendingProposals: watchdogProposals.all().filter((p) => p.status === 'pending').length,
      openWatches: openWatches().length,
    };
  }
}

const loop = new WatchdogLoop();
// Its actions, ticks and watches are ids a chat's agents can recall (ADR 005 × 006).
registerWatchdogRecall(() => loop.info());

let emitTimer: NodeJS.Timeout | null = null;
/** State changes come in bursts (an action, its ledger line, a watch): one event per burst. */
function emitInfo() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    bus.emit({ t: 'watchdog', watchdog: loop.info() });
  }, 50);
}

// ---------------------------------------------------------------- ticks and messages

/**
 * One tick. The fast path in code decides whether the model is called at all: not while off, busy,
 * over the hourly or daily limits, and (for timer ticks) not when nothing is flagged.
 */
export async function tick(kind: 'tick' | 'manual'): Promise<WatchdogTick> {
  const now = Date.now();
  const wd = settings.get().superAgent.watchdog;
  const rec: WatchdogTick = { id: uid('wt_'), at: now, kind, outcome: 'skipped', reason: '', flags: [], actions: 0, costUsd: 0 };
  if (!watchdogOn()) {
    // Not recorded: with the feature off nothing is written.
    return { ...rec, reason: 'off' };
  }
  housekeepWatches(now);
  const snap = gatherSnapshot(now, wd.maxActionsPerTick);
  rec.flags = snapshotFlags(snap);
  const refused = tickRefusal({
    busy: loop.queue.busy || loop.queue.waiting > 0,
    ticksLastHour: ticksLastHour(now),
    maxTicksPerHour: wd.maxTicksPerHour,
    spentToday: spentToday(now),
    dailyBudgetUsd: wd.dailyBudgetUsd,
  });
  if (refused) rec.reason = refused;
  else if (kind === 'tick' && isQuiet(snap)) rec.reason = 'quiet: nothing to watch';
  else if (kind === 'tick' && !rec.flags.length) rec.reason = 'healthy: nothing flagged';
  else {
    rec.outcome = 'ran';
    rec.reason = rec.flags.length ? `flagged: ${rec.flags.slice(0, 8).join(', ')}${rec.flags.length > 8 ? ', …' : ''}` : 'a maintainer asked for a tick';
  }
  recordTick(rec);
  if (rec.outcome === 'ran') loop.queue.push({ kind, tick: rec, reason: rec.reason, since: snap.since });
  return rec;
}

/** A maintainer writes to the Watchdog: stored in its log, answered in its next turn. */
export function askWatchdog(text: string): ChatMessage {
  if (!watchdogOn()) throw new HttpError(409, 'The Watchdog is off. Turn it on in Settings → Super-agent.');
  const wd = settings.get().superAgent.watchdog;
  const spent = spentToday();
  if (spent >= wd.dailyBudgetUsd) throw new HttpError(409, `The Watchdog has used today's budget ($${spent.toFixed(3)} of $${wd.dailyBudgetUsd.toFixed(2)}). Raise it in Settings, or ask tomorrow.`);
  const msg: ChatMessage = { id: uid('m_'), chatId: WATCHDOG_LOG, seq: nextSeq(WATCHDOG_LOG), ts: Date.now(), role: 'user', text: text.trim() };
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  const rec: WatchdogTick = { id: uid('wt_'), at: msg.ts, kind: 'maintainer', outcome: 'ran', reason: 'a maintainer wrote', flags: [], actions: 0, costUsd: 0 };
  recordTick(rec);
  loop.queue.push({ kind: 'maintainer', tick: rec, messageId: msg.id, text: msg.text });
  return msg;
}

// ---------------------------------------------------------------- proposals

function proposal(id: string): WatchdogProposal {
  const p = watchdogProposals.get(id);
  if (!p) throw new HttpError(404, 'Proposal not found');
  if (p.status !== 'pending') throw new HttpError(409, 'This proposal has already been decided');
  return p;
}

function decide(p: WatchdogProposal, status: WatchdogProposal['status']) {
  const next = { ...p, status, decidedAt: Date.now() };
  watchdogProposals.set(next);
  emitInfo();
  return next;
}

/** Applies a proposal, unless what it would replace was changed since: then it is void. */
export function acceptProposal(id: string): WatchdogProposal {
  const p = proposal(id);
  if (p.target === 'policies') {
    const cur = settings.get().superAgent;
    if (cur.policies !== p.before) {
      decide(p, 'stale');
      throw new HttpError(409, 'The policies were changed after this proposal, so it is void.');
    }
    settings.update({ superAgent: normalizeSuperAgent({ ...cur, policies: p.after }) });
    bus.emit({ t: 'settings', settings: settings.public() });
  } else {
    const bot = bots.get(p.botId);
    if (!bot) {
      decide(p, 'stale');
      throw new HttpError(404, 'That bot no longer exists');
    }
    if ((bot.description ?? '') !== p.before) {
      decide(p, 'stale');
      throw new HttpError(409, `${bot.name}'s role description was changed after this proposal, so it is void.`);
    }
    updateBot(bot.id, { description: p.after });
  }
  return decide(p, 'accepted');
}

export function rejectProposal(id: string): WatchdogProposal {
  return decide(proposal(id), 'rejected');
}

export function dismissWatch(id: string): WatchdogWatch {
  const w = watchdogWatches.get(id);
  if (!w) throw new HttpError(404, 'Watch not found');
  resolveWatch(id, 'Resolved by a maintainer');
  return watchdogWatches.get(id)!;
}

// ---------------------------------------------------------------- reading, lifecycle

export function watchdogInfo(): WatchdogInfo {
  return loop.info();
}

export function watchdogOverview(): WatchdogOverview {
  return {
    ...loop.info(),
    settings: settings.get().superAgent.watchdog,
    ticks: watchdogTicks.recent(50),
    actions: watchdogActions.recent(50),
    watches: [...openWatches(), ...watchdogWatches.all().filter((w) => w.resolvedAt)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    proposals: watchdogProposals
      .all()
      .sort((a, b) => b.at - a.at)
      .slice(0, 30),
  };
}

/** Settings changed: the timer follows them. */
export function syncWatchdog() {
  loop.sync();
}

/** The model gateway was switched or rerouted: the session is made again with its new address and target. */
export function invalidateWatchdog() {
  loop.invalidate();
}

export function startWatchdog() {
  watchdogTicks.prune();
  watchdogActions.prune();
  loop.sync();
  setInterval(() => {
    watchdogTicks.prune();
    watchdogActions.prune();
  }, HOUR).unref();
}

export function closeWatchdog() {
  loop.cron?.stop();
  loop.close();
}
