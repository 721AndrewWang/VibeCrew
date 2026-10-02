// Calling the adversarial reviewer by itself, by fixed rules read off the change: which files it
// touches and how big it is. Not by a model's judgment of risk: deciding whether code is risky is
// a deriving task, where cheap judges are weakest (JEV-as-a-Judge, Li et al., 2026).
//
// It runs once a chain of turns has finished (the chat is idle), at most twice per user message
// (a review, a fix, a second look), never for Skeptic's own turn and never twice for the same state.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AutoChallenge, Bot, Chat, Project } from '../shared/types';

export { DEFAULT_CHALLENGE_MIN_LINES, DEFAULT_CHALLENGE_PATHS, defaultAutoChallenge } from '../shared/challenge';

import { glob } from './agents/permissions';
import { gitIn } from './projects';

/** Automatic reviews per user message. */
export const MAX_PER_REQUEST = 2;

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

/** Why the rules call for a review of this change, in words for the chat; empty when they do not. */
export function ruleReasons(files: ChangedFile[], rules: AutoChallenge): string[] {
  const reasons: string[] = [];
  for (const pattern of rules.paths) {
    const re = glob(pattern.trim());
    const hit = files.filter((f) => re.test(f.path));
    if (hit.length)
      reasons.push(
        `改了 ${hit
          .slice(0, 3)
          .map((f) => f.path)
          .join('、')}${hit.length > 3 ? ` 等 ${hit.length} 个文件` : ''}（规则 ${pattern}）`,
      );
  }
  const lines = files.reduce((n, f) => n + f.added + f.removed, 0);
  if (rules.minLines > 0 && lines >= rules.minLines) reasons.push(`一共改了 ${lines} 行（规则：至少 ${rules.minLines} 行）`);
  return reasons;
}

/** Parses `git diff --numstat`; binary files count as one line each way. */
export function parseNumstat(out: string): ChangedFile[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split('\t');
      return { path: p.join('\t'), added: a === '-' ? 1 : Number(a) || 0, removed: r === '-' ? 1 : Number(r) || 0 };
    });
}

/**
 * The change as the reviewer would see it (a workspace's branch against its base, else the
 * uncommitted changes, new files included), and a key for "the same state".
 */
export async function currentChange(project: Project): Promise<{ files: ChangedFile[]; key: string }> {
  const ws = project.workspace;
  const dir = ws ? ws.worktree : project.path;
  const quiet = (args: string[]) => gitIn(dir, args).catch(() => '');
  let base = 'HEAD';
  if (ws) base = (await quiet(['merge-base', `refs/heads/${ws.baseBranch}`, 'HEAD'])).trim() || 'HEAD';
  const files = parseNumstat(await quiet(['diff', '--numstat', base]));
  for (const rel of (await quiet(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)) {
    let lines = 1;
    try {
      lines = fs.readFileSync(path.join(dir, rel), 'utf8').split('\n').length;
    } catch {
      /* binary or gone: one line */
    }
    files.push({ path: rel, added: lines, removed: 0 });
  }
  const head = (await quiet(['rev-parse', 'HEAD'])).trim();
  const key = createHash('sha1').update(head).update(JSON.stringify(files)).digest('hex');
  return { files, key };
}

/** The reviewer to call: a Skeptic made from the template, else another blind reviewer with a verdict line. */
export function findSkeptic(all: Bot[]): Bot | undefined {
  return all.find((b) => b.template === 'skeptic') || all.find((b) => b.blindReview && b.description.includes('结论：'));
}

interface ChatState {
  /** Automatic reviews since the user last spoke. */
  count: number;
  /** The last state reviewed automatically. */
  lastKey?: string;
}
const state = new Map<string, ChatState>();

/** The user spoke: a new request, a fresh allowance. */
export function resetAutoChallenge(chatId: string) {
  const s = state.get(chatId);
  if (s) s.count = 0;
}

/**
 * Whether to call the reviewer now, and why. The caller checks that the chat is idle and that the
 * turn that just ended was not the reviewer's own.
 */
export async function autoChallengeReasons(chat: Chat, project: Project, rules: AutoChallenge | undefined): Promise<string[] | null> {
  if (!rules?.enabled) return null;
  const s = state.get(chat.id) || { count: 0 };
  state.set(chat.id, s);
  if (s.count >= MAX_PER_REQUEST) return null;
  const { files, key } = await currentChange(project);
  if (!files.length || key === s.lastKey) return null;
  const reasons = ruleReasons(files, rules);
  if (!reasons.length) return null;
  s.count += 1;
  s.lastKey = key;
  return reasons;
}
