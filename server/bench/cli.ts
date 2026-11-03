// `npm run bench` (ADR 101): runs the ablation bench and writes bench.json and report.html.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { type BenchOptions, CONFIGS, type ConfigId, REDUCED, runBench } from './index';
import { renderReport } from './report';

const USAGE = `Usage: npm run bench -- [options]

  --reduced            A small workload (60 events, 5 requests, no sweep): fast enough for CI
  --out <dir>          Where to write bench.json and report.html (default: bench-results)
  --seed <n>           Workload seed (default 7)
  --messages <n>       Events in the stream (default 300)
  --requests <n>       Work requests among them (default 20)
  --duration <min>     Length of the stream in simulated minutes, before time scaling (default 180)
  --time-scale <x>     Multiplies every time in the stream (default 1; below 1 is a busier chat)
  --configs <list>     Comma-separated: super-agent,no-direct,single-neutral,single-delegate
  --sweep <list>       Time scales for the batching sweep (default 2,1,0.5,0.25,0.1,0.05,0.02,0.01)
  --no-sweep           Skip the sweep
  --help               Show this
`;

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
};

export function parseBenchArgs(argv: string[]): { help: boolean; out: string; options: Partial<BenchOptions> } {
  const { values } = parseArgs({
    args: argv,
    options: {
      reduced: { type: 'boolean' },
      out: { type: 'string' },
      seed: { type: 'string' },
      messages: { type: 'string' },
      requests: { type: 'string' },
      duration: { type: 'string' },
      'time-scale': { type: 'string' },
      configs: { type: 'string' },
      sweep: { type: 'string' },
      'no-sweep': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  const ids = CONFIGS.map((c) => c.id);
  const configs = values.configs?.split(',').map((s) => s.trim()) as ConfigId[] | undefined;
  const bad = configs?.filter((c) => !ids.includes(c));
  if (bad?.length) throw new Error(`Unknown configuration: ${bad.join(', ')} (known: ${ids.join(', ')})`);
  const given: Partial<BenchOptions> = {
    seed: values.seed === undefined ? undefined : Math.round(Number(values.seed)),
    messages: num(values.messages, 'messages'),
    requests: num(values.requests, 'requests'),
    durationMin: num(values.duration, 'duration'),
    timeScale: num(values['time-scale'], 'time-scale'),
    configs,
    sweep: values['no-sweep'] ? [] : values.sweep?.split(',').map((s) => num(s.trim(), 'sweep')!),
  };
  // Flags given on top of --reduced; the ones not given leave its values alone.
  const options: Partial<BenchOptions> = { ...(values.reduced ? REDUCED : {}), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
  if (options.seed !== undefined && !Number.isFinite(options.seed)) throw new Error('--seed must be a number');
  return { help: !!values.help, out: values.out || 'bench-results', options };
}

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseBenchArgs>;
  try {
    args = parseBenchArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const started = Date.now();
  const result = await runBench(args.options);
  fs.mkdirSync(args.out, { recursive: true });
  const json = path.join(args.out, 'bench.json');
  const html = path.join(args.out, 'report.html');
  fs.writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(html, renderReport(result));
  const lines = result.summaries.map(
    (s) =>
      `  ${s.label.padEnd(36)} completion p50 ${String(s.completionMin.p50 ?? '–').padStart(6)} min, p95 ${String(s.completionMin.p95 ?? '–').padStart(6)} min · decisions ${String(s.coordinator.decided).padStart(4)} · context read ${String(s.tokens.contextRead).padStart(9)}`,
  );
  const d = result.directRouting;
  process.stdout.write(
    [
      `Crew ablation bench: ${result.options.messages} events, seed ${result.options.seed}, time scale ${result.options.timeScale} (${Date.now() - started} ms)`,
      ...lines,
      ...(d
        ? [
            `  direct routing, (a) vs (b): Router decisions ${d.routerDecisionsPct ?? '–'}%, Router context read ${d.routerContextReadPct ?? '–'}%, completion p50 ${d.completionP50DeltaMin ?? '–'} min`,
          ]
        : []),
      `Wrote ${json} and ${html}`,
      '',
    ].join('\n'),
  );
  return 0;
}
