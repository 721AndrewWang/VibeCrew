// What a run is reduced to (ADR 101): completion and acknowledgement percentiles, coordinator
// decisions, estimated tokens, and the Router's batch size against its arrival rate.

import type { Role } from './model';
import type { RoleStats } from './session';
import { CONFIGS, type ConfigId, type RunResult, type TurnRecord } from './sim';

/** The p-th percentile (0-100), linearly interpolated; null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const scaled = (n: number | null, by: number) => (n === null ? null : n / by);
const round = (n: number | null, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const MIN = 60_000;

export interface ConfigSummary {
  config: ConfigId;
  label: string;
  description: string;
  requests: { total: number; completed: number; stopped: number; unfinished: number };
  /** Minutes. */
  completionMin: { p50: number | null; p95: number | null; mean: number | null; max: number | null };
  /** Seconds. */
  ackSec: { p50: number | null; p95: number | null; count: number };
  stops: { count: number; tooLate: number; latencySecP50: number | null; latencySecMax: number | null; wastedMin: number };
  coordinator: RunResult['coordinator'] & { meanBatch: number | null; decisionsPerCall: number | null };
  tokens: { byRole: Record<Role, RoleStats>; injected: number; contextRead: number; output: number; calls: number; coordinatorContextRead: number };
  triggers: Record<string, number>;
  refusals: Record<string, number>;
  executors: number;
  endMin: number;
}

export function summarize(r: RunResult): ConfigSummary {
  const completed = r.requests.filter((q) => !q.stopped && q.completionMs !== undefined).map((q) => q.completionMs! / MIN);
  const stopped = r.requests.filter((q) => q.stopped);
  const latencies = stopped.flatMap((q) => (q.stopLatencyMs !== undefined ? [q.stopLatencyMs / 1000] : []));
  const roles = Object.values(r.tokens);
  const c = r.coordinator;
  return {
    config: r.config,
    label: r.label,
    description: CONFIGS.find((x) => x.id === r.config)?.description || '',
    requests: { total: r.requests.length, completed: completed.length, stopped: stopped.length, unfinished: r.requests.length - completed.length - stopped.length },
    completionMin: {
      p50: round(percentile(completed, 50)),
      p95: round(percentile(completed, 95)),
      mean: round(completed.length ? completed.reduce((a, b) => a + b, 0) / completed.length : null),
      max: round(completed.length ? Math.max(...completed) : null),
    },
    ackSec: { p50: round(scaled(percentile(r.ackMs, 50), 1000)), p95: round(scaled(percentile(r.ackMs, 95), 1000)), count: r.ackMs.length },
    stops: {
      count: stopped.length,
      tooLate: stopped.filter((q) => q.tooLate).length,
      latencySecP50: round(percentile(latencies, 50)),
      latencySecMax: round(latencies.length ? Math.max(...latencies) : null),
      wastedMin: round(stopped.reduce((s, q) => s + q.wastedMs, 0) / MIN) ?? 0,
    },
    coordinator: { ...c, meanBatch: round(c.turns ? c.decided / c.turns : null, 2), decisionsPerCall: round(c.calls ? c.decided / c.calls : null, 2) },
    tokens: {
      byRole: r.tokens,
      injected: roles.reduce((s, x) => s + x.injected, 0),
      contextRead: roles.reduce((s, x) => s + x.contextRead, 0),
      output: roles.reduce((s, x) => s + x.output, 0),
      calls: roles.reduce((s, x) => s + x.calls, 0),
      coordinatorContextRead: r.tokens[c.role].contextRead,
    },
    triggers: r.triggers,
    refusals: r.refusals,
    executors: r.executors,
    endMin: round(r.endMs / MIN) ?? 0,
  };
}

/** Relative change from `base` to `x`, in percent. */
export const pctChange = (x: number | null, base: number | null) => (x === null || base === null || base === 0 ? null : round(((x - base) / base) * 100));

/** The essay's ablation: what direct routing changes, (a) against (b). */
export interface DirectRoutingEffect {
  routerDecisionsPct: number | null;
  routerCallsPct: number | null;
  routerContextReadPct: number | null;
  totalContextReadPct: number | null;
  completionP50DeltaMin: number | null;
  completionP95DeltaMin: number | null;
}

export function directRoutingEffect(a: ConfigSummary, b: ConfigSummary): DirectRoutingEffect {
  const d = (x: number | null, y: number | null) => (x === null || y === null ? null : round(x - y));
  return {
    routerDecisionsPct: pctChange(a.coordinator.decided, b.coordinator.decided),
    routerCallsPct: pctChange(a.coordinator.calls, b.coordinator.calls),
    routerContextReadPct: pctChange(a.tokens.coordinatorContextRead, b.tokens.coordinatorContextRead),
    totalContextReadPct: pctChange(a.tokens.contextRead, b.tokens.contextRead),
    completionP50DeltaMin: d(a.completionMin.p50, b.completionMin.p50),
    completionP95DeltaMin: d(a.completionMin.p95, b.completionMin.p95),
  };
}

export interface RateBin {
  /** Arrivals per minute: the bin's centre. */
  rate: number;
  meanBatch: number;
  turns: number;
}

/** Turns grouped by the arrival rate before them: the mean batch size per bin. */
export function batchByRate(turns: TurnRecord[], bins = 8): RateBin[] {
  if (!turns.length) return [];
  const max = Math.max(...turns.map((t) => t.ratePerMin));
  if (max <= 0) return [{ rate: 0, meanBatch: turns.reduce((s, t) => s + t.size, 0) / turns.length, turns: turns.length }];
  const width = max / bins;
  const out: RateBin[] = [];
  for (let i = 0; i < bins; i++) {
    const inBin = turns.filter((t) => (i === bins - 1 ? t.ratePerMin >= i * width : t.ratePerMin >= i * width && t.ratePerMin < (i + 1) * width));
    if (inBin.length) out.push({ rate: round((i + 0.5) * width, 2)!, meanBatch: round(inBin.reduce((s, t) => s + t.size, 0) / inBin.length, 2)!, turns: inBin.length });
  }
  return out;
}

/** One run of the time-scale sweep (§1's batching claim): load against batch size and cost per decision. */
export interface SweepPoint {
  config: ConfigId;
  timeScale: number;
  /** Router-bound events per minute over the whole run. */
  arrivalPerMin: number;
  meanBatch: number | null;
  decisionsPerCall: number | null;
  /** Router context read per event decided: the cost per decision. */
  contextReadPerDecision: number | null;
  completionP50Min: number | null;
}

export function sweepPoint(r: RunResult, timeScale: number, spanMs: number): SweepPoint {
  const s = summarize(r);
  const c = r.coordinator;
  return {
    config: r.config,
    timeScale,
    arrivalPerMin: round(c.arrivals / Math.max(1, spanMs / MIN), 2) ?? 0,
    meanBatch: s.coordinator.meanBatch,
    decisionsPerCall: s.coordinator.decisionsPerCall,
    contextReadPerDecision: c.decided ? Math.round(r.tokens[c.role].contextRead / c.decided) : null,
    completionP50Min: s.completionMin.p50,
  };
}
