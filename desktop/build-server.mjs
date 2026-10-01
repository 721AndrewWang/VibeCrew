// Bundles the TypeScript server into one ESM file for the desktop app.
// Dependencies stay in node_modules (native modules and the Claude Agent SDK load from there).

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  legalComments: 'none',
  logLevel: 'info',
});
