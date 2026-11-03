import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/types';
import { DATA } from '../config';
import { slugify } from '../data/projectTemplates';
import { statusLines } from '../gitops';
import { systemMessage } from '../orchestrator';
import { configOf, gitIn, HttpError } from '../projects';
import { projects, uid } from '../store';
import { emitChat, emitProject, requireChat, restartBots, saveWork, succeeds, type Workspace, workspaceOf } from './common';
import { copyLocalFiles } from './localFiles';
import { prepareWorkspace } from './setup';

const BRANCH_PREFIX = 'crew/';
/** Merging without a working tree (`git merge-tree --write-tree`) needs Git 2.38. */
const MIN_GIT = [2, 38] as const;

function shortId(): string {
  return uid().slice(0, 4).toLowerCase();
}

async function gitVersion(): Promise<{ ok: boolean; text: string }> {
  try {
    const text = (await gitIn(DATA.worktrees, ['--version'])).trim().replace(/^git version\s*/, '');
    const [major, minor] = (text.match(/^(\d+)\.(\d+)/) || []).slice(1).map(Number);
    return { ok: major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]), text };
  } catch {
    return { ok: false, text: 'not installed' };
  }
}

/** Refuses (with what to do about it) when git cannot give this folder separate workspaces. */
export async function checkGit(dir: string) {
  const version = await gitVersion();
  if (!version.ok) throw new HttpError(400, `Separate workspaces need Git ${MIN_GIT.join('.')} or newer (you have ${version.text}).`);
  if (!(await succeeds(dir, ['rev-parse', '--verify', 'HEAD']))) {
    throw new HttpError(400, "This project isn't a Git repo yet, or it has no commits. Make a commit under Changes on the right, and then you can use separate workspaces.");
  }
  if (!(await succeeds(dir, ['var', 'GIT_COMMITTER_IDENT']))) {
    throw new HttpError(
      400,
      'To commit bot changes to a branch, Git needs your name and email first. Run this in a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com".',
    );
  }
}

/**
 * A new worktree on a new `crew/` branch started at `from`, with the local files the work needs
 * copied in. `prefix` is the project's folder inside the repository ('' at the top). If anything
 * fails, the worktree and branch are taken away again and the error is thrown.
 */
export async function addWorktree(repo: string, from: string, prefix: string, name: string): Promise<{ branch: string; worktree: string; path: string; copied: string[] }> {
  const slug =
    slugify(name)
      .slice(0, 24)
      .replace(/^-+|-+$/g, '') || 'task';
  let branch = `${BRANCH_PREFIX}${slug}-${shortId()}`;
  while (await succeeds(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) branch = `${BRANCH_PREFIX}${slug}-${shortId()}`;
  const worktree = path.join(DATA.worktrees, `${slugify(path.basename(repo)) || 'project'}-${branch.slice(BRANCH_PREFIX.length)}`);
  await gitIn(repo, ['worktree', 'add', '-q', '-b', branch, worktree, from]);
  try {
    const wsPath = path.resolve(worktree, prefix);
    if (!fs.existsSync(wsPath)) {
      throw new HttpError(
        400,
        `The project folder ${prefix.replace(/\/$/, '')} hasn't been committed to Git yet, so the workspace wouldn't have it. Make a commit under Changes on the right and try again.`,
      );
    }
    return { branch, worktree, path: wsPath, copied: await copyLocalFiles(repo, worktree, prefix) };
  } catch (e) {
    // Nothing is registered yet: take the fresh worktree and branch away again.
    await gitIn(repo, ['worktree', 'remove', '--force', worktree]).catch(() => fs.rmSync(worktree, { recursive: true, force: true }));
    await gitIn(repo, ['worktree', 'prune']).catch(() => {});
    await gitIn(repo, ['branch', '-D', branch]).catch(() => {});
    throw e;
  }
}

export async function doCreate(chatId: string): Promise<Project> {
  const chat = requireChat(chatId);
  if (workspaceOf(chat)) throw new HttpError(409, 'This chat is already in a separate workspace');
  const parent = projects.get(chat.projectId);
  if (!parent || parent.workspace) throw new HttpError(400, 'Link a project to this chat first');
  await checkGit(parent.path);
  // The full ref: a tag with the same name would make the short name ambiguous.
  const headRef = (await gitIn(parent.path, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  if (!headRef.startsWith('refs/heads/')) throw new HttpError(400, "The project folder isn't on any branch right now (detached HEAD). Switch to a branch and try again.");
  const baseBranch = headRef.slice('refs/heads/'.length);
  const repo = (await gitIn(parent.path, ['rev-parse', '--show-toplevel'])).trim();
  // Where the project sits in the repository: '' at the top, or a monorepo package folder.
  const prefix = (await gitIn(parent.path, ['rev-parse', '--show-prefix'])).trim();

  const { branch, worktree, path: wsPath, copied } = await addWorktree(repo, 'HEAD', prefix, chat.title);
  const now = Date.now();
  const ws: Workspace = {
    id: uid('p_'),
    name: parent.name,
    path: wsPath,
    createdAt: now,
    updatedAt: now,
    framework: parent.framework,
    workspace: { parentId: parent.id, chatId: chat.id, branch, baseBranch, repo, worktree, createdAt: now },
  };
  emitProject(ws);

  const uncommitted = (await statusLines(parent.path).catch(() => [])).length > 0;
  chat.workspaceId = ws.id;
  restartBots(chat);
  emitChat(chat);
  const notes = [
    `Moved into a separate workspace: new branch ${branch} (branched from ${baseBranch}).`,
    `From now on bots work in this copy, without touching the main folder or other chats. Each round's changes are committed to this branch automatically. Once you're happy with them, merge them back into ${baseBranch} under Changes on the right.`,
  ];
  if (uncommitted) notes.push(`Uncommitted changes in the main folder are not brought into the workspace.`);
  if (copied.length) notes.push(`Brought along local files that aren't in git: ${copied.slice(0, 8).join(', ')}${copied.length > 8 ? ` and more (${copied.length} in all)` : ''}.`);
  systemMessage(chat, notes.join('\n'));
  const setup = configOf(ws).setupCommand;
  if (setup) prepareWorkspace(chat, ws, setup);
  return ws;
}

/**
 * A Worker's own workspace (two-layer mode): a worktree branched from the chat workspace's current
 * commit, so it starts from everything merged there so far, and merged back into it after each
 * turn. Anything not yet committed in the chat's worktree is committed first. Call it under the
 * chat's lock.
 */
export async function createWorkerWorkspace(chatWs: Workspace, worker: { id: string; chatId: string; title: string }): Promise<{ ws: Workspace; base: string }> {
  const info = chatWs.workspace;
  await saveWork(info, 'Crew: save changes before starting a worker');
  const base = (await gitIn(info.worktree, ['rev-parse', 'HEAD'])).trim();
  const rel = path.relative(info.worktree, chatWs.path);
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const { branch, worktree, path: wsPath } = await addWorktree(info.repo, base, prefix, worker.title);
  const now = Date.now();
  const ws: Workspace = {
    id: uid('p_'),
    name: chatWs.name,
    path: wsPath,
    createdAt: now,
    updatedAt: now,
    framework: chatWs.framework,
    workspace: { parentId: info.parentId, chatId: worker.chatId, workerId: worker.id, branch, baseBranch: info.branch, repo: info.repo, worktree, createdAt: now },
  };
  emitProject(ws);
  return { ws, base };
}

/**
 * A speculative run's throwaway workspace (ADR 008): a worktree branched from the state the problem
 * was observed in, without touching it. That is the source folder's uncommitted tracked changes as a
 * commit object (`git stash create` changes no ref, index entry or file of the user's), else its
 * HEAD. No chat lock is taken and the chat is not moved: a turn running there is not held up.
 * Untracked files are not brought along (local files git ignores are, as for any workspace).
 */
export async function createSpeculativeWorkspace(source: Project, worker: { id: string; chatId: string; title: string }): Promise<{ ws: Workspace; base: string }> {
  await checkGit(source.path);
  const repo = (await gitIn(source.path, ['rev-parse', '--show-toplevel'])).trim();
  const prefix = (await gitIn(source.path, ['rev-parse', '--show-prefix'])).trim();
  const snapshot = (await gitIn(source.path, ['stash', 'create', 'Crew: the state a speculative run started from']).catch(() => '')).trim();
  const base = snapshot || (await gitIn(source.path, ['rev-parse', 'HEAD'])).trim();
  const branchName = (await gitIn(source.path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim() || 'HEAD';
  const { branch, worktree, path: wsPath } = await addWorktree(repo, base, prefix, worker.title);
  const now = Date.now();
  const ws: Workspace = {
    id: uid('p_'),
    name: source.name,
    path: wsPath,
    createdAt: now,
    updatedAt: now,
    framework: source.framework,
    workspace: { parentId: source.workspace?.parentId ?? source.id, chatId: worker.chatId, workerId: worker.id, branch, baseBranch: branchName, repo, worktree, createdAt: now, speculative: true },
  };
  emitProject(ws);
  return { ws, base };
}
