import fs from 'node:fs';
import type { Chat, WorkspaceInfo } from '../../shared/types';
import { bus, notify } from '../bus';
import { disposeDevServer } from '../devserver';
import { autoCommit, gitError, statusLines } from '../gitops';
import { logger } from '../log';
import { systemMessage } from '../orchestrator';
import { closePreview } from '../preview';
import { gitIn, HttpError } from '../projects';
import { chats, projects } from '../store';
import { closeProjectTerminals } from '../terminal';
import { stopWatch } from '../watcher';
import { count, emitChat, requireChat, restartBots, type Workspace, workspaceOf } from './common';

const log = logger('workspace');

/** The branch holds work the base branch does not have (or the worktree has uncommitted edits). */
async function hasUnmergedWork(info: WorkspaceInfo): Promise<boolean> {
  try {
    if (fs.existsSync(info.worktree) && (await statusLines(info.worktree)).length) return true;
    return (await count(info.repo, `refs/heads/${info.baseBranch}..refs/heads/${info.branch}`)) > 0;
  } catch {
    return true;
  }
}

/** Stops what runs in a workspace: dev server, preview, terminals, file watching. */
async function stopServices(ws: Workspace) {
  await disposeDevServer(ws.id).catch(() => {});
  closePreview(ws.id);
  closeProjectTerminals(ws.id);
  await stopWatch(ws.id).catch(() => {});
}

function unregister(ws: Workspace) {
  projects.delete(ws.id);
  bus.emit({ t: 'project_deleted', id: ws.id });
}

/**
 * Removes a workspace's worktree (and its branch when asked). When the branch is kept, the work is
 * committed to it first; if that is not possible nothing is touched and the error is thrown.
 */
async function disposeWorkspace(ws: Workspace, deleteBranch: boolean) {
  const info = ws.workspace;
  const exists = fs.existsSync(info.worktree);
  if (exists && !deleteBranch) {
    let r: Awaited<ReturnType<typeof autoCommit>>;
    try {
      r = await autoCommit(info.worktree, 'Crew：关闭工作区前保存改动');
    } catch (e) {
      throw new HttpError(500, `没能把工作区里的改动提交到分支（${gitError(e)}），为了不丢失改动，工作区没有关闭。`);
    }
    if (r.unresolved?.length) throw new HttpError(409, `工作区里还有冲突没解决（${r.unresolved.join('、')}），关闭会丢掉这些改动。先解决冲突，或者选择丢弃分支。`);
  }
  await stopServices(ws);
  if (exists) {
    // Everything that matters is committed (or being discarded); what is left are ignored files.
    await gitIn(info.repo, ['worktree', 'remove', '--force', info.worktree]).catch(() => fs.rmSync(info.worktree, { recursive: true, force: true }));
  }
  await gitIn(info.repo, ['worktree', 'prune']).catch(() => {});
  if (deleteBranch) await gitIn(info.repo, ['branch', '-D', info.branch]).catch((e) => log.warn('delete branch:', gitError(e)));
  unregister(ws);
}

/** The user closes the workspace: the chat goes back to the project folder. */
export async function doRemove(chatId: string, deleteBranch: boolean) {
  const chat = requireChat(chatId);
  const ws = workspaceOf(chat);
  if (!ws) throw new HttpError(404, '这个对话没有独立工作区');
  const { branch } = ws.workspace;
  const keep = !deleteBranch && (await hasUnmergedWork(ws.workspace));
  await disposeWorkspace(ws, !keep);
  chat.workspaceId = null;
  restartBots(chat);
  emitChat(chat);
  systemMessage(chat, keep ? `已关闭独立工作区，分支 ${branch} 保留在仓库里，里面有还没合并的改动。机器人回到项目目录工作。` : `已关闭独立工作区并删除分支 ${branch}，机器人回到项目目录工作。`);
}

/**
 * A workspace whose chat is gone or moved to another project. A branch with unmerged work is kept;
 * if that work cannot be committed, the worktree stays on disk and the user is told where.
 */
async function retire(ws: Workspace) {
  const keep = await hasUnmergedWork(ws.workspace);
  try {
    await disposeWorkspace(ws, !keep);
  } catch (e) {
    await stopServices(ws);
    unregister(ws);
    const body = `${(e as Error).message} 目录保留在 ${ws.workspace.worktree}（分支 ${ws.workspace.branch}）。`;
    log.warn(body);
    notify('独立工作区没有删除', body, { level: 'warn' });
  }
}

/** The chat is deleted or moved to another project: its workspace goes away in the background. */
export function detachWorkspace(chat: Chat) {
  const ws = workspaceOf(chat);
  chat.workspaceId = null;
  if (ws) void retire(ws).catch((e) => log.warn('retire:', gitError(e)));
}

/** Startup: drop workspaces whose chat is gone, and chats whose worktree was deleted by hand. */
export async function reconcileWorkspaces() {
  for (const p of projects.all()) {
    if (!p.workspace) continue;
    const ws = p as Workspace;
    const chat = chats.get(ws.workspace.chatId);
    if (!chat || chat.workspaceId !== ws.id) {
      await retire(ws).catch((e) => log.warn('cleanup:', gitError(e)));
      continue;
    }
    if (!fs.existsSync(ws.workspace.worktree)) {
      await gitIn(ws.workspace.repo, ['worktree', 'prune']).catch(() => {});
      projects.delete(ws.id);
      chat.workspaceId = null;
      restartBots(chat);
      chats.set(chat);
      systemMessage(chat, `找不到独立工作区的目录（${ws.workspace.worktree}），已切回项目目录。分支 ${ws.workspace.branch} 还在仓库里。`);
    }
  }
  for (const c of chats.all()) {
    if (c.workspaceId && !projects.get(c.workspaceId)?.workspace) {
      c.workspaceId = null;
      chats.set(c);
    }
  }
}
