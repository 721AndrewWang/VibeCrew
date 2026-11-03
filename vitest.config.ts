import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Test files run in parallel, three per CPU: an integration file spends most of its time waiting on
 * its own server, the demo agent's pacing or Claude Code, not on the CPU. Each worker holds a server
 * and sometimes Claude Code sessions (about 1 GB at most), so memory bounds it too. `--maxWorkers`
 * on the command line overrides it.
 */
const workers = Math.max(2, Math.min(16, os.availableParallelism() * 3, Math.floor(os.totalmem() / 2 ** 30)));

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
