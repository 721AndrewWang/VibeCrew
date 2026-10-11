// One prompt, one answer, through the user's Claude Code: for small side jobs (commit messages,
// improvement proposals) that need no tools, no session and no project.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { modelEnv } from './claudeAuth';
import { cleanEnv, findClaudeExecutable } from './config';

export interface OneShotResult {
  text: string;
  costUsd: number;
}

/**
 * Bare: no tools, a one-line system prompt, no user or project settings, no MCP servers, nothing
 * saved. Claude Code's own system prompt and tool definitions are ~29k tokens; without them a
 * small Haiku call costs about $0.001 instead of $0.06.
 */
const BARE = ['--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];

export async function oneShot(prompt: string, opts: { model?: string; timeoutMs?: number; system?: string } = {}): Promise<OneShotResult> {
  const cli = findClaudeExecutable();
  if (!cli) throw new Error('Claude Code not found');
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise<OneShotResult>((resolve, reject) => {
    // In a neutral folder, so no project's own Claude Code hooks or settings run for this.
    const args = [
      '-p',
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--model',
      opts.model || 'sonnet',
      ...BARE,
      '--system-prompt',
      opts.system || 'Answer as asked, and output only what was asked for.',
    ];
    const child = spawn(cli, args, {
      cwd: os.tmpdir(),
      env: cleanEnv(modelEnv()),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(stdout.trim().split('\n').pop() || '');
        if (j.is_error || j.subtype !== 'success') return reject(new Error(String(j.result || 'The model gave no result')));
        resolve({ text: String(j.result || ''), costUsd: Number(j.total_cost_usd) || 0 });
      } catch {
        reject(new Error(code === null ? `No response after ${Math.round(timeoutMs / 60_000)} min` : stderr.trim().split('\n').slice(-2).join(' ') || `Claude Code exit code ${code}`));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
