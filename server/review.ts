// Adversarial review: a blind reviewer (Bot.blindReview) gets the user's request and the change
// itself, never the authors' explanations, and tries to refute it. Its verdict is recorded against
// the commit it saw, so a project can require "not refuted at this exact commit" before merging.

import type { ChallengeVerdict, Project } from '../shared/types';
import { gitIn } from './projects';

/** Diffs longer than this are summarised by file; the reviewer runs git diff itself for the rest. */
const MAX_DIFF = 60_000;

async function quiet(dir: string, args: string[]): Promise<string> {
  return gitIn(dir, args).catch(() => '');
}

/**
 * The change under review, as the reviewer should see it: a workspace's branch against where it
 * left its base (committed and not), or a project's uncommitted changes, else its last commit.
 */
export async function reviewDiff(project: Project): Promise<{ title: string; diff: string; how: string }> {
  const ws = project.workspace;
  if (ws) {
    const base = (await quiet(ws.worktree, ['merge-base', `refs/heads/${ws.baseBranch}`, 'HEAD'])).trim();
    if (base) return clip(`分支 ${ws.branch} 相对 ${ws.baseBranch} 的全部改动（含未提交的）`, await quiet(ws.worktree, ['diff', '-M', base]), `git diff ${base.slice(0, 12)}`);
  }
  const dirty = await quiet(project.path, ['diff', '-M', 'HEAD']);
  if (dirty.trim()) return clip('还没提交的改动', dirty, 'git diff HEAD');
  return clip('最近一次提交', await quiet(project.path, ['show', '-M', '--format=', 'HEAD']), 'git show --format= HEAD');
}

function clip(title: string, diff: string, how: string) {
  if (diff.length <= MAX_DIFF) return { title, diff, how };
  const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  return { title, diff: `（改动太长，只列出文件；用 ${how} 看具体内容）\n${files.join('\n')}`, how };
}

/** The verdict line the reviewer ends with: 结论：未推翻 / 结论：推翻 N 条. Null when it is missing. */
export function parseVerdict(text: string): { refuted: number } | null {
  const all = [...text.matchAll(/结论[：:]\s*(未推翻|推翻\s*(\d+)\s*条)/g)];
  const last = all.at(-1);
  if (!last) return null;
  return { refuted: last[2] ? Number(last[2]) : 0 };
}

/** Why a workspace may not merge yet under the project's "challenge before merge" rule, or null. */
export function challengeBlocker(verdict: ChallengeVerdict | undefined, head: string): string | null {
  if (!verdict) return '这个项目要求合并前先做对抗审查，还没做过。在对话里输入 /challenge 让 Skeptic 审一次。';
  if (verdict.head !== head) return '上次对抗审查之后分支又有了新提交，要针对最新的改动再审一次（/challenge）。';
  if (verdict.refuted > 0) return `上次对抗审查推翻了 ${verdict.refuted} 条，修好之后再 /challenge 一次。`;
  return null;
}
