import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthStatus } from '../shared/types';
import { bus } from './bus';
import { cleanEnv, findClaudeExecutable } from './config';
import { settings } from './store';

const run = promisify(execFile);

let cached: AuthStatus = { cliFound: false, loggedIn: false, method: 'unknown', ready: false, checkedAt: 0 };
let inflight: Promise<AuthStatus> | null = null;

export function authStatus(): AuthStatus {
  return cached;
}

/** Asks the Claude Code CLI whether it can make requests (no model call involved). */
export async function checkAuth(force = false): Promise<AuthStatus> {
  if (!force && Date.now() - cached.checkedAt < 60_000) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // A forced check (the 重新检测 button) also looks for a CLI installed since the last check.
    const cli = findClaudeExecutable(force);
    const s = settings.get();
    const usingKey = s.authMode === 'api-key' && !!s.apiKey;
    const next: AuthStatus = { cliFound: !!cli, cliPath: cli || undefined, loggedIn: false, method: 'none', ready: false, checkedAt: Date.now() };
    if (cli) {
      const env = cleanEnv(usingKey ? { ANTHROPIC_API_KEY: s.apiKey } : {});
      try {
        const { stdout } = await run(cli, ['--version'], { env, timeout: 15_000 });
        next.cliVersion = stdout.trim().split(/\s/)[0];
      } catch {
        /* version is informational */
      }
      try {
        const { stdout } = await run(cli, ['auth', 'status'], { env, timeout: 15_000 });
        const j = JSON.parse(stdout);
        next.loggedIn = !!j.loggedIn;
        next.method = String(j.authMethod || (j.loggedIn ? 'unknown' : 'none'));
      } catch (e) {
        // Older CLIs print text; a non-zero exit means "not logged in".
        const out = String((e as { stdout?: string }).stdout || '');
        try {
          const j = JSON.parse(out);
          next.loggedIn = !!j.loggedIn;
          next.method = String(j.authMethod || 'none');
        } catch {
          next.method = 'unknown';
        }
      }
      if (usingKey) {
        next.loggedIn = true;
        next.method = 'api-key';
      }
    }
    next.ready = next.cliFound && next.loggedIn;
    const changed = next.ready !== cached.ready || next.loggedIn !== cached.loggedIn || next.cliFound !== cached.cliFound;
    cached = next;
    if (changed) bus.emit({ t: 'auth', auth: next });
    return next;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
