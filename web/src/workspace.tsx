// Isolated workspaces: a chat's own git branch and worktree (see server/workspaces/).

import type { Chat, WorkspaceStatus } from '../../shared/types';
import { api } from './api';
import { confirmDialog } from './components/ui';
import { setComputer, toast, useStore } from './store';

/** Moves a chat into its own git branch and worktree. */
export async function enableWorkspace(chat: Chat, opts: { confirm?: boolean } = {}): Promise<boolean> {
  if (opts.confirm !== false) {
    const ok = await confirmDialog({
      title: 'Work on a separate branch?',
      body: (
        <>
          Crew will create a Git branch and a separate working directory (git worktree) for this chat. Bots edit code there without touching the main project directory or other chats, so several tasks
          can safely run in parallel. When you're happy with the result, merge it back into the main branch from Changes on the right.
          <br />
          <br />
          Bots will start fresh sessions in the new directory, carrying over the recent chat.
        </>
      ),
      ok: 'Create branch',
    });
    if (!ok) return false;
  }
  try {
    const ws = await api.createWorkspace(chat.id);
    useStore.setState((s) => ({ projects: { ...s.projects, [ws.id]: ws } }));
    toast('Now in an isolated workspace', ws.workspace?.branch, 'success');
    return true;
  } catch (e) {
    toast("Couldn't create isolated workspace", (e as Error).message, 'error');
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
  const what = st?.files.length ? `changes to ${st.files.length} file${st.files.length === 1 ? '' : 's'}` : 'changes';
  let body: string;
  if (opts.discard) body = `Branch ${st?.branch ?? ''} and the workspace directory will be deleted${pending ? `, and unmerged ${what} will be lost` : ''}. `;
  else if (pending)
    body = `Branch ${st!.branch} has ${what} not yet merged into ${st!.baseBranch}. The workspace directory will be deleted, but the branch stays in the repo so you can merge it manually later. `;
  else body = 'All changes on this branch are merged. The workspace directory and branch will both be deleted. ';
  const ok = await confirmDialog({
    title: opts.discard ? 'Discard this branch?' : 'Close isolated workspace?',
    body: `${body}Bots will go back to working in the main project directory.`,
    ok: opts.discard ? 'Discard and delete' : 'Close workspace',
    danger: !!opts.discard || pending,
  });
  if (!ok) return false;
  try {
    await api.removeWorkspace(chat.id, !!opts.discard);
    toast(opts.discard ? 'Branch discarded' : 'Isolated workspace closed', undefined, 'success');
    return true;
  } catch (e) {
    toast('Close failed', (e as Error).message, 'error');
    return false;
  }
}

export function showWorkspaceChanges() {
  setComputer({ open: true, tab: 'changes' });
  useStore.setState({ mobilePane: 'computer' });
}
