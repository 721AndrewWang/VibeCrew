// One run of the ablation bench (ADR 101): a workload through one configuration, on the virtual
// clock. The routing decisions are Crew's own pure rules (the fast path, subscriptions, gates, the
// Router's batch queue and prompts); the scheduling around them (one turn at a time, delivery
// between steps, landing and reporting when a Worker's turn ends) follows RouterSession,
// layers/workers.ts and the orchestrator, without the store, git or Claude Code.

import type { SuperAgentSettings, Thread, Trigger, Worker, WorkerDelivery } from '../../shared/types';
import { MAX_RUNNING, startRefusal } from '../jobs/gates';
import { BatchQueue } from '../layers/batch';
import { dispatchRefusal, messageRefusal, replyRefusal } from '../layers/gates';
import { type DirectLine, deliveredNote, explicitEvent, type RouterEvent, recapText, renderBatch, routerSystemPrompt, type WorkerLine, workerPrompt } from '../layers/prompts';
import { ACTIVE, pushInbox, receivers } from '../layers/subscriptions';
import { type FastInput, fastPath, fingerprintOf, normalizeSuperAgent, reachedSlowPath } from '../triggers/fastPath';
import { BENCH_EPOCH, VirtualClock } from './clock';
import { DEFAULT_LATENCY, type LatencyModel, type ModelClient, type Role } from './model';
import { TOOLS } from './policies';
import { CHAT_TITLE, ciLine, filler, filterPrompt, filterSystem, jobLine, LEAD, type LeadLine, leadSystem, leadTurnPrompt, newInputText, subtaskSystem, workerSystem } from './prompts';
import { emptyStats, type RoleStats, SimSession, type ToolHandler } from './session';
import type { Workload, WorkloadEvent } from './workload';

export type ConfigId = 'super-agent' | 'no-direct' | 'single-neutral' | 'single-delegate';

export const CONFIGS: { id: ConfigId; label: string; description: string }[] = [
  { id: 'super-agent', label: '(a) Super-agent', description: 'Router + Workers + thread subscriptions (direct routing)' },
  { id: 'no-direct', label: '(b) No direct routing', description: 'Router + Workers, every event through the Router' },
  { id: 'single-neutral', label: '(c) Single session, neutral', description: 'The classic lead bot does every task itself' },
  { id: 'single-delegate', label: '(d) Single session, delegate-first', description: 'The classic lead bot, full duplex, delegates to background sub-tasks' },
];

export interface SimOptions {
  config: ConfigId;
  workload: Workload;
  client: ModelClient;
  latency?: LatencyModel;
  /** One step of work, in minutes before time scaling. */
  stepMin?: number;
  /** Size of a work step's output, in tokens. */
  workResultTokens?: number;
  rotateAtTokens?: number;
  /** Workers per chat for (a)/(b); (d) has Crew's job limit. */
  maxWorkers?: number;
  /** A Worker's workspace, or a sub-task's session, takes this long to start (virtual ms). */
  startupMs?: number;
  maxHops?: number;
  /**
   * Tokens each session carries beside its system prompt: Claude Code's own prompt and tool schemas
   * for sessions that run on it (Workers, the lead, sub-tasks), the MCP tool schemas for the Router
   * (which replaces Claude Code's prompt and has no built-in tools).
   */
  harnessTokens?: { claudeCode: number; router: number };
}

export const SIM_DEFAULTS = {
  stepMin: 2,
  workResultTokens: 300,
  rotateAtTokens: 60_000,
  maxWorkers: MAX_RUNNING,
  startupMs: 3000,
  maxHops: 8,
  harnessTokens: { claudeCode: 8000, router: 600 },
};

export interface RequestOutcome {
  task: string;
  /** Milliseconds from the start of the run. */
  requestAt: number;
  followUps: number;
  /** Work asked for, request and follow-ups, in milliseconds. */
  work: number;
  /** When the user was last told all its work was finished. */
  completedAt?: number;
  completionMs?: number;
  stopped: boolean;
  /** Work went on this long after the stop request (0: it stopped at once or never started). */
  stopLatencyMs?: number;
  /** It was finished before the stop request arrived. */
  tooLate?: boolean;
  /** Work done on it after the stop request. */
  wastedMs: number;
}

export interface TurnRecord {
  /** Milliseconds from the start of the run. */
  at: number;
  size: number;
  explicit: boolean;
  /** Events bound for this session per minute, in the window before the turn. */
  ratePerMin: number;
}

export interface RunResult {
  config: ConfigId;
  label: string;
  requests: RequestOutcome[];
  /** User message to the first user-facing output after the session saw it. */
  ackMs: number[];
  coordinator: {
    role: 'router' | 'lead';
    turns: number;
    /** Events the coordinator took in its turns (Crew's Chat.router.decided). */
    decided: number;
    calls: number;
    /** Events that went straight to Workers (Crew's Chat.router.direct). */
    direct: number;
    /** Events bound for the coordinator, in all. */
    arrivals: number;
    rotations: number;
  };
  turns: TurnRecord[];
  tokens: Record<Role, RoleStats>;
  /** Fast-path and slow-path outcomes of the environment Triggers, by rule. */
  triggers: Record<string, number>;
  refusals: Record<string, number>;
  /** Workers dispatched, or sub-tasks started. */
  executors: number;
  /** When the last thing happened, in milliseconds from the start. */
  endMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const MSG = /\bmsg_(\d+)\b|· #(\d+)\]/g;

interface Unit {
  id: string;
  task: string;
  work: number;
  performed: number;
}

interface TaskState {
  id: string;
  requestAt: number;
  units: Unit[];
  followUps: number;
  stopAt?: number;
  finishedAt?: number;
  informedAt?: number;
  completedFor?: number;
  completedAt?: number;
  lastPerformedAt?: number;
  performedAfterStop: number;
}

interface SimTrigger extends Trigger {
  fast: FastInput;
  text: string;
}

interface WorkerSim {
  rec: Worker;
  task: string;
  knows: Set<string>;
  session: SimSession | null;
  running: boolean;
  stop: boolean;
  userWords: { seq: number; text: string }[];
  first: boolean;
  lastReport?: string;
}

interface Job {
  id: string;
  task: string;
  brief: string;
  knows: Set<string>;
  session: SimSession | null;
  running: boolean;
  stop: boolean;
}

interface LeadIn {
  line: LeadLine;
  /** A user message the lead has to acknowledge. */
  userId?: string;
  /** A task whose job result this is. */
  informs?: string;
}

interface ChatLine {
  id: string;
  seq: number;
  who: 'User' | 'You';
  text: string;
}

class Run {
  readonly clock = new VirtualClock();
  readonly stats = emptyStats();
  private readonly o: SimOptions & typeof SIM_DEFAULTS & { latency: LatencyModel };
  private readonly twoLayer: boolean;
  private readonly direct: boolean;
  private readonly stepMs: number;
  private readonly t0 = BENCH_EPOCH;
  private readonly settings: SuperAgentSettings;
  private readonly thread: Thread;

  private units = new Map<string, Unit>();
  private tasks = new Map<string, TaskState>();
  private chat: ChatLine[] = [];
  private replySeq = 10_000;
  private awaiting = new Map<string, number>();
  private seenUnacked = new Set<string>();
  private ackMs: number[] = [];
  private triggers: SimTrigger[] = [];
  private ruleCounts: Record<string, number> = {};
  private refusals: Record<string, number> = {};
  private unread = new Map<string, Set<string>>();
  private idSeq = { tg: 0, wk: 0, job: 0 };

  // The coordinator.
  private arrivals: number[] = [];
  private turnRecords: TurnRecord[] = [];
  private decided = 0;
  private directCount = 0;
  private rotations = 0;
  private coordSession: SimSession | null = null;
  private rotate = false;

  // Router and Workers.
  private routerQueue?: BatchQueue<RouterEvent>;
  private workers: WorkerSim[] = [];
  private observed: DirectLine[] = [];
  private currentExplicit = false;
  private sinceUser = 0;

  // The classic lead and its sub-tasks.
  private leadQueue?: BatchQueue<LeadIn>;
  private leadRunning = false;
  private midTurn: LeadIn[] = [];
  private leadKnows = new Set<string>();
  private jobs: Job[] = [];

  // The slow path.
  private filterPending: SimTrigger[] = [];
  private filterBusy = false;

  constructor(opts: SimOptions) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as SimOptions;
    this.o = { ...SIM_DEFAULTS, latency: DEFAULT_LATENCY, ...given };
    this.twoLayer = opts.config === 'super-agent' || opts.config === 'no-direct';
    this.direct = opts.config === 'super-agent';
    this.stepMs = Math.max(1000, Math.round(this.o.stepMin * MIN * opts.workload.options.timeScale));
    this.settings = normalizeSuperAgent({ enabled: true, router: { enabled: this.twoLayer, subscriptions: this.direct, maxWorkers: this.o.maxWorkers } });
    this.thread = { id: 'th_ws', key: 'workspace:proj', kind: 'workspace', title: `Workspace: ${CHAT_TITLE}`, projectId: 'proj', chatId: null, createdAt: this.t0, lastAt: this.t0, count: 0 };
    if (this.twoLayer)
      this.routerQueue = new BatchQueue(async (batch) => {
        // As RouterSession does: environment events never share a turn with explicit ones.
        const explicit = batch.filter(explicitEvent);
        const environment = batch.filter((e) => !explicitEvent(e));
        if (explicit.length) await this.routerTurn(explicit);
        if (environment.length) await this.routerTurn(environment);
      });
    else this.leadQueue = new BatchQueue((batch) => this.leadTurn(batch));
  }

  private get env() {
    return { clock: this.clock, client: this.o.client, latency: this.o.latency, stats: this.stats };
  }

  private get now() {
    return this.clock.now;
  }

  async run(): Promise<RunResult> {
    for (const ev of this.o.workload.events) this.clock.at(this.t0 + ev.at, () => this.arrive(ev));
    await this.clock.run();
    return this.result();
  }

  // ---------------------------------------------------------------- work, acknowledgements, completion

  private arrive(ev: WorkloadEvent) {
    if (ev.task && !this.tasks.has(ev.task)) this.tasks.set(ev.task, { id: ev.task, requestAt: this.now, units: [], followUps: 0, performedAfterStop: 0 });
    const task = ev.task ? this.tasks.get(ev.task) : undefined;
    if (task && ev.work !== undefined) {
      const u: Unit = { id: ev.id, task: task.id, work: ev.work, performed: 0 };
      this.units.set(ev.id, u);
      task.units.push(u);
      task.finishedAt = undefined;
      if (ev.kind === 'follow-up') task.followUps++;
    }
    if (task && ev.kind === 'stop') task.stopAt ??= this.now;
    if (ev.kind === 'ci') return this.publishCi(ev);
    this.chat.push({ id: ev.id, seq: ev.seq, who: 'User', text: ev.text });
    this.awaiting.set(ev.id, this.now);
    if (this.twoLayer) this.toRouter({ kind: 'user', id: ev.id, at: this.now, seq: ev.seq, text: ev.text });
    else this.toLead({ line: { who: 'User', seq: ev.seq, text: ev.text }, userId: ev.id });
  }

  private learn(knows: Set<string>, text: string) {
    for (const m of text.matchAll(MSG)) {
      const id = `msg_${m[1] ?? m[2]}`;
      if (this.units.has(id)) knows.add(id);
    }
  }

  private perform(u: Unit, ms: number) {
    if (ms <= 0) return;
    u.performed += ms;
    const t = this.tasks.get(u.task)!;
    t.lastPerformedAt = this.now;
    if (t.stopAt !== undefined && this.now > t.stopAt) t.performedAfterStop += Math.min(ms, this.now - t.stopAt);
    if (t.finishedAt === undefined && t.units.every((x) => x.performed >= x.work)) t.finishedAt = this.now;
  }

  /** The work tool: one step of the task's open work this agent knows of, or "complete". */
  private workTool(knows: Set<string>, session: () => SimSession | null, onComplete?: (task: string) => void): ToolHandler {
    return async (input) => {
      const task = String(input.task || '');
      const open = () => [...knows].map((id) => this.units.get(id)!).filter((u) => u.task === task && u.performed < u.work);
      const first = open()[0];
      if (!first) {
        onComplete?.(task);
        return `${task} is complete: nothing is left to do on it.`;
      }
      const s = session();
      const start = this.now;
      await Promise.race([this.clock.sleep(Math.min(this.stepMs, first.work - first.performed)), s ? s.stopSignal() : Promise.resolve()]);
      this.perform(first, this.now - start);
      if (s?.isStopped) return 'Interrupted.';
      const left = open().reduce((sum, u) => sum + u.work - u.performed, 0);
      if (left > 0) return `Worked ${((this.now - start) / MIN).toFixed(1)} min on ${task}; about ${Math.ceil(left / MIN)} min of work left.\n${filler(this.o.workResultTokens)}`;
      onComplete?.(task);
      return `${task} is complete.\n${filler(this.o.workResultTokens)}`;
    };
  }

  private seen(ids: (string | undefined)[]) {
    for (const id of ids) if (id && this.awaiting.has(id)) this.seenUnacked.add(id);
  }

  private informed(task: string | undefined) {
    const t = task ? this.tasks.get(task) : undefined;
    if (t) t.informedAt = this.now;
  }

  /** The user-facing session said something: what it had seen is acknowledged, what it knew finished is complete. */
  private userFacing() {
    for (const id of this.seenUnacked) {
      this.ackMs.push(this.now - this.awaiting.get(id)!);
      this.awaiting.delete(id);
    }
    this.seenUnacked.clear();
    for (const t of this.tasks.values()) {
      if (t.stopAt !== undefined || t.finishedAt === undefined || t.informedAt === undefined) continue;
      if (t.informedAt >= t.finishedAt && t.completedFor !== t.finishedAt) {
        t.completedFor = t.finishedAt;
        t.completedAt = this.now;
      }
    }
  }

  private recap(why: string, exclude: Set<string>): string | undefined {
    const lines = this.chat
      .filter((l) => !exclude.has(l.id))
      .slice(-12)
      .map((l) => ({ who: l.who, seq: l.seq, text: l.text }));
    return lines.length ? recapText({ why, lines }) : undefined;
  }

  private turnRecord(size: number, explicit: boolean) {
    const w = Math.max(MIN, 10 * MIN * this.o.workload.options.timeScale);
    const n = this.arrivals.filter((a) => a > this.now - w && a <= this.now).length;
    this.turnRecords.push({ at: this.now - this.t0, size, explicit, ratePerMin: n / (w / MIN) });
    this.decided += size;
  }

  /** A new coordinator session when there is none, or the last one outgrew rotateAtTokens. */
  private rotation(batchIds: Set<string>): string | undefined {
    if (!this.coordSession || !this.rotate) return undefined;
    const k = Math.round(this.coordSession.tokens / 1000);
    this.coordSession = null;
    this.rotate = false;
    this.rotations++;
    return this.recap(`the previous one had grown to ${k}k tokens of context, re-read on every call`, batchIds);
  }

  // ---------------------------------------------------------------- environment Triggers

  private publishCi(ev: WorkloadEvent) {
    const failures = ev.ci?.failures ?? [];
    this.publish({ source: 'preview-console', summary: ev.text, text: ev.text, subjects: failures.map((f) => `${ev.task}: ${f}`), facts: { errors: failures.length } });
  }

  private publish(input: { source: 'preview-console' | 'landing'; summary: string; text: string; subjects: string[]; facts: FastInput['facts']; origin?: string }) {
    const subs = this.direct ? receivers(this.workerRecs(), { threadId: this.thread.id, explicit: false, origin: input.origin, live: () => true }) : [];
    const fast: FastInput = {
      source: input.source,
      explicit: false,
      rootProjectId: 'proj',
      subjects: input.subjects,
      fingerprint: fingerprintOf(input.source, input.subjects.length ? input.subjects : [input.summary]),
      facts: input.facts,
    };
    const t: SimTrigger = {
      id: `tg_${++this.idSeq.tg}`,
      at: this.now,
      source: input.source,
      threadId: this.thread.id,
      projectId: 'proj',
      chatId: 'chat',
      summary: input.summary,
      ref: { kind: 'payload' },
      related: [],
      explicit: false,
      fingerprint: fast.fingerprint,
      filter: fastPath(fast, { ...this.fastContext(), subscribers: subs.map((w) => w.id) }),
      fast,
      text: input.text,
    };
    this.triggers.push(t);
    this.thread.count++;
    this.thread.lastAt = this.now;
    this.count(`${input.source === 'landing' ? 'landing' : 'ci'}:${t.filter.rule}`);
    if (t.filter.rule === 'subscribed') this.deliverDirect(t, subs);
    if (t.filter.verdict === 'candidate') this.toFilter(t);
  }

  private fastContext() {
    return {
      settings: this.settings,
      thread: this.thread,
      recent: this.triggers.slice(-50).reverse(),
      candidatesLastHour: this.triggers.filter((t) => t.at >= this.now - HOUR && reachedSlowPath(t)).length,
      now: this.now,
    };
  }

  private count(key: string, n = 1) {
    this.ruleCounts[key] = (this.ruleCounts[key] || 0) + n;
  }

  private deliverDirect(t: SimTrigger, to: Worker[]) {
    const ids = to.map((w) => w.id);
    t.filter = { ...t.filter, direct: ids };
    this.unread.set(t.id, new Set(ids));
    const d: WorkerDelivery = { triggerId: t.id, threadId: t.threadId, at: t.at, source: t.source, explicit: false, summary: t.summary, text: t.text };
    for (const rec of to) {
      const before = rec.inbox || [];
      rec.inbox = pushInbox(before, d);
      rec.received = (rec.received || 0) + 1;
      for (const x of before) if (!rec.inbox.includes(x)) this.unreadBy(rec.id, x.triggerId, true);
    }
    this.directCount++;
    this.observed.push({ id: t.id, source: t.source === 'landing' ? "Workers' merges" : 'CI results', thread: this.thread.title, workers: ids });
  }

  /** A Worker will not read this one: once nobody holds it, it goes back to the filter (or is let go). */
  private unreadBy(workerId: string, triggerId: string, drop: boolean) {
    const waiting = this.unread.get(triggerId);
    if (!waiting) return;
    waiting.delete(workerId);
    if (waiting.size) return;
    this.unread.delete(triggerId);
    const t = this.triggers.find((x) => x.id === triggerId);
    if (!t || drop) return;
    this.directCount--;
    t.filter = { ...fastPath(t.fast, this.fastContext()), direct: t.filter.direct };
    this.count(`rerouted:${t.filter.rule}`);
    if (t.filter.verdict === 'candidate') this.toFilter(t);
  }

  // ---------------------------------------------------------------- the slow path

  private toFilter(t: SimTrigger) {
    this.filterPending.push(t);
    if (!this.filterBusy) void this.drainFilter();
  }

  private async drainFilter() {
    this.filterBusy = true;
    try {
      while (this.filterPending.length) await this.filterCall(this.filterPending.splice(0, 8));
    } finally {
      this.filterBusy = false;
    }
  }

  private async filterCall(batch: SimTrigger[]) {
    const s = new SimSession(this.env, { role: 'filter', model: 'bench-light', system: filterSystem(), handlers: {} });
    const res = await s.turn(filterPrompt(batch.map((t) => ({ id: t.id, summary: t.summary, at: `${Math.round((this.now - t.at) / 1000)}s ago` }))));
    let decisions: { id: string; act: boolean; reason: string }[] = [];
    try {
      decisions = JSON.parse(res.text).decisions || [];
    } catch {
      // An unusable answer means "stay quiet", as in the slow path.
    }
    for (const t of batch) {
      const d = decisions.find((x) => x.id === t.id);
      t.filter = { ...t.filter, verdict: d?.act ? 'act' : 'drop', stage: 'slow', rule: 'policy', reason: d?.reason || 'No usable answer' };
      this.count(`filter:${d?.act ? 'act' : 'quiet'}`);
      if (!d?.act) continue;
      this.thread.lastNoticeAt = this.now;
      if (this.twoLayer) this.toRouter({ kind: 'environment', id: t.id, at: t.at, source: 'ci', summary: t.summary, reason: d.reason });
      else this.toLead({ line: ciLine(t.id, t.summary) });
    }
  }

  // ---------------------------------------------------------------- Router

  private toRouter(ev: RouterEvent) {
    this.arrivals.push(this.now);
    this.routerQueue!.push(ev);
  }

  private routerSession(): SimSession {
    if (this.coordSession) return this.coordSession;
    const system = routerSystemPrompt({
      lead: LEAD,
      leadTitle: 'Tech lead',
      chat: CHAT_TITLE,
      role: 'Lead the team: understand what the user wants, plan it, have it built, and keep the user posted.',
      team: [{ name: `${LEAD} (you)`, title: 'Tech lead', profile: '' }],
      maxWorkers: this.o.maxWorkers,
      subscriptions: this.direct,
      recall: false,
    });
    const find = (id: unknown) => this.workers.find((w) => w.rec.id === String(id));
    const handlers: Record<string, ToolHandler> = {
      [TOOLS.dispatch]: (input) => {
        const refusal = dispatchRefusal({
          explicit: this.currentExplicit,
          asked: input.bot ? String(input.bot) : undefined,
          member: { name: LEAD },
          spent: 0,
          active: this.workers.filter((w) => ACTIVE.has(w.rec.status)).length,
          max: this.o.maxWorkers,
          sharedBusy: null,
          sinceUser: this.sinceUser,
          maxHops: this.o.maxHops,
        });
        if (refusal) {
          this.refusals.dispatch = (this.refusals.dispatch || 0) + 1;
          return { error: refusal };
        }
        this.sinceUser++;
        const w = this.spawnWorker(String(input.title || 'Task'), String(input.task || ''));
        return `Started ${w.rec.id} ("${w.rec.title}"). Its report will arrive as an event; you do not need to wait for it.`;
      },
      [TOOLS.message]: (input) => {
        const w = find(input.id);
        const refusal = messageRefusal({ explicit: this.currentExplicit, found: !!w, dismissed: !!w?.rec.dismissedAt });
        if (refusal || !w) return { error: refusal || 'No such Worker.' };
        const queued = this.messageWorker(w, String(input.text || ''));
        return queued ? `Queued for ${w.rec.id}: it reads it when its current turn ends.` : `Sent to ${w.rec.id}; it is working on it.`;
      },
      [TOOLS.stopWorker]: (input) => {
        const w = find(input.id);
        if (!w || !ACTIVE.has(w.rec.status)) return { error: 'That Worker is not working.' };
        this.stopWorker(w);
        return `Stopped ${w.rec.id}.`;
      },
      [TOOLS.listWorkers]: () =>
        this.workerLines()
          .map((l) => `${l.id} · ${l.status} · ${l.title}`)
          .join('\n') || '(none)',
      [TOOLS.reply]: (input) => {
        const text = String(input.text || '');
        const refusal = replyRefusal(text);
        if (refusal) return { error: refusal };
        this.chat.push({ id: `reply_${this.replySeq}`, seq: ++this.replySeq, who: 'You', text });
        this.userFacing();
        return 'Sent to the chat.';
      },
    };
    this.coordSession = new SimSession(this.env, { role: 'router', model: 'bench-light', system, overheadTokens: this.o.harnessTokens.router, handlers });
    return this.coordSession;
  }

  private async routerTurn(batch: RouterEvent[]) {
    const recap = this.rotation(new Set(batch.map((e) => e.id)));
    const session = this.routerSession();
    this.currentExplicit = batch.some(explicitEvent);
    if (batch.some((e) => e.kind === 'user')) this.sinceUser = 0;
    this.seen(batch.map((e) => (e.kind === 'user' ? e.id : undefined)));
    for (const e of batch) if (e.kind === 'worker' && e.status === 'done') this.informed(this.workers.find((w) => w.rec.id === e.id)?.task);
    this.turnRecord(batch.length, this.currentExplicit);
    const text = renderBatch(batch, this.workerLines(), this.now, recap, this.observed.splice(0));
    await session.turn(text);
    if (session.tokens >= this.o.rotateAtTokens) this.rotate = true;
  }

  private workerRecs(): Worker[] {
    return this.workers.map((w) => w.rec);
  }

  private workerLines(): WorkerLine[] {
    return this.workers
      .filter((w) => !w.rec.dismissedAt)
      .map((w) => ({
        id: w.rec.id,
        bot: LEAD,
        status: w.rec.status,
        title: w.rec.title,
        note: w.lastReport ? w.lastReport.split('\n')[0].slice(0, 120) : w.rec.detail,
        threads: w.rec.threads ? [{ id: this.thread.id, title: this.thread.title }] : undefined,
      }));
  }

  // ---------------------------------------------------------------- Workers

  private spawnWorker(title: string, task: string): WorkerSim {
    const rec: Worker = {
      id: `wk_${++this.idSeq.wk}`,
      chatId: 'chat',
      botId: 'chief',
      title,
      task,
      status: 'starting',
      createdAt: this.now,
      updatedAt: this.now,
      projectId: null,
      turns: 0,
      costUsd: 0,
      related: [],
      ...(this.direct ? { threads: [] } : {}),
      inbox: [],
      detail: 'Creating its own workspace',
    };
    // The user's own words from the dispatching batch, as Crew gives them to a Worker.
    const ids = new Set([...task.matchAll(/\bmsg_\d+\b/g)].map((m) => m[0]));
    const userWords = this.chat.filter((l) => l.who === 'User' && ids.has(l.id)).map((l) => ({ seq: l.seq, text: l.text }));
    const w: WorkerSim = { rec, task: /^(T\d+)/.exec(title)?.[1] || 'T00', knows: new Set(), session: null, running: false, stop: false, userWords, first: true };
    this.workers.push(w);
    this.clock.after(this.o.startupMs, () => {
      if (w.stop) return this.finishWorker(w, 'stopped', 'Stopped before it began');
      // Its workspace is ready: it subscribes to the chat's workspace thread (ADR 003).
      if (rec.threads) rec.threads = [this.thread.id];
      rec.detail = undefined;
      void this.workerLoop(w);
    });
    return w;
  }

  private workerSession(w: WorkerSim): SimSession {
    if (w.session && !w.session.isStopped) return w.session;
    const handlers: Record<string, ToolHandler> = {
      [TOOLS.work]: this.workTool(w.knows, () => w.session),
      ...(this.direct ? { [TOOLS.handBack]: () => 'Handed back.', [TOOLS.unsubscribe]: () => 'Unsubscribed.' } : {}),
    };
    w.session = new SimSession(this.env, {
      role: 'worker',
      model: 'bench-strong',
      system: workerSystem(this.direct),
      overheadTokens: this.o.harnessTokens.claudeCode,
      handlers,
      afterTool: () => this.takeDeliveries(w),
    });
    return w.session;
  }

  private async workerLoop(w: WorkerSim) {
    w.running = true;
    w.rec.status = 'running';
    let text = '';
    for (;;) {
      const prompt = w.first
        ? workerPrompt({
            context: [],
            lead: LEAD,
            title: w.rec.title,
            task: w.rec.task,
            userWords: w.userWords,
            threads: w.rec.threads ? [{ id: this.thread.id, title: this.thread.title, kind: 'workspace' }] : undefined,
            now: this.now,
          })
        : workerPrompt({ context: [], lead: LEAD, followUps: (w.rec.pending || []).splice(0), now: this.now });
      w.first = false;
      this.learn(w.knows, prompt);
      w.rec.turns++;
      const res = await this.workerSession(w).turn(prompt);
      text = res.text;
      if (w.stop || res.stopped) break;
      if (!w.rec.pending?.length) break;
    }
    w.running = false;
    if (w.stop) return this.finishWorker(w, 'stopped', 'Stopped by the Router');
    // Crew merges the Worker's branch, then tells the Workers sharing the workspace.
    if (this.direct) this.publish({ source: 'landing', summary: `${w.rec.id} merged "${w.rec.title}" into the chat's branch`, text: '', subjects: [w.rec.title], facts: {}, origin: w.rec.id });
    this.finishWorker(w, 'done', undefined, text);
  }

  private finishWorker(w: WorkerSim, status: 'done' | 'stopped', detail?: string, text?: string) {
    w.rec.status = status;
    w.rec.detail = detail;
    w.running = false;
    // What it never read goes back to the normal path; dropped only when the user stopped it all.
    const left = w.rec.inbox || [];
    w.rec.inbox = [];
    for (const d of left) this.unreadBy(w.rec.id, d.triggerId, false);
    const report = text ?? `Stopped: ${detail}`;
    w.lastReport = report;
    this.toRouter({ kind: 'worker', id: w.rec.id, at: this.now, bot: LEAD, title: w.rec.title, status, report });
  }

  private takeDeliveries(w: WorkerSim): string | null {
    const env = (w.rec.inbox || []).filter((d) => !d.explicit);
    if (!env.length) return null;
    w.rec.inbox = (w.rec.inbox || []).filter((d) => d.explicit);
    for (const d of env) this.unread.delete(d.triggerId);
    return deliveredNote(env, this.now);
  }

  /** Returns true when the message waits for the Worker's current turn to end. */
  private messageWorker(w: WorkerSim, text: string): boolean {
    w.stop = false;
    w.rec.pending = [...(w.rec.pending || []), text];
    const busy = w.running || w.rec.status === 'starting';
    if (!busy) {
      w.rec.status = 'running';
      void this.workerLoop(w);
    }
    return busy;
  }

  private stopWorker(w: WorkerSim) {
    w.stop = true;
    w.rec.pending = [];
    w.session?.stop();
  }

  // ---------------------------------------------------------------- the classic lead

  private toLead(x: LeadIn) {
    this.arrivals.push(this.now);
    if (this.o.config === 'single-delegate' && this.leadRunning) this.midTurn.push(x);
    else this.leadQueue!.push(x);
  }

  private leadSession(): SimSession {
    if (this.coordSession) return this.coordSession;
    const delegate = this.o.config === 'single-delegate';
    const handlers: Record<string, ToolHandler> = {
      [TOOLS.work]: this.workTool(
        this.leadKnows,
        () => this.coordSession,
        (task) => this.informed(task),
      ),
      ...(delegate
        ? {
            [TOOLS.start]: (input) => {
              const running = this.jobs.filter((j) => j.running).length;
              const refusal = startRefusal({ task: String(input.task || '') }, { level: 'auto', running, hasProject: true });
              if (refusal) {
                this.refusals.start = (this.refusals.start || 0) + 1;
                return { error: refusal };
              }
              const j = this.startJob(String(input.title || input.task || ''), String(input.task || ''));
              return `Started ${j.id} (sub-task "${j.task}"). Its result will arrive as a new event when it ends; you can keep working.`;
            },
            [TOOLS.stop]: (input) => {
              const j = this.jobs.find((x) => x.id === String(input.id));
              if (!j?.running) return { error: 'No such running job.' };
              j.stop = true;
              j.session?.stop();
              return `Stopped ${j.id}.`;
            },
            [TOOLS.status]: () => this.jobs.map((j) => `${j.id} · ${j.task} · ${j.running ? 'running' : 'ended'}`).join('\n') || 'No jobs.',
          }
        : {}),
    };
    this.coordSession = new SimSession(this.env, {
      role: 'lead',
      model: 'bench-strong',
      system: leadSystem(delegate),
      overheadTokens: this.o.harnessTokens.claudeCode,
      handlers,
      afterTool: delegate ? () => this.takeNewInput() : undefined,
      onReply: () => this.userFacing(),
    });
    return this.coordSession;
  }

  private takeNewInput(): string | null {
    if (!this.midTurn.length) return null;
    const items = this.midTurn.splice(0);
    this.seen(items.map((i) => i.userId));
    for (const i of items) this.informed(i.informs);
    this.decided += items.length;
    const text = newInputText(items.map((i) => i.line));
    this.learn(this.leadKnows, text);
    return text;
  }

  private async leadTurn(batch: LeadIn[]) {
    this.leadRunning = true;
    const recap = this.rotation(new Set(batch.flatMap((b) => (b.userId ? [b.userId] : []))));
    const session = this.leadSession();
    this.seen(batch.map((b) => b.userId));
    for (const b of batch) this.informed(b.informs);
    this.turnRecord(
      batch.length,
      batch.some((b) => b.userId),
    );
    const prompt = leadTurnPrompt(
      batch.map((b) => b.line),
      recap,
    );
    this.learn(this.leadKnows, prompt);
    const res = await session.turn(prompt);
    if (res.text) this.chat.push({ id: `reply_${this.replySeq}`, seq: ++this.replySeq, who: 'You', text: res.text });
    this.leadRunning = false;
    // Input that came after its last step waits for the next turn.
    for (const x of this.midTurn.splice(0)) this.leadQueue!.push(x);
    if (session.tokens >= this.o.rotateAtTokens) this.rotate = true;
  }

  private startJob(title: string, brief: string): Job {
    const j: Job = { id: `job_${++this.idSeq.job}`, task: /^(T\d+)/.exec(title)?.[1] || /\b(T\d+)\b/.exec(brief)?.[1] || 'T00', brief, knows: new Set(), session: null, running: true, stop: false };
    this.jobs.push(j);
    this.clock.after(this.o.startupMs, () => void this.runJob(j));
    return j;
  }

  private async runJob(j: Job) {
    if (j.stop) {
      j.running = false;
      return;
    }
    j.session = new SimSession(this.env, {
      role: 'subtask',
      model: 'bench-strong',
      system: subtaskSystem(),
      overheadTokens: this.o.harnessTokens.claudeCode,
      handlers: { [TOOLS.work]: this.workTool(j.knows, () => j.session) },
    });
    this.learn(j.knows, j.brief);
    const res = await j.session.turn(j.brief);
    j.running = false;
    // A job the lead stopped answers its stop call; one that ended comes back as an event.
    if (j.stop || res.stopped) return;
    this.toLead({ line: jobLine(j.id, j.task, 'done', res.text), informs: j.task });
  }

  // ---------------------------------------------------------------- result

  private result(): RunResult {
    const requests: RequestOutcome[] = [...this.tasks.values()]
      .filter((t) => t.units.length)
      .map((t) => {
        const work = t.units.reduce((s, u) => s + u.work, 0);
        const base = { task: t.id, requestAt: t.requestAt - this.t0, followUps: t.followUps, work, wastedMs: t.performedAfterStop };
        if (t.stopAt !== undefined) {
          const tooLate = t.finishedAt !== undefined && t.finishedAt <= t.stopAt;
          const stopLatencyMs = tooLate ? undefined : Math.max(0, (t.lastPerformedAt ?? t.stopAt) - t.stopAt);
          return { ...base, stopped: true, tooLate, stopLatencyMs };
        }
        return {
          ...base,
          stopped: false,
          completedAt: t.completedAt !== undefined ? t.completedAt - this.t0 : undefined,
          completionMs: t.completedAt !== undefined ? t.completedAt - t.requestAt : undefined,
        };
      });
    const role = this.twoLayer ? 'router' : 'lead';
    const label = CONFIGS.find((c) => c.id === this.o.config)!.label;
    return {
      config: this.o.config,
      label,
      requests,
      ackMs: this.ackMs,
      coordinator: {
        role,
        turns: this.stats[role].turns,
        decided: this.decided,
        calls: this.stats[role].calls,
        direct: this.directCount,
        arrivals: this.arrivals.length,
        rotations: this.rotations,
      },
      turns: this.turnRecords,
      tokens: this.stats,
      triggers: Object.fromEntries(Object.entries(this.ruleCounts).sort(([a], [b]) => a.localeCompare(b))),
      refusals: this.refusals,
      executors: this.twoLayer ? this.workers.length : this.jobs.length,
      endMs: this.now - this.t0,
    };
  }
}

/** One configuration over one workload. Deterministic for a given workload and client. */
export function simulate(o: SimOptions): Promise<RunResult> {
  return new Run(o).run();
}
