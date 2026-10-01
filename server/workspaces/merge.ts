import type { WorkspaceMergeResult } from '../../shared/types';
import { gitError, isMerging, zList } from '../gitops';
import { logger } from '../log';
import { projectRunning, systemMessage } from '../orchestrator';
import { configOf, gitIn, HttpError } from '../projects';
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
    if (!/^[0-9a-f]{40,64}$/.test(tokens[0] || '')) throw new HttpError(500, `合并失败：${gitError(e)}`);
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
  if (projectRunning(info.parentId)) throw new HttpError(409, '有机器人正在项目主目录里工作，等它这一轮做完再合并');
  if (await isMerging(info.worktree)) throw new HttpError(409, `工作区里正在同步 ${info.baseBranch}，等冲突解决并提交后再合并`);
  await saveWork(info, 'Crew：合并前保存改动');

  const baseRef = `refs/heads/${info.baseBranch}`;
  const baseHead = await revParse(info.repo, baseRef).catch(() => {
    throw new HttpError(400, `找不到分支 ${info.baseBranch}`);
  });
  const head = await revParse(info.worktree, 'HEAD');
  if (!(await count(info.repo, `${baseHead}..${head}`))) throw new HttpError(409, `没有需要合并的改动，${info.baseBranch} 已经包含这个分支的全部内容`);

  const trial = await trialMerge(info.repo, baseHead, head);
  if ('conflicts' in trial) return { ok: false, conflicts: trial.conflicts };
  if (trial.tree === (await revParse(info.repo, `${baseHead}^{tree}`))) throw new HttpError(409, `没有需要合并的改动，${info.baseBranch} 已经包含这些修改`);

  const conf = configOf(ws);
  const typed = message?.trim();
  let body: string;
  if (conf.commitGuide) {
    // The project has its own rules: the message as written (or generated), nothing added.
    if (!typed) throw new HttpError(400, '这个项目对提交信息有要求，请先填写合并说明，或点「生成」按要求写一条。');
    body = typed;
  } else {
    const subjects = (await gitIn(info.repo, ['log', '--no-merges', '--format=%s', `${baseHead}..${head}`])).split('\n').filter((s) => s && !/^(Vibe)?Crew：/.test(s));
    const footer = conf.noAttribution ? [] : ['', `Crew 独立工作区 ${info.branch}`];
    body = [typed || chat.title, '', ...subjects.slice(0, 40).map((s) => `- ${s}`), ...footer].join('\n');
  }
  let commit: string;
  try {
    commit = (await gitIn(info.repo, ['commit-tree', trial.tree, '-p', baseHead, '-m', body])).trim();
  } catch (e) {
    throw new HttpError(500, `没能创建合并提交：${gitError(e)}`);
  }

  const checkout = await checkoutOf(info.repo, info.baseBranch);
  try {
    if (checkout) await gitIn(checkout, ['merge', '--ff-only', '-q', commit]);
    // Not checked out anywhere. Unlike update-ref, fetch refuses a branch that is being rebased or
    // bisected, and anything that is not a fast-forward.
    else await gitIn(info.repo, ['fetch', '-q', '.', `${commit}:${baseRef}`]);
  } catch (e) {
    const files = listedFiles(e);
    if (files.length) throw new HttpError(409, `${checkout} 里这些文件有还没提交的改动，合并会覆盖它们：${files.join('、')}。先提交或撤销这些改动，再合并。`);
    if ((await revParse(info.repo, baseRef).catch(() => baseHead)) !== baseHead) throw new HttpError(409, `${info.baseBranch} 刚刚有了新的提交，请再点一次合并`);
    if (checkout && (await isMerging(checkout))) throw new HttpError(409, `${checkout} 里有一个还没完成的合并，先完成或放弃它再合并`);
    throw new HttpError(409, `没能更新 ${info.baseBranch}（它可能正在 rebase 或 bisect）：${gitError(e)}`);
  }

  const changed = zList(await gitIn(info.repo, ['diff', '--name-only', '-z', baseHead, commit])).length;
  // Carry on from the merged state: the branch now matches the base branch.
  await gitIn(info.worktree, ['reset', '-q', '--keep', commit]).catch((e) => log.warn('reset after merge:', gitError(e)));
  ws.workspace.mergedAt = Date.now();
  ws.updatedAt = Date.now();
  emitProject(ws);
  systemMessage(chat, `已把这个工作区的改动（${changed} 个文件）合并到 ${info.baseBranch}，提交 ${commit.slice(0, 7)}。工作区继续可用，之后的改动会接着合并。`, { uiOnly: true });
  return { ok: true, commit: commit.slice(0, 7), files: changed };
}
