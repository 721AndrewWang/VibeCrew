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

export async function oneShot(prompt: string, opts: { model?: string; timeoutMs?: number } = {}): Promise<OneShotResult> {
  const cli = findClaudeExecutable();
  if (!cli) throw new Error('没有找到 Claude Code');
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise<OneShotResult>((resolve, reject) => {
    // In a neutral folder, so no project's own Claude Code hooks or settings run for this.
    const child = spawn(cli, ['-p', '--output-format', 'json', '--max-turns', '1', '--model', opts.model || 'sonnet'], {
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
        if (j.is_error || j.subtype !== 'success') return reject(new Error(String(j.result || '模型没有给出结果')));
        resolve({ text: String(j.result || ''), costUsd: Number(j.total_cost_usd) || 0 });
      } catch {
        reject(new Error(code === null ? `等了 ${Math.round(timeoutMs / 60_000)} 分钟没有回应` : stderr.trim().split('\n').slice(-2).join(' ') || `Claude Code 退出码 ${code}`));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
