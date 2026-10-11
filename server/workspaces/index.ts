// Isolated workspaces: a chat can work in its own git worktree on its own branch, so several chats
// can change one project at the same time without touching each other's files (the way
// vibe-kanban gives every task attempt a worktree). Each bot turn is committed to that branch;
// the user merges it back into the base branch (squashed into one commit) when it looks right.

import { withChatLocked } from '../orchestrator';
import { doCreate } from './create';
import { doMerge } from './merge';
import { doRemove } from './remove';
import { doSuggest } from './suggest';
import { doAbort, doCommit, doResolve, doSync } from './sync';

export { detachWorkspace, reconcileWorkspaces } from './remove';
export { workspaceDiff, workspaceStatus } from './status';

// ---------------------------------------------------------------- public operations
// One git operation per chat at a time, and never while a bot turn runs or waits there.

export const createWorkspace = (chatId: string) => withChatLocked(chatId, 'switching', () => doCreate(chatId));
export const mergeWorkspace = (chatId: string, message?: string) => withChatLocked(chatId, 'merging', () => doMerge(chatId, message));
export const suggestCommitMessage = (chatId: string) => withChatLocked(chatId, 'generating a commit message', () => doSuggest(chatId));
export const syncWorkspace = (chatId: string) => withChatLocked(chatId, 'syncing', () => doSync(chatId));
export const resolveConflicts = (chatId: string) => withChatLocked(chatId, 'resolving conflicts', () => doResolve(chatId));
export const abortSync = (chatId: string) => withChatLocked(chatId, 'abandoning the sync', () => doAbort(chatId));
export const commitWorkspace = (chatId: string, message: string) => withChatLocked(chatId, 'committing', () => doCommit(chatId, message));
export const removeWorkspace = (chatId: string, deleteBranch: boolean) => withChatLocked(chatId, 'closing the workspace', () => doRemove(chatId, deleteBranch));
