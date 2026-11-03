// The `gh` CLI the user already has (ADR 102): read-only `gh api` GETs, in Crew's own process with
// the user's environment (their login and token), never in an agent session. Tests put a fake `gh`
// on PATH that answers from fixture files.

import { execFile } from 'node:child_process';
import { cleanEnv } from '../config';

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export class GhError extends Error {}

/** `gh api <path>` (a GET), parsed as JSON. Throws GhError with what gh said. */
export function ghApi(apiPath: string, cwd?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', apiPath],
      { cwd, env: cleanEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return reject(new GhError('The gh command was not found. Install GitHub CLI and run "gh auth login".'));
          const said = `${stderr || ''}${stdout || ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 400);
          return reject(new GhError(said || err.message));
        }
        try {
          resolve(JSON.parse(stdout || 'null'));
        } catch {
          reject(new GhError(`gh api ${apiPath.split('?')[0]} did not return JSON`));
        }
      },
    );
  });
}
