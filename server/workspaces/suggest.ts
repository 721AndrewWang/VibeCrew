import { spawn } from 'node:child_process';
import os from 'node:os';
import { modelEnv } from '../claudeAuth';
import { cleanEnv, findClaudeExecutable } from '../config';
import { configOf, gitIn, HttpError } from '../projects';
import { messages } from '../store';
import { requireWorkspace, revParse, saveWork } from './common';

const SUGGEST_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 60_000;

/**
 * A commit message for everything the workspace would merge, written by the model: it follows
 * the project's commit guide, else the style of the recent commits on the base branch.
 */
export async function doSuggest(chatId: string): Promise<string> {
  const { chat, ws, info } = requireWorkspace(chatId);
  const cli = findClaudeExecutable();
  if (!cli) throw new HttpError(400, '没有找到 Claude Code，没法生成提交说明');
  await saveWork(info, 'Crew：保存改动');
  const baseHead = await revParse(info.repo, `refs/heads/${info.baseBranch}`);
  const head = await revParse(info.worktree, 'HEAD');
  const range = `${baseHead}...${head}`;
  const stat = (await gitIn(info.repo, ['diff', '--stat=120', range])).trim();
  if (!stat) throw new HttpError(409, `没有需要合并的改动，${info.baseBranch} 已经包含这个分支的全部内容`);
  let diff = await gitIn(info.repo, ['-c', 'core.quotePath=false', 'diff', '--no-color', '-U2', range]);
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[… diff truncated …]`;
  const recent = (await gitIn(info.repo, ['log', '-12', '--no-merges', '--format=%s', baseHead]).catch(() => '')).trim();
  const asked = messages
    .sorted(chat.id)
    .filter((m) => m.role === 'user' && m.text.trim())
    .slice(-6)
    .map((m) => `- ${m.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  const guide = configOf(ws).commitGuide;
  const prompt = [
    'Write the git commit message for the change below. It becomes one squash commit.',
    guide
      ? `This repository's rules for commit messages:\n${guide}`
      : 'Match the language and style of the recent commits: a short subject line, then a blank line and a brief body on what changed and why.',
    recent && `Recent commit subjects on ${info.baseBranch}:\n${recent}`,
    asked && `What the user asked for in this chat (context only):\n${asked}`,
    `Files changed:\n${stat}`,
    `Diff:\n${diff}`,
    'Reply with the commit message only: no preamble, no code fences, no Co-Authored-By or other AI attribution.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const out = await new Promise<string>((resolve, reject) => {
    // In a neutral folder, so the project's own Claude Code hooks do not run for this.
    const child = spawn(cli, ['-p', '--output-format', 'json', '--max-turns', '1', '--model', 'sonnet'], {
      cwd: os.tmpdir(),
      env: cleanEnv(modelEnv()),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SUGGEST_TIMEOUT_MS);
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
        resolve(String(j.result || ''));
      } catch {
        reject(new Error(code === null ? '等了 2 分钟没有回应' : stderr.trim().split('\n').slice(-2).join(' ') || `Claude Code 退出码 ${code}`));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  }).catch((e: Error) => {
    throw new HttpError(502, `没能生成提交说明：${e.message}`);
  });
  const text = out
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .split('\n')
    .filter((l) => !/^(co-authored-by|generated with|🤖)/i.test(l.trim()))
    .join('\n')
    .trim();
  if (!text) throw new HttpError(502, '模型返回了空的提交说明，请再试一次');
  return text;
}
