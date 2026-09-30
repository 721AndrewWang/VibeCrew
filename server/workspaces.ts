// Isolated workspaces: a chat can work in its own git worktree on its own branch, so several chats
// can change one project at the same time without touching each other's files (the way
// vibe-kanban gives every task attempt a worktree). Each bot turn is committed to that branch;
// the user merges it back into the base branch (squashed into one commit) when it looks right.

import fs from 'node:fs';
import path from 'node:path';
import type { Chat, Project, WorkspaceInfo, WorkspaceMergeResult, WorkspaceStatus } from '../shared/types';
import { bus, notify } from './bus';
import { DATA } from './config';
import { slugify } from './data/projectTemplates';
import { disposeDevServer } from './devserver';
import { autoCommit, gitError, isMerging, statusLines, unresolvedConflicts, zList } from './gitops';
import { invalidateChat, projectRunning, sendUserMessage, systemMessage, withChatLocked } from './orchestrator';
import { closePreview } from './preview';
import { decorate, gitIn, HttpError } from './projects';
import { bots, chats, messages, projects, uid } from './store';
import { closeProjectTerminals } from './terminal';
import { stopWatch } from './watcher';

const BRANCH_PREFIX = 'vc/';
/** Messages a bot gets again as context when it moves into or out of a workspace. */
const RECAP = 12;
/** Merging without a working tree (`git merge-tree --write-tree`) needs Git 2.38. */
const MIN_GIT = [2, 38] as const;

type Workspace = Project & { workspace: WorkspaceInfo };

function requireChat(chatId: string): Chat {
  const chat = chats.get(chatId);
  if (!chat) throw new HttpError(404, '对话不存在');
  return chat;
}

function workspaceOf(chat: Chat): Workspace | null {
  const p = projects.get(chat.workspaceId);
  return p?.workspace ? (p as Workspace) : null;
}

function requireWorkspace(chatId: string): { chat: Chat; ws: Workspace; info: WorkspaceInfo } {
  const chat = requireChat(chatId);
  const ws = workspaceOf(chat);
  if (!ws) throw new HttpError(404, '这个对话没有独立工作区');
  if (!fs.existsSync(ws.workspace.worktree)) throw new HttpError(410, `工作区目录不见了：${ws.workspace.worktree}`);
  return { chat, ws, info: ws.workspace };
}

async function succeeds(dir: string, args: string[]): Promise<boolean> {
  try {
    await gitIn(dir, args);
    return true;
  } catch {
    return false;
  }
}

async function revParse(dir: string, ref: string): Promise<string> {
  return (await gitIn(dir, ['rev-parse', '--verify', ref])).trim();
}

async function count(dir: string, range: string): Promise<number> {
  return Number((await gitIn(dir, ['rev-list', '--count', range])).trim()) || 0;
}

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

/**
 * Gitignored env files are not part of a checkout, but dev servers usually need them. Only files
 * the new worktree ignores (by its committed .gitignore) are copied: anything else would be
 * committed on the branch and merged back.
 */
async function copyEnvFiles(from: string, to: string): Promise<string[]> {
  const copied: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return copied;
  }
  for (const e of entries) {
    if (!e.isFile() || !/^\.env(\..+)?$/.test(e.name) || fs.existsSync(path.join(to, e.name))) continue;
    if (!(await succeeds(to, ['check-ignore', '-q', '--', e.name]))) continue;
    fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
    copied.push(e.name);
  }
  return copied;
}

/**
 * The bots' Claude Code sessions belong to the old directory, so they start fresh in the new one.
 * The last messages of the current topic come along as context.
 */
function restartBots(chat: Chat) {
  invalidateChat(chat.id);
  chat.sessions = {};
  const list = messages.sorted(chat.id);
  const topicStart = [...list].reverse().find((m) => m.role === 'system' && m.uiOnly && m.text === '—— 新话题 ——')?.seq ?? 0;
  const recent = list.filter((m) => m.seq > topicStart && !m.uiOnly && m.status !== 'streaming').slice(-RECAP);
  const from = recent.length ? recent[0].seq - 1 : chat.seq;
  for (const b of chat.botIds) chat.cursors[b] = Math.min(chat.cursors[b] ?? from, from);
}

function emitChat(chat: Chat) {
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
}

function emitProject(p: Project) {
  projects.set(p);
  bus.emit({ t: 'project', project: decorate(p) });
}

// ---------------------------------------------------------------- create

async function doCreate(chatId: string): Promise<Project> {
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

  const slug = slugify(chat.title).slice(0, 24).replace(/^-+|-+$/g, '') || 'task';
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
    copied = await copyEnvFiles(parent.path, wsPath);
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
  if (copied.length) notes.push(`已复制 ${copied.join('、')}。`);
  systemMessage(chat, notes.join('\n'));
  return ws;
}

// ---------------------------------------------------------------- status & diff

async function mergeBase(info: WorkspaceInfo): Promise<string> {
  return (await gitIn(info.worktree, ['merge-base', `refs/heads/${info.baseBranch}`, 'HEAD'])).trim();
}

const STATUS: Record<string, WorkspaceStatus['files'][number]['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };

export async function workspaceStatus(chatId: string): Promise<WorkspaceStatus> {
  const { ws, info } = requireWorkspace(chatId);
  const [counts, dirty, merging] = await Promise.all([
    gitIn(info.worktree, ['rev-list', '--left-right', '--count', `refs/heads/${info.baseBranch}...HEAD`]).catch(() => '0\t0'),
    statusLines(info.worktree),
    isMerging(info.worktree),
  ]);
  const [behind, ahead] = counts.trim().split(/\s+/).map((n) => Number(n) || 0);
  const files: WorkspaceStatus['files'] = [];
  const base = await mergeBase(info).catch(() => '');
  if (base) {
    // The whole repository: a monorepo package's branch may change files outside its folder. The
    // working tree is compared, so uncommitted edits count too.
    const tokens = zList(await gitIn(info.worktree, ['diff', '--name-status', '-z', '-M', base]).catch(() => ''));
    for (let i = 0; i < tokens.length; ) {
      const code = tokens[i];
      if (code[0] === 'R' || code[0] === 'C') {
        files.push({ path: tokens[i + 2], status: STATUS[code[0]] });
        i += 3;
      } else {
        files.push({ path: tokens[i + 1], status: STATUS[code[0]] || 'modified' });
        i += 2;
      }
    }
    for (const p of zList(await gitIn(info.worktree, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''))) files.push({ path: p, status: 'added' });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    branch: info.branch,
    baseBranch: info.baseBranch,
    path: ws.path,
    prefix: path.relative(info.worktree, ws.path).split(path.sep).join('/'),
    ahead,
    behind,
    dirty: dirty.length > 0,
    files,
    merging,
    mergedAt: info.mergedAt,
  };
}

/** Unified diff of one file (path from the repository's top) between where the branch started and now. */
export async function workspaceDiff(chatId: string, rel: string): Promise<string> {
  const { info } = requireWorkspace(chatId);
  const root = path.resolve(info.worktree);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new HttpError(400, '路径超出工作区');
  const base = await mergeBase(info);
  const out = await gitIn(root, ['diff', '-M', base, '--', rel]).catch(() => '');
  if (out) return out;
  try {
    const content = fs.readFileSync(abs, 'utf8');
    return `--- /dev/null\n+++ b/${rel}\n` + content.split('\n').map((l) => '+' + l).join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- merge & sync

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

/** Commits what is still uncommitted in the worktree; refuses while conflicts are unresolved. */
async function saveWork(info: WorkspaceInfo, message: string) {
  let r: Awaited<ReturnType<typeof autoCommit>>;
  try {
    r = await autoCommit(info.worktree, message);
  } catch (e) {
    throw new HttpError(500, `没能把工作区里的改动提交到分支：${gitError(e)}`);
  }
  if (r.unresolved?.length) throw new HttpError(409, `工作区里还有冲突没解决：${r.unresolved.join('、')}`);
}

/**
 * Squash-merges the workspace branch into its base branch as one commit. The merge is computed
 * without a working tree; the base branch's checkout (usually the project folder) is then
 * fast-forwarded, which git refuses if that would overwrite uncommitted changes there.
 */
async function doMerge(chatId: string, message?: string): Promise<WorkspaceMergeResult> {
  const { chat, ws, info } = requireWorkspace(chatId);
  if (projectRunning(info.parentId)) throw new HttpError(409, '有机器人正在项目主目录里工作，等它这一轮做完再合并');
  if (await isMerging(info.worktree)) throw new HttpError(409, `工作区里正在同步 ${info.baseBranch}，等冲突解决并提交后再合并`);
  await saveWork(info, 'VibeCrew：合并前保存改动');

  const baseRef = `refs/heads/${info.baseBranch}`;
  const baseHead = await revParse(info.repo, baseRef).catch(() => {
    throw new HttpError(400, `找不到分支 ${info.baseBranch}`);
  });
  const head = await revParse(info.worktree, 'HEAD');
  if (!(await count(info.repo, `${baseHead}..${head}`))) throw new HttpError(409, `没有需要合并的改动，${info.baseBranch} 已经包含这个分支的全部内容`);

  const trial = await trialMerge(info.repo, baseHead, head);
  if ('conflicts' in trial) return { ok: false, conflicts: trial.conflicts };
  if (trial.tree === (await revParse(info.repo, `${baseHead}^{tree}`))) throw new HttpError(409, `没有需要合并的改动，${info.baseBranch} 已经包含这些修改`);

  const subjects = (await gitIn(info.repo, ['log', '--no-merges', '--format=%s', `${baseHead}..${head}`]))
    .split('\n')
    .filter((s) => s && !s.startsWith('VibeCrew：'));
  const title = message?.trim() || chat.title;
  const body = [title, '', ...subjects.slice(0, 40).map((s) => `- ${s}`), '', `VibeCrew 独立工作区 ${info.branch}`].join('\n');
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
  await gitIn(info.worktree, ['reset', '-q', '--keep', commit]).catch((e) => console.warn('[workspace] reset after merge:', gitError(e)));
  ws.workspace.mergedAt = Date.now();
  ws.updatedAt = Date.now();
  emitProject(ws);
  systemMessage(chat, `已把这个工作区的改动（${changed} 个文件）合并到 ${info.baseBranch}，提交 ${commit.slice(0, 7)}。工作区继续可用，之后的改动会接着合并。`, { uiOnly: true });
  return { ok: true, commit: commit.slice(0, 7), files: changed };
}

/**
 * Brings new commits of the base branch into the workspace. On conflicts the merge is left in
 * progress (with conflict markers in the files) for a bot to resolve; see doResolve.
 */
async function doSync(chatId: string): Promise<WorkspaceMergeResult> {
  const { chat, info } = requireWorkspace(chatId);
  const baseRef = `refs/heads/${info.baseBranch}`;
  if (await isMerging(info.worktree)) {
    const unresolved = await unresolvedConflicts(info.worktree);
    if (unresolved.length) return { ok: false, conflicts: unresolved };
    // Every conflict is fixed but not committed yet: conclude the merge.
    await saveWork(info, `VibeCrew：同步 ${info.baseBranch} 的最新改动`);
    systemMessage(chat, `已完成和 ${info.baseBranch} 的同步。`);
    return { ok: true, commit: (await revParse(info.worktree, 'HEAD')).slice(0, 7), files: 0 };
  }
  await saveWork(info, 'VibeCrew：同步前保存改动');
  const before = await revParse(info.worktree, 'HEAD');
  if (!(await count(info.worktree, `HEAD..${baseRef}`))) throw new HttpError(409, `已经是最新的了，${info.baseBranch} 没有新的提交`);
  try {
    await gitIn(info.worktree, ['-c', 'commit.gpgsign=false', 'merge', '--no-verify', '--no-edit', '-q', '-m', `VibeCrew：同步 ${info.baseBranch} 的最新改动`, baseRef]);
  } catch (e) {
    if (await isMerging(info.worktree)) return { ok: false, conflicts: await unresolvedConflicts(info.worktree) };
    throw new HttpError(500, `同步失败：${gitError(e)}`);
  }
  const changed = zList(await gitIn(info.worktree, ['diff', '--name-only', '-z', before, 'HEAD'])).length;
  systemMessage(chat, `已把 ${info.baseBranch} 的最新改动同步到这个工作区（${changed} 个文件）。`);
  return { ok: true, commit: (await revParse(info.worktree, 'HEAD')).slice(0, 7), files: changed };
}

/** Starts (or continues) syncing with the base branch and asks the chat's lead bot to fix the conflicts. */
async function doResolve(chatId: string): Promise<{ started: boolean; conflicts: string[] }> {
  const { chat, info } = requireWorkspace(chatId);
  const r = await doSync(chatId);
  if (r.ok) return { started: false, conflicts: [] };
  const conflicts = r.conflicts;
  const lead = chat.kind === 'group' ? bots.get(chat.leadBotId) || bots.get(chat.botIds[0]) : null;
  const text = [
    lead ? `@${lead.name}` : '',
    `我在工作区里合并了 ${info.baseBranch} 的最新改动，这些文件有冲突：${conflicts.join('、')}。`,
    '请处理这些冲突：文本文件里的 <<<<<<< / ======= / >>>>>>> 标记要去掉，两边的改动按意图合在一起；二进制文件，或者一边删除一边修改的文件，决定保留哪个版本后用 git add（保留）或 git rm（删除）标记为已解决。改完检查一下页面和构建是否正常。',
    '不需要自己提交，VibeCrew 会在这一轮结束后自动提交并完成这次合并。',
  ]
    .filter(Boolean)
    .join('\n');
  sendUserMessage(chat.id, { text });
  return { started: true, conflicts };
}

/** Gives up an unfinished sync, restoring the workspace to before it. */
async function doAbort(chatId: string) {
  const { chat, info } = requireWorkspace(chatId);
  if (!(await isMerging(info.worktree))) return;
  await gitIn(info.worktree, ['merge', '--abort']);
  systemMessage(chat, `已放弃这次和 ${info.baseBranch} 的同步，工作区恢复到同步之前的样子。`);
}

/** The Git section's "commit all" inside a workspace: same conflict guard as the automatic commits. */
async function doCommit(chatId: string, message: string) {
  const { info } = requireWorkspace(chatId);
  let r: Awaited<ReturnType<typeof autoCommit>>;
  try {
    r = await autoCommit(info.worktree, message);
  } catch (e) {
    throw new HttpError(500, `提交失败：${gitError(e)}`);
  }
  if (r.unresolved?.length) throw new HttpError(409, `还有冲突没解决：${r.unresolved.join('、')}`);
}

// ---------------------------------------------------------------- remove

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
      r = await autoCommit(info.worktree, 'VibeCrew：关闭工作区前保存改动');
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
  if (deleteBranch) await gitIn(info.repo, ['branch', '-D', info.branch]).catch((e) => console.warn('[workspace] delete branch:', gitError(e)));
  unregister(ws);
}

/** The user closes the workspace: the chat goes back to the project folder. */
async function doRemove(chatId: string, deleteBranch: boolean) {
  const chat = requireChat(chatId);
  const ws = workspaceOf(chat);
  if (!ws) throw new HttpError(404, '这个对话没有独立工作区');
  const { branch } = ws.workspace;
  const keep = !deleteBranch && (await hasUnmergedWork(ws.workspace));
  await disposeWorkspace(ws, !keep);
  chat.workspaceId = null;
  restartBots(chat);
  emitChat(chat);
  systemMessage(
    chat,
    keep ? `已关闭独立工作区，分支 ${branch} 保留在仓库里，里面有还没合并的改动。机器人回到项目目录工作。` : `已关闭独立工作区并删除分支 ${branch}，机器人回到项目目录工作。`,
  );
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
    console.warn('[workspace]', body);
    notify('独立工作区没有删除', body, { level: 'warn' });
  }
}

/** The chat is deleted or moved to another project: its workspace goes away in the background. */
export function detachWorkspace(chat: Chat) {
  const ws = workspaceOf(chat);
  chat.workspaceId = null;
  if (ws) void retire(ws).catch((e) => console.warn('[workspace] retire:', gitError(e)));
}

/** Startup: drop workspaces whose chat is gone, and chats whose worktree was deleted by hand. */
export async function reconcileWorkspaces() {
  for (const p of projects.all()) {
    if (!p.workspace) continue;
    const ws = p as Workspace;
    const chat = chats.get(ws.workspace.chatId);
    if (!chat || chat.workspaceId !== ws.id) {
      await retire(ws).catch((e) => console.warn('[workspace] cleanup:', gitError(e)));
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

// ---------------------------------------------------------------- public operations
// One git operation per chat at a time, and never while a bot turn runs or waits there.

export const createWorkspace = (chatId: string) => withChatLocked(chatId, '切换', () => doCreate(chatId));
export const mergeWorkspace = (chatId: string, message?: string) => withChatLocked(chatId, '合并', () => doMerge(chatId, message));
export const syncWorkspace = (chatId: string) => withChatLocked(chatId, '同步', () => doSync(chatId));
export const resolveConflicts = (chatId: string) => withChatLocked(chatId, '处理冲突', () => doResolve(chatId));
export const abortSync = (chatId: string) => withChatLocked(chatId, '放弃同步', () => doAbort(chatId));
export const commitWorkspace = (chatId: string, message: string) => withChatLocked(chatId, '提交', () => doCommit(chatId, message));
export const removeWorkspace = (chatId: string, deleteBranch: boolean) => withChatLocked(chatId, '关闭工作区', () => doRemove(chatId, deleteBranch));
