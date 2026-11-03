// The cost profile (ADR 108): what the Super-agent's model calls cost per role on the bench's
// scenarios, so a change to a prompt, a tool description or a rule shows up as a number. Pure: the
// text Crew sends besides the conversation (system prompts, tool definitions, recall results) comes
// in from scripts/cost.ts, which builds it with Crew's real code.
//
// Per role: model calls, the static part of each call (system prompt + tool definitions), the
// conversation injected and re-read (the cached-read analogue), and the latency model's time.
// The Watchdog is replayed over each scenario's Worker timeline with its real fast path (a tick
// with nothing flagged calls no model); recall is measured as a scenario with the chain of recall on.

import { estimateTokens } from '../recall/spill';
import { tickPrompt } from '../watchdog/prompts';
import { isQuiet, renderSnapshot, type Snapshot, snapshotFlags, type WorkerSnap } from '../watchdog/snapshot';
import { type BenchOptions, resolveOptions } from './index';
import { summarize } from './metrics';
import { inProcessClient, type ModelClient, type Role } from './model';
import { scriptedPolicy } from './policies';
import { type ArmId, type ConfigId, type RunResult, simulate, type WorkerTimeline } from './sim';
import { generateWorkload } from './workload';

/** Text one role sends on every call besides its conversation. */
export interface StaticText {
  system: string;
  /** The tool definitions as the model receives them (JSON). */
  tools: string;
}

export type StaticRole = 'router' | 'router-recall' | 'worker' | 'worker-direct' | 'worker-recall' | 'speculative' | 'watchdog' | 'filter';

export interface CostInputs {
  statics: Record<StaticRole, StaticText>;
  /** Tokens of Claude Code's own system prompt and built-in tools, for sessions that run on it. */
  claudeCodeTokens: number;
  /** The Watchdog's settings that shape its system prompt and ticks. */
  watchdog: { everyMinutes: number; stuckMinutes: number; maxActionsPerTick: number };
}

export interface ScenarioSpec {
  id: string;
  label: string;
  config: ConfigId;
  arm?: ArmId;
  recall?: boolean;
}

export const SCENARIOS: ScenarioSpec[] = [
  { id: 'super-agent', label: '(a) Super-agent', config: 'super-agent' },
  { id: 'no-direct', label: '(b) No direct routing', config: 'no-direct' },
  { id: 'speculative', label: '(a) + speculative runs', config: 'super-agent', arm: 'speculative' },
  { id: 'github', label: '(a) + GitHub channel', config: 'super-agent', arm: 'github' },
  { id: 'recall', label: '(a) + chain of recall', config: 'super-agent', recall: true },
];

export interface RoleCost {
  calls: number;
  sessions: number;
  /** System prompt + tool definitions (+ Claude Code's own for the sessions on it), per call. */
  staticTokens: number;
  /** New text put into contexts, static parts counted once per session. */
  injected: number;
  /** Context length summed over every call. */
  contextRead: number;
  /** contextRead / calls: the mean prompt of one call. */
  meanPromptTokens: number;
  output: number;
  modelSec: number;
}

export interface WatchdogCost {
  ticks: number;
  quiet: number;
  healthy: number;
  /** Ticks whose fast path found a flag: one model turn each. */
  ran: number;
  staticTokens: number;
  /** The tick prompt (snapshot) of a flagged tick at the scenario's busiest moment. */
  flaggedTickTokens: number;
  /** Static + flagged tick: one Watchdog call. */
  flaggedCallTokens: number;
}

export interface ScenarioCost {
  id: string;
  label: string;
  roles: Partial<Record<Role, RoleCost>>;
  watchdog: WatchdogCost;
  /** The bench's quality metrics: these must not get worse. */
  quality: {
    completed: number;
    stopped: number;
    unfinished: number;
    completionP50Min: number | null;
    completionP95Min: number | null;
    ackP50Sec: number | null;
    ackP95Sec: number | null;
    stopLatencyP50Sec: number | null;
    routerDecisions: number;
    replyWords: number;
    detailsAttached: number;
    triggers: Record<string, number>;
  };
}

export interface CostResult {
  bench: 'crew-superagent-cost';
  version: 1;
  options: Pick<BenchOptions, 'seed' | 'messages' | 'requests' | 'durationMin' | 'timeScale'>;
  /** Tokens and characters of each role's static text. */
  statics: Record<StaticRole, { systemTokens: number; toolsTokens: number; systemChars: number; toolsChars: number }>;
  scenarios: ScenarioCost[];
  recall: {
    /** Mean tokens of one recall result, by object kind: real results, filled in by scripts/cost.ts. */
    resultTokens: Record<string, number>;
    /** The Router's injected batches with the chain of recall on against off, (a). */
    routerInjectedOn: number;
    routerInjectedOff: number;
  };
}

const tok = (s: string) => estimateTokens(s);
const r1 = (n: number) => Math.round(n * 10) / 10;

function staticOf(i: CostInputs, role: StaticRole): number {
  const s = i.statics[role];
  return tok(s.system) + tok(s.tools);
}

/** Which static text each bench role of a scenario sends. */
function staticRoles(spec: ScenarioSpec): Partial<Record<Role, StaticRole>> {
  const direct = spec.config === 'super-agent';
  return {
    router: spec.recall ? 'router-recall' : 'router',
    worker: spec.recall ? 'worker-recall' : direct ? 'worker-direct' : 'worker',
    speculative: 'speculative',
    filter: 'filter',
  };
}

const MIN = 60_000;

/**
 * The Watchdog's timer over a run: every `everyMinutes`, the Workers as its snapshot would show them
 * (active, or ended since the last tick), through its real fast path. The bench's work tool repeats
 * one call for many kinds of real work, so its repeats are not counted as looping.
 */
export function replayWatchdog(run: RunResult, i: CostInputs): WatchdogCost {
  const every = i.watchdog.everyMinutes * MIN;
  const timeline = run.timeline || [];
  const staticTokens = staticOf(i, 'watchdog');
  const out: WatchdogCost = { ticks: 0, quiet: 0, healthy: 0, ran: 0, staticTokens, flaggedTickTokens: 0, flaggedCallTokens: 0 };
  let busiest: { snap: Snapshot; n: number } | null = null;
  for (let at = every, since = 0; at <= run.endMs + every; since = at, at += every) {
    const snap = snapshotAt(timeline, at, since, i);
    out.ticks++;
    if (isQuiet(snap)) out.quiet++;
    else if (!snapshotFlags(snap).length) out.healthy++;
    else out.ran++;
    if (!busiest || snap.workers.length > busiest.n) busiest = { snap, n: snap.workers.length };
  }
  if (busiest?.n) {
    // A flagged tick at the busiest moment: one active Worker made no progress for longer than allowed.
    const snap = structuredClone(busiest.snap);
    const w = snap.workers.find((x) => x.status === 'running') ?? snap.workers[0];
    w.status = 'running';
    w.lastProgressAt = snap.at - (i.watchdog.stuckMinutes + 5) * MIN;
    const flags = snapshotFlags(snap);
    out.flaggedTickTokens = tok(tickPrompt(renderSnapshot(snap, { reason: `flagged: ${flags.join(', ')}` })));
    out.flaggedCallTokens = staticTokens + out.flaggedTickTokens;
  }
  return out;
}

function snapshotAt(timeline: WorkerTimeline[], at: number, since: number, i: CostInputs): Snapshot {
  const workers: WorkerSnap[] = [];
  for (const w of timeline) {
    if (w.createdAt > at) continue;
    const ended = w.endedAt !== undefined && w.endedAt <= at;
    if (ended && (w.endedAt as number) <= since) continue;
    const done = w.activity.filter((t) => t <= at);
    workers.push({
      id: w.id,
      chatId: 'chat',
      chatTitle: 'Bench',
      bot: 'Chief',
      title: w.title,
      task: w.task,
      status: ended ? w.status : 'running',
      createdAt: w.createdAt,
      lastProgressAt: done.length ? done[done.length - 1] : w.createdAt,
      turns: w.turns,
      costUsd: 0,
      recent: done.length ? ['mcp__bench__work'] : [],
      repeats: 1,
      ...(ended && w.report ? { report: { status: w.status, text: w.report, at: w.endedAt as number } } : {}),
      transient: false,
      nudgesToday: 0,
      restartsToday: 0,
    });
  }
  return {
    at,
    since,
    stuckMinutes: i.watchdog.stuckMinutes,
    actionsLeft: i.watchdog.maxActionsPerTick,
    workers,
    approvals: [],
    turnErrors: [],
    friction: [],
    interfaceErrors: [],
    watches: [],
    audit: [],
  };
}

function roleCosts(run: RunResult, spec: ScenarioSpec, i: CostInputs): Partial<Record<Role, RoleCost>> {
  const which = staticRoles(spec);
  const out: Partial<Record<Role, RoleCost>> = {};
  for (const [role, s] of Object.entries(run.tokens) as [Role, RunResult['tokens'][Role]][]) {
    if (!s.calls) continue;
    const st = which[role];
    const claudeCode = role === 'worker' || role === 'speculative' ? i.claudeCodeTokens : 0;
    out[role] = {
      calls: s.calls,
      sessions: s.sessions,
      staticTokens: (st ? staticOf(i, st) : 0) + claudeCode,
      injected: s.injected,
      contextRead: s.contextRead,
      meanPromptTokens: Math.round(s.contextRead / s.calls),
      output: s.output,
      modelSec: r1(s.modelMs / 1000),
    };
  }
  return out;
}

/** Runs every scenario with Crew's real static text in place of the bench's stand-ins. */
export async function runCost(i: CostInputs, opts: Partial<BenchOptions> = {}, client: ModelClient = inProcessClient(scriptedPolicy)): Promise<{ result: CostResult; runs: Map<string, RunResult> }> {
  const o = resolveOptions(opts);
  const workload = generateWorkload({ seed: o.seed, messages: o.messages, requests: o.requests, durationMin: o.durationMin, timeScale: o.timeScale });
  const scenarios: ScenarioCost[] = [];
  const runs = new Map<string, RunResult>();
  for (const spec of SCENARIOS) {
    const which = staticRoles(spec);
    const run = await simulate({
      ...o.sim,
      config: spec.config,
      arm: spec.arm,
      workload,
      client,
      latency: o.latency,
      // The bench adds these beside each session's system prompt: here, the real tool definitions.
      harnessTokens: { claudeCode: i.claudeCodeTokens + tok(i.statics[which.worker as StaticRole].tools), router: tok(i.statics[which.router as StaticRole].tools) },
      systemPrompts: { worker: i.statics[which.worker as StaticRole].system, speculative: i.statics.speculative.system },
      ...(spec.recall ? { recall: { inlineWords: 50 } } : {}),
      timeline: true,
    });
    runs.set(spec.id, run);
    const s = summarize(run);
    scenarios.push({
      id: spec.id,
      label: spec.label,
      roles: roleCosts(run, spec, i),
      watchdog: replayWatchdog(run, i),
      quality: {
        completed: s.requests.completed,
        stopped: s.requests.stopped,
        unfinished: s.requests.unfinished,
        completionP50Min: s.completionMin.p50,
        completionP95Min: s.completionMin.p95,
        ackP50Sec: s.ackSec.p50,
        ackP95Sec: s.ackSec.p95,
        stopLatencyP50Sec: s.stops.latencySecP50,
        routerDecisions: s.coordinator.decided,
        replyWords: s.arms.channel.words,
        detailsAttached: s.arms.channel.detailsAttached,
        triggers: s.triggers,
      },
    });
  }
  const statics = Object.fromEntries(
    (Object.entries(i.statics) as [StaticRole, StaticText][]).map(([k, v]) => [
      k,
      { systemTokens: tok(v.system), toolsTokens: tok(v.tools), systemChars: v.system.length, toolsChars: v.tools.length },
    ]),
  ) as CostResult['statics'];
  const result: CostResult = {
    bench: 'crew-superagent-cost',
    version: 1,
    options: { seed: o.seed, messages: o.messages, requests: o.requests, durationMin: o.durationMin, timeScale: o.timeScale },
    statics,
    scenarios,
    recall: {
      resultTokens: {},
      routerInjectedOn: runs.get('recall')?.tokens.router.injected ?? 0,
      routerInjectedOff: runs.get('super-agent')?.tokens.router.injected ?? 0,
    },
  };
  return { result, runs };
}

// ---------------------------------------------------------------- printing

const pct = (x: number, base: number) => (base ? `${x >= base ? '+' : ''}${Math.round(((x - base) / base) * 1000) / 10}%` : '–');

/** A plain-text table of a result, and the change against an earlier one when given. */
export function costTable(r: CostResult, before?: CostResult): string {
  const lines: string[] = [];
  const cmp = (x: number, b: number | undefined) => (b === undefined ? String(x) : `${x} (${pct(x, b)})`);
  lines.push('Static text per call (estimated tokens: system prompt + tool definitions):');
  for (const [k, v] of Object.entries(r.statics)) {
    const b = before?.statics[k as StaticRole];
    lines.push(`  ${k.padEnd(14)} system ${cmp(v.systemTokens, b?.systemTokens).padEnd(16)} tools ${cmp(v.toolsTokens, b?.toolsTokens)}`);
  }
  for (const s of r.scenarios) {
    const b = before?.scenarios.find((x) => x.id === s.id);
    lines.push('', `${s.label}:`);
    for (const [role, c] of Object.entries(s.roles) as [Role, RoleCost][]) {
      const p = b?.roles[role];
      lines.push(
        `  ${role.padEnd(12)} calls ${cmp(c.calls, p?.calls).padEnd(14)} static ${cmp(c.staticTokens, p?.staticTokens).padEnd(16)} mean prompt ${cmp(c.meanPromptTokens, p?.meanPromptTokens).padEnd(16)} context read ${cmp(c.contextRead, p?.contextRead).padEnd(20)} model ${cmp(c.modelSec, p?.modelSec)} s`,
      );
    }
    const w = s.watchdog;
    lines.push(
      `  watchdog     ticks ${w.ticks}: quiet ${w.quiet}, healthy ${w.healthy}, ran ${cmp(w.ran, b?.watchdog.ran)}; one flagged call ${cmp(w.flaggedCallTokens, b?.watchdog.flaggedCallTokens)} tokens (static ${cmp(w.staticTokens, b?.watchdog.staticTokens)})`,
    );
    const q = s.quality;
    const bq = b?.quality;
    lines.push(
      `  quality      completed ${q.completed} (stopped ${q.stopped}, unfinished ${q.unfinished}) · completion p50 ${cmp(q.completionP50Min ?? 0, bq?.completionP50Min ?? undefined)} min, p95 ${cmp(q.completionP95Min ?? 0, bq?.completionP95Min ?? undefined)} min · ack p50 ${cmp(q.ackP50Sec ?? 0, bq?.ackP50Sec ?? undefined)} s, p95 ${cmp(q.ackP95Sec ?? 0, bq?.ackP95Sec ?? undefined)} s`,
    );
  }
  lines.push('', 'Recall:');
  for (const [k, v] of Object.entries(r.recall.resultTokens)) lines.push(`  one ${k} result ${cmp(v, before?.recall.resultTokens[k])} tokens`);
  lines.push(`  Router injected, (a) with recall on ${cmp(r.recall.routerInjectedOn, before?.recall.routerInjectedOn)}, off ${cmp(r.recall.routerInjectedOff, before?.recall.routerInjectedOff)}`);
  return lines.join('\n');
}
