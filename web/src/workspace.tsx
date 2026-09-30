// Isolated workspaces: a chat's own git branch and worktree (see server/workspaces.ts).

import type { Chat, WorkspaceStatus } from '../../shared/types';
import { api } from './api';
import { confirmDialog } from './components/ui';
import { setComputer, toast, useStore } from './store';

/** Moves a chat into its own git branch and worktree. */
export async function enableWorkspace(chat: Chat, opts: { confirm?: boolean } = {}): Promise<boolean> {
  if (opts.confirm !== false) {
    const ok = await confirmDialog({
      title: '在独立分支中工作？',
      body: (
        <>
          VibeCrew 会给这个对话新建一个 Git 分支和一份单独的工作目录（git worktree）。机器人在那里改代码，不影响项目主目录和其他对话，多个任务可以放心并行；确认没问题后，在右侧「改动」里合并回主分支。
          <br />
          <br />
          机器人会在新目录里重新开始会话，最近的聊天内容会带过去。
        </>
      ),
      ok: '新建分支',
    });
    if (!ok) return false;
  }
  try {
    const ws = await api.createWorkspace(chat.id);
    useStore.setState((s) => ({ projects: { ...s.projects, [ws.id]: ws } }));
    toast('已进入独立工作区', ws.workspace?.branch, 'success');
    return true;
  } catch (e) {
    toast('没能创建独立工作区', (e as Error).message, 'error');
    return false;
  }
}

/**
 * Leaves the workspace and goes back to the project folder. A branch with unmerged work stays in
 * the repository unless `discard` is set.
 */
export async function closeWorkspace(chat: Chat, opts: { discard?: boolean } = {}): Promise<boolean> {
  let st: WorkspaceStatus | null = null;
  try {
    st = await api.workspace(chat.id);
  } catch {
    /* the worktree is gone; closing still cleans up */
  }
  // Unmerged work: commits the base branch lacks, or uncommitted edits (the file list may be empty).
  const pending = !!st && (st.ahead > 0 || st.dirty);
  const what = st?.files.length ? `${st.files.length} 个文件的改动` : '改动';
  let body: string;
  if (opts.discard) body = `分支 ${st?.branch ?? ''} 和工作区目录都会删除${pending ? `，还没合并的${what}会丢失` : ''}。`;
  else if (pending) body = `分支 ${st!.branch} 上还有${what}没合并到 ${st!.baseBranch}。工作区目录会删除，分支保留在仓库里，以后需要时可以手动合并。`;
  else body = '这个分支的改动都已经合并了，工作区目录和分支会一起删除。';
  const ok = await confirmDialog({
    title: opts.discard ? '丢弃这个分支？' : '关闭独立工作区？',
    body: `${body}机器人会回到项目主目录工作。`,
    ok: opts.discard ? '丢弃并删除' : '关闭工作区',
    danger: !!opts.discard || pending,
  });
  if (!ok) return false;
  try {
    await api.removeWorkspace(chat.id, !!opts.discard);
    toast(opts.discard ? '已丢弃分支' : '已关闭独立工作区', undefined, 'success');
    return true;
  } catch (e) {
    toast('关闭失败', (e as Error).message, 'error');
    return false;
  }
}

export function showWorkspaceChanges() {
  setComputer({ open: true, tab: 'changes' });
  useStore.setState({ mobilePane: 'computer' });
}
