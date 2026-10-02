import type {
  Attachment,
  AuthStatus,
  Bootstrap,
  Bot,
  Chat,
  ChatMessage,
  DevServerState,
  Effort,
  Improvement,
  ImprovementEffect,
  PermissionLevel,
  PreviewInfo,
  Project,
  PublicSettings,
  RecordedStep,
  Routine,
  RoutingReport,
  Skill,
  TurnSummary,
  TurnTrace,
  WorkspaceMergeResult,
  WorkspaceStatus,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `请求失败（${res.status}）`);
  return data as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);
const q = encodeURIComponent;

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  heavy?: boolean;
}

export interface FileContent {
  path: string;
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  size: number;
}

export interface GitStatus {
  repo: boolean;
  branch?: string;
  files?: { code: string; path: string }[];
  commits?: { hash: string; subject: string; when: string }[];
}

export interface TurnDiff {
  path: string;
  before?: string | null;
  after?: string | null;
  current?: string | null;
  binary?: boolean;
  tooLarge?: boolean;
  source: 'tool' | 'watch';
}

export interface UploadResult {
  id: string;
  name: string;
  mime: string;
  url: string;
}

export const api = {
  bootstrap: () => get<Bootstrap>('/api/bootstrap'),
  trace: (chatId: string, msgId: string) => get<TurnTrace>(`/api/chats/${chatId}/messages/${msgId}/trace`),
  traceRawUrl: (chatId: string, msgId: string) => `/api/chats/${chatId}/messages/${msgId}/trace?raw=1`,
  auth: (refresh = false) => get<AuthStatus>(`/api/auth${refresh ? '?refresh=1' : ''}`),
  updateSettings: (p: Record<string, unknown>) => patch<{ settings: PublicSettings; lanUrl?: string }>('/api/settings', p),
  /** One tiny prompt through Claude Code with these (unsaved) connection settings. */
  testConnection: (p: Record<string, unknown>) => post<{ ok: boolean; text: string; models?: string[]; ms: number }>('/api/settings/test-connection', p),
  lan: () => get<{ url?: string; qr: string | null; pluginSecretKeys: string[] }>('/api/lan'),

  createBot: (b: Partial<Bot> & { template?: string }) => post<Bot>('/api/bots', b),
  updateBot: (id: string, b: Partial<Bot>) => patch<Bot>(`/api/bots/${id}`, b),
  deleteBot: (id: string) => del(`/api/bots/${id}`),
  memory: (id: string) => get<{ text: string }>(`/api/bots/${id}/memory`),
  saveMemory: (id: string, text: string) => put(`/api/bots/${id}/memory`, { text }),

  createGroup: (g: { title?: string; botIds: string[]; leadBotId?: string | null; projectId?: string | null }) => post<Chat>('/api/chats', g),
  updateChat: (id: string, p: Partial<Chat>) => patch<Chat>(`/api/chats/${id}`, p),
  /** The composer's switches for this chat; null goes back to each bot's own setting. */
  setChatSwitches: (id: string, p: { permission?: PermissionLevel | null; model?: string | null; effort?: Effort | null }) => patch<Chat>(`/api/chats/${id}`, p),
  deleteChat: (id: string) => del(`/api/chats/${id}`),
  messages: (id: string, before?: number) => get<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/chats/${id}/messages${before !== undefined ? `?before=${before}` : ''}`),
  send: (id: string, text: string, attachments: Attachment[]) => post<ChatMessage>(`/api/chats/${id}/messages`, { text, attachments }),
  stop: (id: string) => post(`/api/chats/${id}/stop`),
  reset: (id: string) => post(`/api/chats/${id}/reset`),
  read: (id: string) => post(`/api/chats/${id}/read`),
  turns: (id: string) => get<TurnSummary[]>(`/api/chats/${id}/turns`),
  turnDiff: (chatId: string, turnId: string, path: string) => get<TurnDiff>(`/api/chats/${chatId}/turns/${turnId}/diff?path=${q(path)}`),
  revertTurn: (chatId: string, turnId: string, force = false) => post<{ reverted: string[]; conflicts: string[]; skipped: string[] }>(`/api/chats/${chatId}/turns/${turnId}/revert`, { force }),
  approve: (id: string, decision: 'allow' | 'always' | 'deny', message?: string) => post(`/api/approvals/${id}`, { decision, message }),

  workspace: (chatId: string) => get<WorkspaceStatus>(`/api/chats/${chatId}/workspace`),
  createWorkspace: (chatId: string) => post<Project>(`/api/chats/${chatId}/workspace`),
  removeWorkspace: (chatId: string, deleteBranch = false) => del(`/api/chats/${chatId}/workspace${deleteBranch ? '?deleteBranch=1' : ''}`),
  workspaceDiff: (chatId: string, path: string) => get<{ diff: string }>(`/api/chats/${chatId}/workspace/diff?path=${q(path)}`),
  mergeWorkspace: (chatId: string, message?: string) => post<WorkspaceMergeResult>(`/api/chats/${chatId}/workspace/merge`, { message }),
  suggestCommitMessage: (chatId: string) => post<{ message: string }>(`/api/chats/${chatId}/workspace/commit-message`, {}),
  syncWorkspace: (chatId: string) => post<WorkspaceMergeResult>(`/api/chats/${chatId}/workspace/sync`),
  resolveConflicts: (chatId: string) => post<{ started: boolean; conflicts: string[] }>(`/api/chats/${chatId}/workspace/resolve`),
  abortSync: (chatId: string) => post(`/api/chats/${chatId}/workspace/abort`),

  projectTemplates: () => get<{ id: string; name: string; description: string; needsInstall: boolean }[]>('/api/projects/templates'),
  createProject: (p: { name: string; template: string; parentDir?: string }) => post<Project>('/api/projects', { mode: 'create', ...p }),
  openProject: (path: string, name?: string) => post<Project>('/api/projects', { mode: 'open', path, name }),
  updateProject: (id: string, p: Partial<Project>) => patch<Project>(`/api/projects/${id}`, p),
  removeProject: (id: string) => del(`/api/projects/${id}`),
  tree: (id: string, path = '') => get<TreeEntry[]>(`/api/projects/${id}/tree?path=${q(path)}`),
  file: (id: string, path: string) => get<FileContent>(`/api/projects/${id}/file?path=${q(path)}`),
  saveFile: (id: string, path: string, content: string) => put(`/api/projects/${id}/file`, { path, content }),
  rawUrl: (id: string, path: string) => `/api/projects/${id}/raw?path=${q(path)}`,
  preview: (id: string) => post<PreviewInfo>(`/api/projects/${id}/preview`),
  previewPage: (id: string, path: string) => post(`/api/projects/${id}/preview-page`, { path }),
  dev: (id: string, action: 'start' | 'stop' | 'restart') => post<DevServerState>(`/api/projects/${id}/dev/${action}`),
  devUrl: (id: string, url: string) => post<DevServerState>(`/api/projects/${id}/dev/url`, { url }),
  devLogs: (id: string) => get<{ logs: string; state: DevServerState }>(`/api/projects/${id}/dev/logs`),
  terminals: (id: string) => get<{ id: string; title: string; exited: boolean }[]>(`/api/projects/${id}/terminals`),
  git: (id: string) => get<GitStatus>(`/api/projects/${id}/git`),
  gitDiff: (id: string, path: string) => get<{ diff: string }>(`/api/projects/${id}/git/diff?path=${q(path)}`),
  commit: (id: string, message: string) => post<GitStatus>(`/api/projects/${id}/git/commit`, { message }),
  screenshot: (id: string, path: string, device: string, fullPage = false) => post<UploadResult>(`/api/projects/${id}/screenshot`, { path, device, fullPage }),
  fs: (path?: string) => get<{ path: string; parent: string | null; home: string; entries: { name: string; path: string; isProject: boolean }[] }>(`/api/fs${path ? `?path=${q(path)}` : ''}`),

  saveSkill: (s: Partial<Skill> & { name: string; previousName?: string }) => post<Skill>('/api/skills', s),
  deleteSkill: (name: string) => del(`/api/skills/${q(name)}`),
  skillFromRecording: (p: { name: string; title: string; goal: string; page: string; steps: RecordedStep[] }) => post<Skill>('/api/skills/from-recording', p),

  saveRoutine: (r: Partial<Routine>) => post<Routine>('/api/routines', r),
  updateRoutine: (id: string, r: Partial<Routine>) => patch<Routine>(`/api/routines/${id}`, r),
  deleteRoutine: (id: string) => del(`/api/routines/${id}`),
  runRoutine: (id: string) => post<Routine>(`/api/routines/${id}/run`),

  upload: (file: { name: string; mime: string; data: string }) => post<UploadResult>('/api/uploads', file),
  routing: () => get<RoutingReport>('/api/routing'),
  improvements: () => get<{ items: Improvement[]; effects: Record<string, ImprovementEffect> }>('/api/improvements'),
  runImprovements: () => post<{ added: Improvement[]; dropped: string[]; costUsd: number }>('/api/improvements/run'),
  acceptImprovement: (id: string) => post<{ improvement: Improvement }>(`/api/improvements/${id}/accept`),
  rejectImprovement: (id: string, note?: string) => post<{ improvement: Improvement }>(`/api/improvements/${id}/reject`, { note }),
  revertImprovement: (id: string) => post<{ improvement: Improvement }>(`/api/improvements/${id}/revert`),
};

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
