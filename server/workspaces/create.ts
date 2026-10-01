import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/types';
import { DATA } from '../config';
import { slugify } from '../data/projectTemplates';
import { statusLines } from '../gitops';
import { systemMessage } from '../orchestrator';
import { configOf, gitIn, HttpError } from '../projects';
import { projects, uid } from '../store';
import { emitChat, emitProject, requireChat, restartBots, succeeds, type Workspace, workspaceOf } from './common';
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
    return { ok: false, text: '没有安装' };
  }
}

export async function doCreate(chatId: string): Promise<Project> {
  const chat = requireChat(chatId);
  if (workspaceOf(chat)) throw new HttpError(409, '这个对话已经在独立工作区里了');
  const parent = projects.get(chat.projectId);
  if (!parent || parent.workspace) throw new HttpError(400, '先给这个对话绑定一个项目');
  const version = await gitVersion();
  if (!version.ok) throw new HttpError(400, `独立工作区需要 Git ${MIN_GIT.join('.')} 或更新的版本（现在是 ${version.text}）。`);
  if (!(await succeeds(parent.path, ['rev-parse', '--verify', 'HEAD']))) {
    throw new HttpError(400, '这个项目还不是 Git 仓库，或者还没有任何提交。在右侧「改动」里提交一次，就可以使用独立工作区了。');
  }
  if (!(await succeeds(parent.path, ['var', 'GIT_COMMITTER_IDENT']))) {
    throw new HttpError(400, '机器人的改动要提交到分支，需要先设置 Git 的用户名和邮箱。在终端运行：git config --global user.name "你的名字"，以及 git config --global user.email "你的邮箱"。');
  }
  // The full ref: a tag with the same name would make the short name ambiguous.
  const headRef = (await gitIn(parent.path, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  if (!headRef.startsWith('refs/heads/')) throw new HttpError(400, '项目目录现在不在任何分支上（detached HEAD），先切换到一个分支再试。');
  const baseBranch = headRef.slice('refs/heads/'.length);
  const repo = (await gitIn(parent.path, ['rev-parse', '--show-toplevel'])).trim();
  // Where the project sits in the repository: '' at the top, or a monorepo package folder.
  const prefix = (await gitIn(parent.path, ['rev-parse', '--show-prefix'])).trim();

  const slug =
    slugify(chat.title)
      .slice(0, 24)
      .replace(/^-+|-+$/g, '') || 'task';
  let branch = `${BRANCH_PREFIX}${slug}-${shortId()}`;
  while (await succeeds(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) branch = `${BRANCH_PREFIX}${slug}-${shortId()}`;
  const worktree = path.join(DATA.worktrees, `${slugify(path.basename(repo)) || 'project'}-${branch.slice(BRANCH_PREFIX.length)}`);
  await gitIn(repo, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']);

  let ws: Workspace;
  let copied: string[];
  try {
    const wsPath = path.resolve(worktree, prefix);
    if (!fs.existsSync(wsPath)) {
      throw new HttpError(400, `项目文件夹 ${prefix.replace(/\/$/, '')} 还没有提交到 Git，工作区里没有它。先在右侧「改动」里提交一次再试。`);
    }
    copied = await copyLocalFiles(repo, worktree, prefix);
    const now = Date.now();
    ws = {
      id: uid('p_'),
      name: parent.name,
      path: wsPath,
      createdAt: now,
      updatedAt: now,
      framework: parent.framework,
      workspace: { parentId: parent.id, chatId: chat.id, branch, baseBranch, repo, worktree, createdAt: now },
    };
  } catch (e) {
    // Nothing is registered yet: take the fresh worktree and branch away again.
    await gitIn(repo, ['worktree', 'remove', '--force', worktree]).catch(() => fs.rmSync(worktree, { recursive: true, force: true }));
    await gitIn(repo, ['worktree', 'prune']).catch(() => {});
    await gitIn(repo, ['branch', '-D', branch]).catch(() => {});
    throw e;
  }
  emitProject(ws);

  const uncommitted = (await statusLines(parent.path).catch(() => [])).length > 0;
  chat.workspaceId = ws.id;
  restartBots(chat);
  emitChat(chat);
  const notes = [
    `已进入独立工作区：新分支 ${branch}（从 ${baseBranch} 分出）。`,
    `机器人接下来在这份副本里工作，不影响主目录和其他对话；每一轮的改动会自动提交到这个分支，确认没问题后在右侧「改动」里合并回 ${baseBranch}。`,
  ];
  if (uncommitted) notes.push(`主目录里还没提交的改动不会带进工作区。`);
  if (copied.length) notes.push(`已带上 git 之外的本地文件：${copied.slice(0, 8).join('、')}${copied.length > 8 ? ` 等 ${copied.length} 项` : ''}。`);
  systemMessage(chat, notes.join('\n'));
  const setup = configOf(ws).setupCommand;
  if (setup) prepareWorkspace(chat, ws, setup);
  return ws;
}
