// The Super-agent ablation bench (ADR 101): one workload through four configurations, a time-scale
// sweep for the Router's batching, and one JSON-serialisable result. Deterministic: the same
// options give the same result, byte for byte, so nothing here records the wall clock.

import { batchByRate, type ConfigSummary, type DirectRoutingEffect, directRoutingEffect, type RateBin, type SweepPoint, summarize, sweepPoint } from './metrics';
import { DEFAULT_LATENCY, inProcessClient, type LatencyModel, type ModelClient } from './model';
import { scriptedPolicy } from './policies';
import { CONFIGS, type ConfigId, type RunResult, SIM_DEFAULTS, type SimOptions, simulate } from './sim';
import { DEFAULT_WORKLOAD, generateWorkload, type WorkloadKind } from './workload';

export { CONFIGS, type ConfigId } from './sim';

export interface BenchOptions {
  seed: number;
  messages: number;
  requests: number;
  durationMin: number;
  timeScale: number;
  configs: ConfigId[];
  /** Time scales for the batching sweep of (a) and (b); empty for none. */
  sweep: number[];
  latency: LatencyModel;
  sim: Omit<SimOptions, 'config' | 'workload' | 'client' | 'latency'>;
}

export const DEFAULT_SWEEP = [2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01];

export const DEFAULT_BENCH: BenchOptions = {
  ...DEFAULT_WORKLOAD,
  configs: CONFIGS.map((c) => c.id),
  sweep: DEFAULT_SWEEP,
  latency: DEFAULT_LATENCY,
  sim: SIM_DEFAULTS,
};

/** Small enough for CI: a fifth of the stream, a third of the time, no sweep. */
export const REDUCED: Partial<BenchOptions> = { messages: 60, requests: 5, durationMin: 60, sweep: [] };

export interface BenchResult {
  bench: 'crew-superagent-ablation';
  version: 1;
  options: BenchOptions;
  workload: { counts: Record<WorkloadKind, number>; spanMin: number };
  summaries: ConfigSummary[];
  /** (a) against (b), when both ran. */
  directRouting: DirectRoutingEffect | null;
  /** Per configuration with a Router: mean batch size by the arrival rate before the turn. */
  batchByRate: { config: ConfigId; bins: RateBin[] }[];
  sweep: SweepPoint[];
  runs: RunResult[];
}

export function resolveOptions(o: Partial<BenchOptions> = {}): BenchOptions {
  const given = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<BenchOptions>;
  return { ...DEFAULT_BENCH, ...given, sim: { ...SIM_DEFAULTS, ...given.sim }, latency: { ...DEFAULT_LATENCY, ...given.latency } };
}

export async function runBench(opts: Partial<BenchOptions> = {}, client: ModelClient = inProcessClient(scriptedPolicy)): Promise<BenchResult> {
  const o = resolveOptions(opts);
  const workloadOf = (timeScale: number) => generateWorkload({ seed: o.seed, messages: o.messages, requests: o.requests, durationMin: o.durationMin, timeScale });
  const run = (config: ConfigId, timeScale: number) => simulate({ ...o.sim, config, workload: workloadOf(timeScale), client, latency: o.latency });

  const workload = workloadOf(o.timeScale);
  const runs: RunResult[] = [];
  for (const config of o.configs) runs.push(await run(config, o.timeScale));
  const summaries = runs.map(summarize);
  const a = summaries.find((s) => s.config === 'super-agent');
  const b = summaries.find((s) => s.config === 'no-direct');

  const sweep: SweepPoint[] = [];
  for (const scale of o.sweep) {
    const span = workloadOf(scale).span;
    for (const config of ['super-agent', 'no-direct'] as const) {
      if (!o.configs.includes(config)) continue;
      sweep.push(sweepPoint(await run(config, scale), scale, span));
    }
  }

  return {
    bench: 'crew-superagent-ablation',
    version: 1,
    options: o,
    workload: { counts: workload.counts, spanMin: Math.round(workload.span / 6000) / 10 },
    summaries,
    directRouting: a && b ? directRoutingEffect(a, b) : null,
    batchByRate: runs.filter((r) => r.coordinator.role === 'router').map((r) => ({ config: r.config, bins: batchByRate(r.turns) })),
    sweep,
    runs,
  };
}
