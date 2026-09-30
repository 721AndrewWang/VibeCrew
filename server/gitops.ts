import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn, isBinary } from './projects';

/** git with `input` on stdin; the exit code is returned, not thrown (check-ignore exits 1 when nothing matches). */
export function gitWithInput(dir: string, args: string[], input: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** NUL-separated git output (-z): file names come through as they are, never quoted or escaped. */
export function zList(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** Status entries of a working tree (empty when clean). */
export async function statusLines(dir: string): Promise<string[]> {
  return zList(await gitIn(dir, ['status', '--porcelain=v1', '-z', '-uall']));
}

/** A `git merge` is in progress (stopped at conflicts). */
export async function isMerging(dir: string): Promise<boolean> {
  try {
    await gitIn(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

const CONFLICT_MARKER = /^(<{7}|>{7})(?: |$)/m;

/** null: missing or binary; otherwise whether the text still has conflict markers. */
function markersIn(abs: string): boolean | null {
  try {
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return null;
    return CONFLICT_MARKER.test(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Conflicted files that are not fixed yet. A file git still lists as unmerged counts as fixed
 * only when both sides have it (a content conflict) and it is now text without conflict markers
 * (edited but not `git add`ed). Binary conflicts and modify/delete conflicts leave nothing to
 * edit, so they need an explicit `git add` / `git rm`. Files already added are checked for
 * leftover markers too.
 */
export async function unresolvedConflicts(dir: string): Promise<string[]> {
  const out = new Set<string>();
  // Entries look like "<mode> <object> <stage>\t<path>"; stage 2 is ours, 3 is theirs.
  const stages = new Map<string, Set<string>>();
  for (const entry of zList(await gitIn(dir, ['ls-files', '-u', '-z']).catch(() => ''))) {
    const tab = entry.indexOf('\t');
    const rel = entry.slice(tab + 1);
    if (!stages.has(rel)) stages.set(rel, new Set());
    stages.get(rel)!.add(entry.slice(0, tab).split(' ')[2]);
  }
  for (const [rel, s] of stages) {
    const editable = s.has('2') && s.has('3');
    if (!editable || markersIn(path.join(dir, rel)) !== false) out.add(rel);
  }
  for (const rel of zList(await gitIn(dir, ['diff', '--name-only', '-z', 'HEAD']).catch(() => ''))) {
    if (markersIn(path.join(dir, rel)) === true) out.add(rel);
  }
  return [...out].sort();
}

/**
 * Refuses to work on a folder that is no longer the worktree's top level (deleted and recreated
 * as a plain folder): git would walk up and commit some enclosing repository instead.
 */
async function assertTopLevel(dir: string) {
  const top = (await gitIn(dir, ['rev-parse', '--show-toplevel'])).trim();
  if (fs.realpathSync(top) !== fs.realpathSync(dir)) throw new Error(`${dir} 不是工作区的根目录`);
}

/**
 * Commits everything in a workspace worktree. These commits live on the chat's own branch and are
 * squashed when merged, so hooks and signing are skipped. A merge in progress is concluded (even
 * with no changes left) once every conflict is fixed, and left alone otherwise.
 */
export async function autoCommit(dir: string, message: string): Promise<{ commit: string | null; unresolved?: string[] }> {
  await assertTopLevel(dir);
  if (await isMerging(dir)) {
    const unresolved = await unresolvedConflicts(dir);
    if (unresolved.length) return { commit: null, unresolved };
  } else if (!(await statusLines(dir)).length) {
    return { commit: null };
  }
  await gitIn(dir, ['add', '-A']);
  await gitIn(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]);
  return { commit: (await gitIn(dir, ['rev-parse', 'HEAD'])).trim() };
}

/** The first line of a bot reply, cut down to a commit subject. */
export function commitSubject(text: string, fallback: string): string {
  const line =
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .split('\n')
      .map((l) => l.replace(/[#>*_`~]/g, '').trim())
      .find(Boolean) || '';
  return (line.length > 72 ? line.slice(0, 71) + '…' : line) || fallback;
}

/** git's own explanation of a failed command, first line only. */
export function gitError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const text = (err.stderr || err.message || String(e)).trim();
  return text.split('\n').find((l) => /fatal|error|错误|致命/i.test(l))?.replace(/^(fatal|error|致命错误|错误)[:：]\s*/i, '') || text.split('\n')[0];
}
