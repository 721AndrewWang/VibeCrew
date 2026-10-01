import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo, WorkspaceStatus } from '../../shared/types';
import { isMerging, statusLines, zList } from '../gitops';
import { gitIn, HttpError } from '../projects';
import { requireWorkspace } from './common';

async function mergeBase(info: WorkspaceInfo): Promise<string> {
  return (await gitIn(info.worktree, ['merge-base', `refs/heads/${info.baseBranch}`, 'HEAD'])).trim();
}

const STATUS: Record<string, WorkspaceStatus['files'][number]['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };

export async function workspaceStatus(chatId: string): Promise<WorkspaceStatus> {
  const { ws, info } = requireWorkspace(chatId);
  const [counts, dirty, merging] = await Promise.all([
    gitIn(info.worktree, ['rev-list', '--left-right', '--count', `refs/heads/${info.baseBranch}...HEAD`]).catch(() => '0\t0'),
    statusLines(info.worktree),
    isMerging(info.worktree),
  ]);
  const [behind, ahead] = counts
    .trim()
    .split(/\s+/)
    .map((n) => Number(n) || 0);
  const files: WorkspaceStatus['files'] = [];
  const base = await mergeBase(info).catch(() => '');
  if (base) {
    // The whole repository: a monorepo package's branch may change files outside its folder. The
    // working tree is compared, so uncommitted edits count too.
    const tokens = zList(await gitIn(info.worktree, ['diff', '--name-status', '-z', '-M', base]).catch(() => ''));
    for (let i = 0; i < tokens.length; ) {
      const code = tokens[i];
      if (code[0] === 'R' || code[0] === 'C') {
        files.push({ path: tokens[i + 2], status: STATUS[code[0]] });
        i += 3;
      } else {
        files.push({ path: tokens[i + 1], status: STATUS[code[0]] || 'modified' });
        i += 2;
      }
    }
    for (const p of zList(await gitIn(info.worktree, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''))) files.push({ path: p, status: 'added' });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    branch: info.branch,
    baseBranch: info.baseBranch,
    path: ws.path,
    prefix: path.relative(info.worktree, ws.path).split(path.sep).join('/'),
    ahead,
    behind,
    dirty: dirty.length > 0,
    files,
    merging,
    mergedAt: info.mergedAt,
  };
}

/** Unified diff of one file (path from the repository's top) between where the branch started and now. */
export async function workspaceDiff(chatId: string, rel: string): Promise<string> {
  const { info } = requireWorkspace(chatId);
  const root = path.resolve(info.worktree);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new HttpError(400, '路径超出工作区');
  const base = await mergeBase(info);
  const out = await gitIn(root, ['diff', '-M', base, '--', rel]).catch(() => '');
  if (out) return out;
  try {
    const content = fs.readFileSync(abs, 'utf8');
    return (
      `--- /dev/null\n+++ b/${rel}\n` +
      content
        .split('\n')
        .map((l) => '+' + l)
        .join('\n')
    );
  } catch {
    return '';
  }
}
