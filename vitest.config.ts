import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Test files run in parallel, two per CPU: an integration file spends most of its time waiting on
 * its own server, the demo agent's pacing or Claude Code, not on the CPU; but the files that drive
 * the real Claude Code start a CLI process per session, and three per CPU starved a 4-CPU CI runner
 * until real-CLI turns hit the 120 s timeout. Each worker holds a server and sometimes Claude Code
 * sessions (up to about 1.5 GB together), so memory bounds it too: 8 workers on a 4-CPU, 16 GB
 * runner. `--maxWorkers` on the command line overrides it.
 */
const GB = 2 ** 30;
const workers = Math.max(2, Math.min(16, os.availableParallelism() * 2, Math.floor(os.totalmem() / (1.5 * GB))));

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Integration tests each start a real server (and sometimes Claude Code): give them room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    maxWorkers: workers,
    // Modules that read the data folder at import time must never see the real ~/.crew.
    env: { CREW_HOME: path.join(os.tmpdir(), 'crew-unit-home'), CREW_PROJECTS: path.join(os.tmpdir(), 'crew-unit-projects') },
  },
});
