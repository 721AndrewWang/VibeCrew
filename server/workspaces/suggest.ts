import { findClaudeExecutable } from '../config';
import { oneShot } from '../oneShot';
import { configOf, gitIn, HttpError } from '../projects';
import { messages } from '../store';
import { requireWorkspace, revParse, saveWork } from './common';

const MAX_DIFF_CHARS = 60_000;

/**
 * A commit message for everything the workspace would merge, written by the model: it follows
 * the project's commit guide, else the style of the recent commits on the base branch.
 */
export async function doSuggest(chatId: string): Promise<string> {
  const { chat, ws, info } = requireWorkspace(chatId);
  const cli = findClaudeExecutable();
  if (!cli) throw new HttpError(400, "Couldn't find Claude Code, so a commit message can't be generated");
  await saveWork(info, 'Crew: save changes');
  const baseHead = await revParse(info.repo, `refs/heads/${info.baseBranch}`);
  const head = await revParse(info.worktree, 'HEAD');
  const range = `${baseHead}...${head}`;
  const stat = (await gitIn(info.repo, ['diff', '--stat=120', range])).trim();
  if (!stat) throw new HttpError(409, `Nothing to merge: ${info.baseBranch} already contains everything on this branch`);
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
  const out = await oneShot(prompt, { model: 'sonnet' })
    .then((r) => r.text)
    .catch((e: Error) => {
      throw new HttpError(502, `Couldn't generate a commit message: ${e.message}`);
    });
  const text = out
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .split('\n')
    .filter((l) => !/^(co-authored-by|generated with|🤖)/i.test(l.trim()))
    .join('\n')
    .trim();
  if (!text) throw new HttpError(502, 'The model returned an empty commit message. Please try again');
  return text;
}
