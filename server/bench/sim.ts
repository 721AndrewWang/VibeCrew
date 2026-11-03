// One run of the ablation bench (ADR 101): a workload through one configuration, on the virtual
// clock. The routing decisions are Crew's own pure rules (the fast path, subscriptions, gates, the
// Router's batch queue and prompts); the scheduling around them (one turn at a time, delivery
// between steps, landing and reporting when a Worker's turn ends) follows RouterSession,
// layers/workers.ts and the orchestrator, without the store, git or Claude Code.

import { DEFAULT_GITHUB, DEFAULT_PROJECT_SPECULATIVE, DEFAULT_SPECULATIVE } from '../../shared/defaults';
import { WORKER_ACTIVE } from '../../shared/status';
import type { SuperAgentSettings, Thread, Trigger, Worker, WorkerDelivery } from '../../shared/types';
import { REPLY_WORDS } from '../channels/profiles';
import type { GhEvent } from '../github/events';
import { screenGithub } from '../github/filter';
import { MAX_RUNNING, startRefusal } from '../jobs/gates';
import { BatchQueue } from '../layers/batch';
import { dispatchRefusal, messageRefusal, replyRefusal } from '../layers/gates';
import { type DirectLine, deliveredNote, explicitEvent, type RouterEvent, recapText, renderBatch, routerSystemPrompt, type WorkerLine, workerPrompt } from '../layers/prompts';
import { pushInbox, receivers } from '../layers/subscriptions';
import { speculativePrompt } from '../speculative/prompts';
import { gateRefusal, SAME_SIGNAL_MS, signalOf } from '../speculative/rules';
import { wordCount } from '../text';
import { type FastInput, fastPath, fingerprintOf, normalizeSuperAgent, reachedSlowPath } from '../triggers/fastPath';
import { BENCH_EPOCH, VirtualClock } from './clock';
import { DEFAULT_LATENCY, type LatencyModel, type ModelClient, type Role } from './model';
import { TOOLS } from './policies';
import {
  CHAT_TITLE,
  ciLine,
  filler,
  filterPrompt,
  filterSystem,
  jobLine,
  LEAD,
  type LeadLine,
  leadSystem,
  leadTurnPrompt,
  newInputText,
  speculativeSystem,
  subtaskSystem,
  workerSystem,
} from './prompts';
import { emptyStats, type RoleStats, SimSession, type ToolHandler } from './session';
import type { Workload, WorkloadEvent } from './workload';

export type ConfigId = 'super-agent' | 'no-direct' | 'single-neutral' | 'single-delegate';

export const CONFIGS: { id: ConfigId; label: string; description: string }[] = [
  { id: 'super-agent', label: '(a) Super-agent', description: 'Router + Workers + thread subscriptions (direct routing)' },
  { id: 'no-direct', label: '(b) No direct routing', description: 'Router + Workers, every event through the Router' },
  { id: 'single-neutral', label: '(c) Single session, neutral', description: 'The classic lead bot does every task itself' },
  { id: 'single-delegate', label: '(d) Single session, delegate-first', description: 'The classic lead bot, full duplex, delegates to background sub-tasks' },
];

/**
 * Extra arms on top of (a), one wave-2 feature switched each (ADR 011): speculative runs on failing
 * CI (ADR 008), CI as GitHub check events on each task's pull request thread (ADR 102), and the
 * Router without per-channel output (ADR 103), which (a) and (b) have since Crew always applies it.
 */
export type ArmId = 'speculative' | 'github' | 'no-channels';

export const ARMS: { id: ArmId; label: string; description: string }[] = [
  { id: 'speculative', label: '(a) + speculative runs', description: 'A failing CI result may start a silent reproduce-and-fix run (ADR 008), under its own gates' },
  { id: 'github', label: '(a) + GitHub channel', description: "CI results arrive as GitHub check events on each task's pull request thread, and Workers subscribe to their task's (ADR 102)" },
  { id: 'no-channels', label: '(a) − per-channel output', description: 'The Router without channel norms: only the word cap, no reply kinds or Details, reports relayed in the chat (ADR 103)' },
];

export interface SimOptions {
  config: ConfigId;
  /** An arm on top of 'super-agent' (ADR 011). */
  arm?: ArmId;
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
  /** What one speculative run is assumed to cost, for its daily budget gate (the bench has no prices). */
  speculativeRunUsd?: number;
  /** Steps of work a speculative run takes, and how long one run of the check command takes (minutes, before time scaling). */
  speculativeSteps?: number;
  checkMin?: number;
}

export const SIM_DEFAULTS = {
  stepMin: 2,
  workResultTokens: 300,
  rotateAtTokens: 60_000,
  maxWorkers: MAX_RUNNING,
  startupMs: 3000,
  maxHops: 8,
  harnessTokens: { claudeCode: 8000, router: 600 },
  speculativeRunUsd: 0.5,
  speculativeSteps: 2,
  checkMin: 1,
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

/** What the wave-2 features did in a run (ADR 011). */
export interface ArmMetrics {
  /** The Router's replies: how many, their words, Worker reports attached under Details, refused ones. */
  channel: { replies: number; words: number; maxWords: number; detailsAttached: number; refused: number };
  speculative?: { signals: number; started: number; ready: number; skipped: Record<string, number> };
  github?: { checks: number; direct: number; deliveries: number };
}

export interface RunResult {
  config: ConfigId;
  arm?: ArmId;
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
  arms: ArmMetrics;
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
  /** The wave-2 switches of this run (ADR 011). */
  private readonly features: { speculative: boolean; github: boolean; channels: boolean };
  private taskThreads = new Map<string, Thread>();
  private arm: ArmMetrics = { channel: { replies: 0, words: 0, maxWords: 0, detailsAttached: 0, refused: 0 } };
  private batchReports: string[] = [];
  private specRuns: { id: string; task: string; fingerprint: string; at: number; status: 'running' | 'ready' }[] = [];

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
    const arm = opts.config === 'super-agent' ? opts.arm : undefined;
    this.features = { speculative: arm === 'speculative', github: arm === 'github', channels: this.twoLayer && arm !== 'no-channels' };
    if (this.features.speculative) this.arm.speculative = { signals: 0, started: 0, ready: 0, skipped: {} };
    if (this.features.github) this.arm.github = { checks: 0, direct: 0, deliveries: 0 };
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
    const t = this.features.github
      ? this.publishCheck(ev)
      : this.publish({ source: 'preview-console', summary: ev.text, text: ev.text, subjects: failures.map((f) => `${ev.task}: ${f}`), facts: { errors: failures.length } });
    if (this.features.speculative && ev.ci && !ev.ci.passed) this.considerSpeculation(t, ev);
  }

  /** The pull request thread of a task's branch (ADR 102): one per task, as GitHub has one per pull request. */
  private taskThread(task: string): Thread {
    let th = this.taskThreads.get(task);
    if (!th) {
      const n = Number(task.replace(/\D/g, '')) || 0;
      th = { id: `th_pr_${task}`, key: `github:proj:acme/site#${n}`, kind: 'github', title: `GitHub acme/site#${n}`, projectId: 'proj', chatId: null, createdAt: this.now, lastAt: this.now, count: 0 };
      this.taskThreads.set(task, th);
    }
    return th;
  }

  /** A CI result as GitHub reports it: a check run on the task's pull request, screened by the project's GitHub rules. */
  private publishCheck(ev: WorkloadEvent): SimTrigger {
    const task = ev.task || 'T00';
    const n = Number(task.replace(/\D/g, '')) || 0;
    const passed = !!ev.ci?.passed;
    const e: GhEvent = {
      kind: 'check',
      repo: 'acme/site',
      number: n,
      pr: true,
      key: `check:${ev.id}`,
      at: this.now,
      url: '',
      body: ev.text,
      check: { name: 'ci', conclusion: passed ? 'success' : 'failure', head: `head-${ev.id}` },
    };
    const screen = screenGithub(e, { ...DEFAULT_GITHUB, enabled: true, repos: ['acme/site'] }, { ownUrls: new Set() });
    this.arm.github!.checks++;
    const t = this.publish({
      source: 'github',
      summary: ev.text,
      text: ev.text,
      subjects: ['check', 'ci', passed ? 'success' : 'failure', `${task}:${ev.ci?.failures.join(',')}`],
      facts: screen ? { screen } : {},
      thread: this.taskThread(task),
    });
    if (t.filter.rule === 'subscribed') {
      this.arm.github!.direct++;
      this.arm.github!.deliveries += t.filter.direct?.length ?? 0;
    }
    return t;
  }

  private publish(input: {
    source: 'preview-console' | 'landing' | 'github';
    summary: string;
    text: string;
    subjects: string[];
    facts: FastInput['facts'];
    origin?: string;
    /** Default: the chat's workspace thread. */
    thread?: Thread;
  }): SimTrigger {
    const thread = input.thread ?? this.thread;
    const subs = this.direct ? receivers(this.workerRecs(), { threadId: thread.id, explicit: false, origin: input.origin, live: () => true }) : [];
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
      threadId: thread.id,
      projectId: 'proj',
      chatId: 'chat',
      summary: input.summary,
      ref: { kind: 'payload' },
      related: [],
      explicit: false,
      fingerprint: fast.fingerprint,
      filter: fastPath(fast, { ...this.fastContext(thread), subscribers: subs.map((w) => w.id) }),
      fast,
      text: input.text,
    };
    this.triggers.push(t);
    thread.count++;
    thread.lastAt = this.now;
    this.count(`${input.source === 'landing' ? 'landing' : 'ci'}:${t.filter.rule}`);
    if (t.filter.rule === 'subscribed') this.deliverDirect(t, subs, thread);
    if (t.filter.verdict === 'candidate') this.toFilter(t);
    return t;
  }

  private fastContext(thread: Thread = this.thread) {
    return {
      settings: this.settings,
      thread,
      recent: this.triggers.slice(-50).reverse(),
      candidatesLastHour: this.triggers.filter((t) => t.at >= this.now - HOUR && reachedSlowPath(t)).length,
      now: this.now,
    };
  }

  private threadOf(t: SimTrigger): Thread {
    return [...this.taskThreads.values()].find((th) => th.id === t.threadId) ?? this.thread;
  }

  // ---------------------------------------------------------------- speculative runs (ADR 008)

  /** Crew's own rules decide, as speculative/index.ts does: the signal, then the gates in order. */
  private considerSpeculation(t: SimTrigger, ev: WorkloadEvent) {
    const m = this.arm.speculative!;
    const match = signalOf({ source: 'job', failed: true, command: 'npm test', checkCommand: 'npm test' });
    if (!match) return;
    m.signals++;
    const twin = this.specRuns.find((s) => s.fingerprint === t.fingerprint && this.now - s.at < SAME_SIGNAL_MS);
    const inFlight = this.specRuns.filter((s) => s.status === 'running').length;
    const refused = gateRefusal({
      rules: { ...DEFAULT_PROJECT_SPECULATIVE, enabled: true, checkCommand: 'npm test' },
      settings: DEFAULT_SPECULATIVE,
      signal: match.signal,
      checkCommand: 'npm test',
      subscribed: t.filter.rule === 'subscribed',
      chat: true,
      bot: null,
      git: true,
      duplicateOf: twin?.id,
      inFlight,
      // One project in the bench.
      inFlightHere: inFlight,
      spentTodayUsd: this.specRuns.length * this.o.speculativeRunUsd,
    });
    if (refused) {
      const key = /straight to Workers/.test(refused)
        ? 'subscribed'
        : /same signal/.test(refused)
          ? 'duplicate'
          : /budget/.test(refused)
            ? 'budget'
            : /already going/.test(refused)
              ? 'concurrency'
              : 'other';
      m.skipped[key] = (m.skipped[key] || 0) + 1;
      return;
    }
    const run = { id: `sp_${this.specRuns.length + 1}`, task: ev.task || 'T00', fingerprint: t.fingerprint, at: this.now, status: 'running' as const };
    this.specRuns.push(run);
    m.started++;
    this.clock.after(this.o.startupMs, () => void this.runSpeculation(run, ev));
  }

  /** The run's session works its steps and claims; Crew runs the check twice; a verified fix goes to the Router. */
  private async runSpeculation(run: (typeof this.specRuns)[number], ev: WorkloadEvent) {
    let steps = 0;
    const session = new SimSession(this.env, {
      role: 'speculative',
      model: 'bench-strong',
      system: speculativeSystem(),
      overheadTokens: this.o.harnessTokens.claudeCode,
      handlers: {
        [TOOLS.work]: async () => {
          await this.clock.sleep(this.stepMs);
          steps++;
          return steps >= this.o.speculativeSteps ? `${run.id} is complete.\n${filler(this.o.workResultTokens)}` : `Worked on ${run.id}.\n${filler(this.o.workResultTokens)}`;
        },
        [TOOLS.claim]: () => "Recorded. When your turn ends, Crew runs the project's checks with and without your fix. End your turn now.",
      },
    });
    await session.turn(speculativePrompt({ signal: 'failing-check', detail: ev.text, checkCommand: 'npm test', playbook: [], context: [`Speculative run ${run.id} (task ${run.task})`] }));
    // Verification: the check command after the fix, then without it.
    await this.clock.sleep(2 * Math.max(1000, Math.round(this.o.checkMin * MIN * this.o.workload.options.timeScale)));
    run.status = 'ready';
    this.arm.speculative!.ready++;
    this.toRouter({
      kind: 'environment',
      id: `tg_${++this.idSeq.tg}`,
      at: this.now,
      source: 'speculative',
      summary: `A fix is ready (${run.id}) for CI on crew/${run.task} (${run.task}).`,
      reason: "Crew reproduced the problem in a throwaway workspace and the fix passed the project's checks",
    });
  }

  private count(key: string, n = 1) {
    this.ruleCounts[key] = (this.ruleCounts[key] || 0) + n;
  }

  private deliverDirect(t: SimTrigger, to: Worker[], thread: Thread = this.thread) {
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
    this.observed.push({ id: t.id, source: t.source === 'landing' ? "Workers' merges" : t.source === 'github' ? 'GitHub events' : 'CI results', thread: thread.title, workers: ids });
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
    t.filter = { ...fastPath(t.fast, this.fastContext(this.threadOf(t))), direct: t.filter.direct };
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
    })
      // Without channel norms (ADR 103), the Router's prompt as it was: no reply kinds, no Details.
      .split('\n')
      .filter((l) => this.features.channels || !l.startsWith('- Each reply has a kind'))
      .join('\n');
    const find = (id: unknown) => this.workers.find((w) => w.rec.id === String(id));
    const handlers: Record<string, ToolHandler> = {
      [TOOLS.dispatch]: (input) => {
        const refusal = dispatchRefusal({
          explicit: this.currentExplicit,
          asked: input.bot ? String(input.bot) : undefined,
          member: { name: LEAD },
          spent: 0,
          active: this.workers.filter((w) => WORKER_ACTIVE.has(w.rec.status)).length,
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
        if (!w || !WORKER_ACTIVE.has(w.rec.status)) return { error: 'That Worker is not working.' };
        this.stopWorker(w);
        return `Stopped ${w.rec.id}.`;
      },
      [TOOLS.listWorkers]: () =>
        this.workerLines()
          .map((l) => `${l.id} · ${l.status} · ${l.title}`)
          .join('\n') || '(none)',
      [TOOLS.reply]: (input) => {
        const text = String(input.text || '');
        const kind = input.kind === 'question' || input.kind === 'acceptance' ? input.kind : 'decision';
        // With channel norms, the chat profile; without, the word cap alone.
        const words = wordCount(text);
        const refusal = this.features.channels ? replyRefusal(text, kind) : words > REPLY_WORDS ? `The reply has ${words} words; the chat takes at most ${REPLY_WORDS}.` : null;
        const ch = this.arm.channel;
        if (refusal) {
          ch.refused++;
          return { error: refusal };
        }
        ch.replies++;
        ch.words += words;
        ch.maxWords = Math.max(ch.maxWords, words);
        // The batch's Worker reports go under Details on the first reply (ADR 103).
        if (this.features.channels) ch.detailsAttached += this.batchReports.splice(0).length;
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
    this.batchReports = batch.filter((e) => e.kind === 'worker').map((e) => e.id);
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
        threads: w.rec.threads ? w.rec.threads.map((id) => ({ id, title: id === this.thread.id ? this.thread.title : this.taskThread(w.task).title })) : undefined,
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
      if (rec.threads) rec.threads = this.features.github ? [this.thread.id, this.taskThread(w.task).id] : [this.thread.id];
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
            threads: w.rec.threads
              ? [
                  { id: this.thread.id, title: this.thread.title, kind: 'workspace' },
                  ...(this.features.github ? [{ id: this.taskThread(w.task).id, title: this.taskThread(w.task).title, kind: 'github' }] : []),
                ]
              : undefined,
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
    const arm = this.o.config === 'super-agent' ? this.o.arm : undefined;
    const label = arm ? ARMS.find((a) => a.id === arm)!.label : CONFIGS.find((c) => c.id === this.o.config)!.label;
    return {
      config: this.o.config,
      ...(arm ? { arm } : {}),
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
      arms: this.arm,
    };
  }
}

/** One configuration over one workload. Deterministic for a given workload and client. */
export function simulate(o: SimOptions): Promise<RunResult> {
  return new Run(o).run();
}
