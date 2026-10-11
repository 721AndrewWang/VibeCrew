import type { WorkspaceMergeResult } from '../../shared/types';
import { autoCommit, gitError, isMerging, unresolvedConflicts, zList } from '../gitops';
import { sendUserMessage, systemMessage } from '../orchestrator';
import { gitIn, HttpError } from '../projects';
import { bots } from '../store';
import { count, requireWorkspace, revParse, saveWork } from './common';

/**
 * Brings new commits of the base branch into the workspace. On conflicts the merge is left in
 * progress (with conflict markers in the files) for a bot to resolve; see doResolve.
 */
export async function doSync(chatId: string): Promise<WorkspaceMergeResult> {
  const { chat, info } = requireWorkspace(chatId);
  const baseRef = `refs/heads/${info.baseBranch}`;
  if (await isMerging(info.worktree)) {
    const unresolved = await unresolvedConflicts(info.worktree);
    if (unresolved.length) return { ok: false, conflicts: unresolved };
    // Every conflict is fixed but not committed yet: conclude the merge.
    await saveWork(info, `Crew: sync the latest changes from ${info.baseBranch}`);
    systemMessage(chat, `Finished syncing with ${info.baseBranch}.`);
    return { ok: true, commit: (await revParse(info.worktree, 'HEAD')).slice(0, 7), files: 0 };
  }
  await saveWork(info, 'Crew: save changes before syncing');
  const before = await revParse(info.worktree, 'HEAD');
  if (!(await count(info.worktree, `HEAD..${baseRef}`))) throw new HttpError(409, `Already up to date: ${info.baseBranch} has no new commits`);
  try {
    await gitIn(info.worktree, ['-c', 'commit.gpgsign=false', 'merge', '--no-verify', '--no-edit', '-q', '-m', `Crew: sync the latest changes from ${info.baseBranch}`, baseRef]);
  } catch (e) {
    if (await isMerging(info.worktree)) return { ok: false, conflicts: await unresolvedConflicts(info.worktree) };
    throw new HttpError(500, `Sync failed: ${gitError(e)}`);
  }
  const changed = zList(await gitIn(info.worktree, ['diff', '--name-only', '-z', before, 'HEAD'])).length;
  systemMessage(chat, `Synced the latest changes from ${info.baseBranch} into this workspace (${changed} files).`);
  return { ok: true, commit: (await revParse(info.worktree, 'HEAD')).slice(0, 7), files: changed };
}

/** Starts (or continues) syncing with the base branch and asks the chat's lead bot to fix the conflicts. */
export async function doResolve(chatId: string): Promise<{ started: boolean; conflicts: string[] }> {
  const { chat, info } = requireWorkspace(chatId);
  const r = await doSync(chatId);
  if (r.ok) return { started: false, conflicts: [] };
  const conflicts = r.conflicts;
  const lead = chat.kind === 'group' ? bots.get(chat.leadBotId) || bots.get(chat.botIds[0]) : null;
  const text = [
    lead ? `@${lead.name}` : '',
    `I merged the latest changes from ${info.baseBranch} into the workspace, and these files have conflicts: ${conflicts.join(', ')}.`,
    'Please resolve these conflicts. In text files, remove the <<<<<<< / ======= / >>>>>>> markers and combine both sides according to what each change was meant to do. For binary files, or files deleted on one side and changed on the other, decide which version to keep, then mark it resolved with git add (keep) or git rm (delete). When done, check that the pages and the build still work.',
    'No need to commit yourself: Crew will commit and finish the merge automatically when this round ends.',
  ]
    .filter(Boolean)
    .join('\n');
  sendUserMessage(chat.id, { text });
  return { started: true, conflicts };
}

/** Gives up an unfinished sync, restoring the workspace to before it. */
export async function doAbort(chatId: string) {
  const { chat, info } = requireWorkspace(chatId);
  if (!(await isMerging(info.worktree))) return;
  await gitIn(info.worktree, ['merge', '--abort']);
  systemMessage(chat, `Abandoned this sync with ${info.baseBranch}. The workspace is back to how it was before the sync.`);
}

/** The Git section's "commit all" inside a workspace: same conflict guard as the automatic commits. */
export async function doCommit(chatId: string, message: string) {
  const { info } = requireWorkspace(chatId);
  let r: Awaited<ReturnType<typeof autoCommit>>;
  try {
    r = await autoCommit(info.worktree, message);
  } catch (e) {
    throw new HttpError(500, `Commit failed: ${gitError(e)}`);
  }
  if (r.unresolved?.length) throw new HttpError(409, `There are still unresolved conflicts: ${r.unresolved.join(', ')}`);
}
