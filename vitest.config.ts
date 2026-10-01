import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Integration tests each start a real server (and sometimes Claude Code): give them room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Modules that read the data folder at import time must never see the real ~/.crew.
    env: { CREW_HOME: path.join(os.tmpdir(), 'crew-unit-home'), CREW_PROJECTS: path.join(os.tmpdir(), 'crew-unit-projects') },
  },
});
