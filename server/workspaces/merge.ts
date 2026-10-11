import type { WorkspaceMergeResult } from '../../shared/types';
import { gitError, isMerging, zList } from '../gitops';
import { logger } from '../log';
import { projectRunning, systemMessage } from '../orchestrator';
import { configOf, gitIn, HttpError } from '../projects';
import { challengeBlocker } from '../review';
import { count, emitProject, requireWorkspace, revParse, saveWork } from './common';

const log = logger('workspace');

/** Where a branch is checked out (the main checkout, usually), or null. */
async function checkoutOf(repo: string, branch: string): Promise<string | null> {
  const out = await gitIn(repo, ['worktree', 'list', '--porcelain']);
  let current = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/** Merges two commits without touching any working tree. */
async function trialMerge(repo: string, ours: string, theirs: string): Promise<{ tree: string } | { conflicts: string[] }> {
  try {
    return { tree: zList(await gitIn(repo, ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, theirs]))[0] };
  } catch (e) {
    // Exit code 1: conflicts. The output still starts with the tree, followed by the conflicted paths.
    const tokens = zList(String((e as { stdout?: string }).stdout || ''));
    if (!/^[0-9a-f]{40,64}$/.test(tokens[0] || '')) throw new HttpError(500, `Merge failed: ${gitError(e)}`);
    return { conflicts: [...new Set(tokens.slice(1))] };
  }
}

/** Files git names (tab-indented) when it refuses to overwrite local changes. */
function listedFiles(e: unknown): string[] {
  return String((e as { stderr?: string }).stderr || '')
    .split('\n')
    .filter((l) => l.startsWith('\t'))
    .map((l) => l.trim());
}

/**
 * Squash-merges the workspace branch into its base branch as one commit. The merge is computed
 * without a working tree; the base branch's checkout (usually the project folder) is then
 * fast-forwarded, which git refuses if that would overwrite uncommitted changes there.
 */
export async function doMerge(chatId: string, message?: string): Promise<WorkspaceMergeResult> {
  const { chat, ws, info } = requireWorkspace(chatId);
  if (projectRunning(info.parentId)) throw new HttpError(409, 'A bot is working in the main project folder. Wait for its round to finish, then merge');
  if (await isMerging(info.worktree)) throw new HttpError(409, `The workspace is in the middle of syncing ${info.baseBranch}. Merge once the conflicts are resolved and committed`);
  await saveWork(info, 'Crew: save changes before merging');

  const baseRef = `refs/heads/${info.baseBranch}`;
  const baseHead = await revParse(info.repo, baseRef).catch(() => {
    throw new HttpError(400, `Can't find branch ${info.baseBranch}`);
  });
  const head = await revParse(info.worktree, 'HEAD');
  if (!(await count(info.repo, `${baseHead}..${head}`))) throw new HttpError(409, `Nothing to merge: ${info.baseBranch} already contains everything on this branch`);

  const trial = await trialMerge(info.repo, baseHead, head);
  if ('conflicts' in trial) return { ok: false, conflicts: trial.conflicts };
  if (trial.tree === (await revParse(info.repo, `${baseHead}^{tree}`))) throw new HttpError(409, `Nothing to merge: ${info.baseBranch} already has these changes`);

  const conf = configOf(ws);
  if (conf.requireChallenge) {
    const blocked = challengeBlocker(info.challenge, head);
    if (blocked) throw new HttpError(409, blocked);
  }
  const typed = message?.trim();
  let body: string;
  if (conf.commitGuide) {
    // The project has its own rules: the message as written (or generated), nothing added.
    if (!typed) throw new HttpError(400, 'This project has rules for commit messages. Write a merge message first, or click Generate to write one that follows them.');
    body = typed;
  } else {
    const subjects = (await gitIn(info.repo, ['log', '--no-merges', '--format=%s', `${baseHead}..${head}`])).split('\n').filter((s) => s && !/^(Vibe)?Crew:/.test(s));
    const footer = conf.noAttribution ? [] : ['', `Crew separate workspace ${info.branch}`];
    body = [typed || chat.title, '', ...subjects.slice(0, 40).map((s) => `- ${s}`), ...footer].join('\n');
  }
  let commit: string;
  try {
    commit = (await gitIn(info.repo, ['commit-tree', trial.tree, '-p', baseHead, '-m', body])).trim();
  } catch (e) {
    throw new HttpError(500, `Couldn't create the merge commit: ${gitError(e)}`);
  }

  const checkout = await checkoutOf(info.repo, info.baseBranch);
  try {
    if (checkout) await gitIn(checkout, ['merge', '--ff-only', '-q', commit]);
    // Not checked out anywhere. Unlike update-ref, fetch refuses a branch that is being rebased or
    // bisected, and anything that is not a fast-forward.
    else await gitIn(info.repo, ['fetch', '-q', '.', `${commit}:${baseRef}`]);
  } catch (e) {
    const files = listedFiles(e);
    if (files.length) throw new HttpError(409, `These files in ${checkout} have uncommitted changes that the merge would overwrite: ${files.join(', ')}. Commit or undo those changes, then merge.`);
    if ((await revParse(info.repo, baseRef).catch(() => baseHead)) !== baseHead) throw new HttpError(409, `${info.baseBranch} just got new commits. Please click merge again`);
    if (checkout && (await isMerging(checkout))) throw new HttpError(409, `${checkout} has an unfinished merge. Finish or abort it, then merge`);
    throw new HttpError(409, `Couldn't update ${info.baseBranch} (it may be in the middle of a rebase or bisect): ${gitError(e)}`);
  }

  const changed = zList(await gitIn(info.repo, ['diff', '--name-only', '-z', baseHead, commit])).length;
  // Carry on from the merged state: the branch now matches the base branch.
  await gitIn(info.worktree, ['reset', '-q', '--keep', commit]).catch((e) => log.warn('reset after merge:', gitError(e)));
  ws.workspace.mergedAt = Date.now();
  ws.updatedAt = Date.now();
  emitProject(ws);
  systemMessage(chat, `Merged this workspace's changes (${changed} files) into ${info.baseBranch}, commit ${commit.slice(0, 7)}. The workspace stays open, and later changes will merge on top.`, {
    uiOnly: true,
  });
  return { ok: true, commit: commit.slice(0, 7), files: changed };
}
