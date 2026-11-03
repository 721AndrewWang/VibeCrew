// npm run bench:cost: the cost profile of the Super-agent (docs/adr/108-cost-and-latency.md).
//
// Builds the text each role sends besides its conversation with Crew's real code (system prompts,
// the MCP tool definitions as the model receives them, real recall results), runs the ablation
// bench's scenarios with it in place of the bench's stand-ins, and prints model calls and prompt
// sizes per role: Router, Workers, Watchdog, recall and speculation.
//
// Crew's prompt builders import the store, which creates its data folder on import: everything
// runs against a throwaway CREW_HOME that is removed at the end, never ~/.crew.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: npm run bench:cost -- [options]

  --out <dir>        Where to write cost.json (default: bench-results)
  --compare <file>   An earlier cost.json: print the change against it
  --reduced          The bench's small workload (60 events, 5 requests)
  --seed <n>         Workload seed (default 7)
  --help             Show this
`;

/** Claude Code's own system prompt and built-in tool schemas, as the bench assumes (ADR 101). */
const CLAUDE_CODE_TOKENS = 8000;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string' }, compare: { type: 'string' }, reduced: { type: 'boolean' }, seed: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-cost-'));
  process.env.CREW_HOME = home;
  process.env.CREW_LOG_LEVEL ??= 'error';
  try {
    const { buildInputs, recallResults } = await import('./costInputs');
    const { runCost, costTable } = await import('../server/bench/cost');
    const { REDUCED } = await import('../server/bench/index');
    const inputs = await buildInputs(CLAUDE_CODE_TOKENS);
    const opts = { ...(values.reduced ? REDUCED : {}), ...(values.seed ? { seed: Math.round(Number(values.seed)) } : {}) };
    const { result, runs } = await runCost(inputs, opts);
    result.recall.resultTokens = recallResults(runs.get('recall'));
    const before = values.compare ? JSON.parse(fs.readFileSync(values.compare, 'utf8')) : undefined;
    const out = values.out || 'bench-results';
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, 'cost.json');
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${costTable(result, before)}\n\nWrote ${file}\n`);
    return 0;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${(e as Error).stack || e}\n\n${USAGE}`);
    process.exit(1);
  },
);
