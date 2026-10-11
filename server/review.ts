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
    if (base)
      return clip(`All changes on branch ${ws.branch} relative to ${ws.baseBranch} (including uncommitted ones)`, await quiet(ws.worktree, ['diff', '-M', base]), `git diff ${base.slice(0, 12)}`);
  }
  const dirty = await quiet(project.path, ['diff', '-M', 'HEAD']);
  if (dirty.trim()) return clip('Uncommitted changes', dirty, 'git diff HEAD');
  return clip('Latest commit', await quiet(project.path, ['show', '-M', '--format=', 'HEAD']), 'git show --format= HEAD');
}

function clip(title: string, diff: string, how: string) {
  if (diff.length <= MAX_DIFF) return { title, diff, how };
  const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  return { title, diff: `(The diff is too long, so only the files are listed; use ${how} to see the details)\n${files.join('\n')}`, how };
}

/** The verdict line the reviewer ends with: Verdict: not refuted / Verdict: refuted N. Null when it is missing. */
export function parseVerdict(text: string): { refuted: number } | null {
  const all = [...text.matchAll(/Verdict:\s*(not refuted|refuted\s*(\d+))/gi)];
  const last = all.at(-1);
  if (!last) return null;
  return { refuted: last[2] ? Number(last[2]) : 0 };
}

/** Why a workspace may not merge yet under the project's "challenge before merge" rule, or null. */
export function challengeBlocker(verdict: ChallengeVerdict | undefined, head: string): string | null {
  if (!verdict) return "This project requires an adversarial review before merging, and there hasn't been one yet. Type /challenge in the chat to have the Skeptic review it.";
  if (verdict.head !== head) return 'The branch has new commits since the last adversarial review, so it needs another review of the latest changes (/challenge).';
  if (verdict.refuted > 0) return `The last adversarial review refuted ${verdict.refuted} claim(s). Fix them, then run /challenge again.`;
  return null;
}
