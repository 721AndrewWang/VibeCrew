// npm run bench: the Super-agent ablation bench (docs/adr/101-ablation-bench.md).
import { main } from '../server/bench/cli';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${(e as Error).stack || e}\n`);
    process.exit(1);
  },
);
