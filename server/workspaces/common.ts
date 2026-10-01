import fs from 'node:fs';
import type { Chat, Project, WorkspaceInfo } from '../../shared/types';
import { bus } from '../bus';
import { autoCommit, gitError } from '../gitops';
import { invalidateChat } from '../orchestrator';
import { decorate, gitIn, HttpError } from '../projects';
import { chats, messages, projects } from '../store';

/** Messages a bot gets again as context when it moves into or out of a workspace. */
const RECAP = 12;

export type Workspace = Project & { workspace: WorkspaceInfo };

export function requireChat(chatId: string): Chat {
  const chat = chats.get(chatId);
  if (!chat) throw new HttpError(404, '对话不存在');
  return chat;
}

export function workspaceOf(chat: Chat): Workspace | null {
  const p = projects.get(chat.workspaceId);
  return p?.workspace ? (p as Workspace) : null;
}

export function requireWorkspace(chatId: string): { chat: Chat; ws: Workspace; info: WorkspaceInfo } {
  const chat = requireChat(chatId);
  const ws = workspaceOf(chat);
  if (!ws) throw new HttpError(404, '这个对话没有独立工作区');
  if (!fs.existsSync(ws.workspace.worktree)) throw new HttpError(410, `工作区目录不见了：${ws.workspace.worktree}`);
  return { chat, ws, info: ws.workspace };
}

export async function succeeds(dir: string, args: string[]): Promise<boolean> {
  try {
    await gitIn(dir, args);
    return true;
  } catch {
    return false;
  }
}

export async function revParse(dir: string, ref: string): Promise<string> {
  return (await gitIn(dir, ['rev-parse', '--verify', ref])).trim();
}

export async function count(dir: string, range: string): Promise<number> {
  return Number((await gitIn(dir, ['rev-list', '--count', range])).trim()) || 0;
}

/**
 * The bots' Claude Code sessions belong to the old directory, so they start fresh in the new one.
 * The last messages of the current topic come along as context.
 */
export function restartBots(chat: Chat) {
  invalidateChat(chat.id);
  chat.sessions = {};
  chat.context = {};
  const list = messages.sorted(chat.id);
  const topicStart = [...list].reverse().find((m) => m.role === 'system' && m.uiOnly && m.text === '—— 新话题 ——')?.seq ?? 0;
  const recent = list.filter((m) => m.seq > topicStart && !m.uiOnly && m.status !== 'streaming').slice(-RECAP);
  const from = recent.length ? recent[0].seq - 1 : chat.seq;
  for (const b of chat.botIds) chat.cursors[b] = Math.min(chat.cursors[b] ?? from, from);
}

export function emitChat(chat: Chat) {
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
}

export function emitProject(p: Project) {
  projects.set(p);
  bus.emit({ t: 'project', project: decorate(p) });
}

/** Commits what is still uncommitted in the worktree; refuses while conflicts are unresolved. */
export async function saveWork(info: WorkspaceInfo, message: string) {
  let r: Awaited<ReturnType<typeof autoCommit>>;
  try {
    r = await autoCommit(info.worktree, message);
  } catch (e) {
    throw new HttpError(500, `没能把工作区里的改动提交到分支：${gitError(e)}`);
  }
  if (r.unresolved?.length) throw new HttpError(409, `工作区里还有冲突没解决：${r.unresolved.join('、')}`);
}
