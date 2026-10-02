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
    await saveWork(info, `Crew：同步 ${info.baseBranch} 的最新改动`);
    systemMessage(chat, `已完成和 ${info.baseBranch} 的同步。`);
    return { ok: true, commit: (await revParse(info.worktree, 'HEAD')).slice(0, 7), files: 0 };
  }
  await saveWork(info, 'Crew：同步前保存改动');
  const before = await revParse(info.worktree, 'HEAD');
  if (!(await count(info.worktree, `HEAD..${baseRef}`))) throw new HttpError(409, `已经是最新的了，${info.baseBranch} 没有新的提交`);
  try {
    await gitIn(info.worktree, ['-c', 'commit.gpgsign=false', 'merge', '--no-verify', '--no-edit', '-q', '-m', `Crew：同步 ${info.baseBranch} 的最新改动`, baseRef]);
  } catch (e) {
    if (await isMerging(info.worktree)) return { ok: false, conflicts: await unresolvedConflicts(info.worktree) };
    throw new HttpError(500, `同步失败：${gitError(e)}`);
  }
  const changed = zList(await gitIn(info.worktree, ['diff', '--name-only', '-z', before, 'HEAD'])).length;
  systemMessage(chat, `已把 ${info.baseBranch} 的最新改动同步到这个工作区（${changed} 个文件）。`);
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
    `我在工作区里合并了 ${info.baseBranch} 的最新改动，这些文件有冲突：${conflicts.join('、')}。`,
    '请处理这些冲突：文本文件里的 <<<<<<< / ======= / >>>>>>> 标记要去掉，两边的改动按意图合在一起；二进制文件，或者一边删除一边修改的文件，决定保留哪个版本后用 git add（保留）或 git rm（删除）标记为已解决。改完检查一下页面和构建是否正常。',
    '不需要自己提交，Crew 会在这一轮结束后自动提交并完成这次合并。',
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
  systemMessage(chat, `已放弃这次和 ${info.baseBranch} 的同步，工作区恢复到同步之前的样子。`);
}

/** The Git section's "commit all" inside a workspace: same conflict guard as the automatic commits. */
export async function doCommit(chatId: string, message: string) {
  const { info } = requireWorkspace(chatId);
  let r: Awaited<ReturnType<typeof autoCommit>>;
  try {
    r = await autoCommit(info.worktree, message);
  } catch (e) {
    throw new HttpError(500, `提交失败：${gitError(e)}`);
  }
  if (r.unresolved?.length) throw new HttpError(409, `还有冲突没解决：${r.unresolved.join('、')}`);
}
