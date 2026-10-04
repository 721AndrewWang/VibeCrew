import { create } from 'zustand';
import { DEFAULT_LOGO, isLogoId, type LogoId } from '../../shared/logos';
import type {
  Attachment,
  AuthStatus,
  Bootstrap,
  Bot,
  BotStatus,
  BotTemplate,
  Chat,
  ChatMessage,
  ConsoleEntry,
  DevServerState,
  PluginDef,
  PreviewInfo,
  Project,
  ProviderPreset,
  PublicSettings,
  RecordedStep,
  Routine,
  SandboxStatus,
  ServerEvent,
  Skill,
  TurnSummary,
  UsageSummary,
} from '../../shared/types';
import { api } from './api';
import { desktop } from './desktop';

export type View = 'chat' | 'bots' | 'skills' | 'routines' | 'projects' | 'settings';
export type ComputerTab = 'browser' | 'files' | 'terminal' | 'changes';
export type Device = 'fill' | 'desktop' | 'tablet' | 'mobile';

export interface PreviewUi {
  path: string;
  title: string;
  console: ConsoleEntry[];
  picking: boolean;
  recording: boolean;
  steps: RecordedStep[];
  reloadKey: number;
  device: Device;
  /** Set when the iframe should navigate somewhere (bumped nonce). */
  navigate?: { path: string; nonce: number };
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

export interface MsgState {
  list: ChatMessage[];
  loaded: boolean;
  hasMore: boolean;
  loading: boolean;
}

export interface Toast {
  id: number;
  title: string;
  body?: string;
  level: 'info' | 'success' | 'warn' | 'error';
  chatId?: string;
}

export interface AppState {
  booted: boolean;
  connected: boolean;
  bootError?: string;
  version: string;
  settings: PublicSettings;
  auth: AuthStatus;
  features: { pty: boolean; browser: boolean; sandbox: SandboxStatus };
  /** botId → spend today and this month. */
  usage: Record<string, UsageSummary>;
  models: { id: string; label: string }[];
  providers: ProviderPreset[];
  templates: BotTemplate[];
  plugins: PluginDef[];
  lanUrl?: string;
  bots: Record<string, Bot>;
  chats: Record<string, Chat>;
  projects: Record<string, Project>;
  skills: Skill[];
  routines: Record<string, Routine>;
  statuses: Record<string, BotStatus>;
  devServers: Record<string, DevServerState>;
  previews: Record<string, PreviewInfo>;
  devLogs: Record<string, string>;
  msgs: Record<string, MsgState>;
  turns: Record<string, TurnSummary[]>;
  /** Bumped when files change on disk, per project. */
  filesVersion: Record<string, number>;
  lastChanged: Record<string, string[]>;

  view: View;
  activeChatId: string | null;
  computer: { open: boolean; tab: ComputerTab; width: number; maximized: boolean };
  focusTurn?: { chatId: string; turnId: string; path?: string; nonce: number };
  openFile?: { projectId: string; path: string; nonce: number };
  /** Asks the terminal tab to open a new terminal running this command. */
  terminalRequest?: { command: string; nonce: number };
  drafts: Record<string, Draft>;
  preview: Record<string, PreviewUi>;
  toasts: Toast[];
  mobilePane: 'list' | 'chat' | 'computer';
  modal:
    | null
    | { kind: 'newGroup' }
    | { kind: 'newBot' }
    | { kind: 'botEditor'; botId: string }
    | { kind: 'newProject' }
    | { kind: 'chatSettings'; chatId: string }
    | { kind: 'saveRecording'; projectId: string }
    | { kind: 'trace'; chatId: string; msgId: string };
}

const LS_UI = 'vc-ui';

/** The logo last seen (App.tsx keeps it), so the boot screen shows it before the settings arrive. */
function cachedLogo(): LogoId {
  try {
    const v = localStorage.getItem('vc-logo');
    return isLogoId(v) ? v : DEFAULT_LOGO;
  } catch {
    return DEFAULT_LOGO;
  }
}

function loadUi(): Partial<AppState> {
  try {
    const s = JSON.parse(localStorage.getItem(LS_UI) || '{}');
    return { computer: { open: true, tab: 'browser', width: 46, maximized: false, ...s.computer }, activeChatId: s.activeChatId ?? null, drafts: s.drafts || {} };
  } catch {
    return {};
  }
}

export const useStore = create<AppState>(() => ({
  booted: false,
  connected: false,
  version: '',
  settings: {
    defaultModel: '',
    authMode: 'claude-code',
    hasApiKey: false,
    baseUrl: '',
    provider: { preset: '', baseUrl: '', model: '', fastModel: '' },
    hasProviderToken: false,
    lanEnabled: false,
    port: 4321,
    projectsRoot: '',
    defaultPermission: 'edits',
    maxHops: 8,
    logo: cachedLogo(),
    denyRules: [],
    sandbox: { enabled: false, allowedDomains: [] },
    routing: { mode: 'off' },
    rotateAtTokens: 60_000,
    push: { configured: false, afterMinutes: 10 },
  },
  auth: { cliFound: false, loggedIn: false, method: 'unknown', ready: false, checkedAt: 0 },
  features: { pty: false, browser: false, sandbox: { available: false, missing: [] } },
  usage: {},
  models: [],
  providers: [],
  templates: [],
  plugins: [],
  bots: {},
  chats: {},
  projects: {},
  skills: [],
  routines: {},
  statuses: {},
  devServers: {},
  previews: {},
  devLogs: {},
  msgs: {},
  turns: {},
  filesVersion: {},
  lastChanged: {},
  view: 'chat',
  activeChatId: null,
  computer: { open: true, tab: 'browser', width: 46, maximized: false },
  drafts: {},
  preview: {},
  toasts: [],
  mobilePane: 'list',
  modal: null,
  ...loadUi(),
}));

const set = useStore.setState;
const get = useStore.getState;

let saveTimer: number | undefined;
useStore.subscribe((s) => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(LS_UI, JSON.stringify({ computer: s.computer, activeChatId: s.activeChatId, drafts: s.drafts }));
    } catch {
      /* storage full or blocked */
    }
  }, 400);
});

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

// ---------------------------------------------------------------- boot

export async function boot() {
  try {
    const b: Bootstrap = await api.bootstrap();
    const cur = get();
    const chats = byId(b.chats);
    let active = cur.activeChatId && chats[cur.activeChatId] ? cur.activeChatId : null;
    const fromHash = location.hash.match(/^#\/chat\/(.+)$/)?.[1];
    if (fromHash && chats[fromHash]) active = fromHash;
    if (!active) active = b.chats.find((c) => c.kind === 'group')?.id || b.chats[0]?.id || null;
    set({
      booted: true,
      bootError: undefined,
      version: b.version,
      settings: b.settings,
      auth: b.auth,
      features: b.features,
      usage: b.usage || {},
      models: b.models,
      providers: b.providers || [],
      templates: b.templates,
      plugins: b.plugins,
      lanUrl: b.lanUrl,
      bots: byId(b.bots),
      chats,
      projects: byId(b.projects),
      skills: b.skills,
      routines: byId(b.routines),
      statuses: b.statuses,
      devServers: Object.fromEntries(b.devServers.map((d) => [d.projectId, d])),
      previews: Object.fromEntries(b.previews.map((p) => [p.projectId, p])),
      activeChatId: active,
      // Messages may have moved on while disconnected.
      msgs: {},
      mobilePane: cur.booted ? cur.mobilePane : active && window.innerWidth > 760 ? 'chat' : 'list',
    });
    if (active) {
      if (location.hash !== `#/chat/${active}`) history.replaceState(null, '', `#/chat/${active}`);
      void loadMessages(active);
    }
  } catch (e) {
    set({ bootError: (e as Error).message });
  }
}

// ---------------------------------------------------------------- events

function upsertMsg(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === msg.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = msg;
    return next;
  }
  const next = [...list, msg];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

function patchMsg(chatId: string, id: string, fn: (m: ChatMessage) => ChatMessage) {
  const st = get().msgs[chatId];
  if (!st) return;
  const i = st.list.findIndex((m) => m.id === id);
  if (i < 0) return;
  const list = st.list.slice();
  list[i] = fn(list[i]);
  set({ msgs: { ...get().msgs, [chatId]: { ...st, list } } });
}

let notifyPermissionAsked = false;

function systemNotify(title: string, body: string, chatId?: string) {
  if (!('Notification' in window) || !document.hidden) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icon.svg', tag: chatId });
    n.onclick = () => {
      // The desktop app may have hidden its window to the tray.
      desktop?.show();
      window.focus();
      if (chatId) openChat(chatId);
      n.close();
    };
  } catch {
    /* some platforms only allow notifications from a service worker */
  }
}

export function askNotificationPermission() {
  if (notifyPermissionAsked || !('Notification' in window) || Notification.permission !== 'default') return;
  notifyPermissionAsked = true;
  void Notification.requestPermission();
}

export function applyEvent(ev: ServerEvent) {
  const s = get();
  switch (ev.t) {
    case 'chat':
      set({ chats: { ...s.chats, [ev.chat.id]: ev.chat } });
      break;
    case 'chat_deleted': {
      const chats = { ...s.chats };
      delete chats[ev.id];
      set({ chats, activeChatId: s.activeChatId === ev.id ? null : s.activeChatId });
      break;
    }
    case 'bot':
      set({ bots: { ...s.bots, [ev.bot.id]: ev.bot } });
      break;
    case 'bot_deleted': {
      const bots = { ...s.bots };
      delete bots[ev.id];
      set({ bots });
      break;
    }
    case 'bot_status':
      set({ statuses: { ...s.statuses, [ev.botId]: ev.status } });
      break;
    case 'msg': {
      const st = s.msgs[ev.msg.chatId];
      if (st?.loaded) set({ msgs: { ...s.msgs, [ev.msg.chatId]: { ...st, list: upsertMsg(st.list, ev.msg) } } });
      if (ev.msg.chatId === s.activeChatId && ev.msg.role === 'bot' && ev.msg.status !== 'streaming' && !document.hidden) void api.read(ev.msg.chatId).catch(() => {});
      break;
    }
    case 'usage':
      set({ usage: ev.usage });
      break;
    case 'msg_deleted': {
      const st = s.msgs[ev.chatId];
      if (st) set({ msgs: { ...s.msgs, [ev.chatId]: { ...st, list: st.list.filter((m) => m.id !== ev.id) } } });
      break;
    }
    case 'msg_part':
      patchMsg(ev.chatId, ev.id, (m) => {
        const parts = (m.parts || []).slice();
        parts[ev.index] = ev.part;
        return { ...m, parts };
      });
      break;
    case 'msg_text':
      patchMsg(ev.chatId, ev.id, (m) => {
        const parts = (m.parts || []).slice();
        const p = parts[ev.index];
        if (p && (p.type === 'text' || p.type === 'thinking')) parts[ev.index] = { ...p, text: p.text + ev.delta };
        return { ...m, parts };
      });
      break;
    case 'project':
      set({ projects: { ...s.projects, [ev.project.id]: ev.project } });
      break;
    case 'project_deleted': {
      const projects = { ...s.projects };
      delete projects[ev.id];
      set({ projects });
      break;
    }
    case 'devserver':
      set({ devServers: { ...s.devServers, [ev.state.projectId]: ev.state } });
      break;
    case 'devserver_log': {
      const cur = (s.devLogs[ev.projectId] || '') + ev.data;
      set({ devLogs: { ...s.devLogs, [ev.projectId]: cur.length > 300_000 ? cur.slice(-200_000) : cur } });
      break;
    }
    case 'preview':
      set({ previews: { ...s.previews, [ev.info.projectId]: ev.info } });
      break;
    case 'files_changed':
      set({
        filesVersion: { ...s.filesVersion, [ev.projectId]: (s.filesVersion[ev.projectId] || 0) + 1 },
        lastChanged: { ...s.lastChanged, [ev.projectId]: ev.paths },
      });
      break;
    case 'routine':
      set({ routines: { ...s.routines, [ev.routine.id]: ev.routine } });
      break;
    case 'routine_deleted': {
      const routines = { ...s.routines };
      delete routines[ev.id];
      set({ routines });
      break;
    }
    case 'skill':
      set({ skills: [...s.skills.filter((k) => k.name !== ev.skill.name), ev.skill] });
      break;
    case 'skill_deleted':
      set({ skills: s.skills.filter((k) => k.name !== ev.name) });
      break;
    case 'turn': {
      const list = s.turns[ev.turn.chatId];
      if (list) set({ turns: { ...s.turns, [ev.turn.chatId]: [ev.turn, ...list.filter((t) => t.id !== ev.turn.id)] } });
      break;
    }
    case 'settings':
      set({ settings: ev.settings });
      break;
    case 'auth':
      set({ auth: ev.auth });
      break;
    case 'notify': {
      const viewing = ev.chatId && ev.chatId === s.activeChatId && s.view === 'chat' && !document.hidden;
      if (ev.level === 'success' && viewing) break;
      toast(ev.title, ev.body, ev.level || 'info', ev.chatId);
      systemNotify(ev.title, ev.body, ev.chatId);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- actions

let toastSeq = 0;
export function toast(title: string, body?: string, level: Toast['level'] = 'info', chatId?: string) {
  const t: Toast = { id: ++toastSeq, title, body, level, chatId };
  set({ toasts: [...get().toasts.slice(-4), t] });
  window.setTimeout(() => dismissToast(t.id), level === 'error' ? 9000 : 5000);
}

export function dismissToast(id: number) {
  set({ toasts: get().toasts.filter((t) => t.id !== id) });
}

export function setView(view: View) {
  set({ view, mobilePane: view === 'chat' ? get().mobilePane : 'chat' });
}

export function openChat(chatId: string, fromAddress = false) {
  const c = get().chats[chatId];
  set({ view: 'chat', activeChatId: chatId, mobilePane: 'chat' });
  // Each chat gets its own history entry, so back and forward move between chats.
  const hash = `#/chat/${chatId}`;
  if (!fromAddress && location.hash !== hash) history.pushState(null, '', hash);
  void loadMessages(chatId);
  if (c?.unread) void api.read(chatId).catch(() => {});
}

/** Follows the address: back/forward, links to `#/chat/<id>`, or an edited URL. */
function followAddress() {
  const id = location.hash.match(/^#\/chat\/(.+)$/)?.[1];
  if (!id || !get().booted || !get().chats[id]) return;
  if (id !== get().activeChatId || get().view !== 'chat') openChat(id, true);
}
window.addEventListener('hashchange', followAddress);
window.addEventListener('popstate', followAddress);

export async function loadMessages(chatId: string, older = false) {
  const st = get().msgs[chatId];
  if (st?.loading) return;
  if (st?.loaded && !older) return;
  const before = older && st?.list.length ? st.list[0].seq : undefined;
  set({ msgs: { ...get().msgs, [chatId]: { list: st?.list || [], loaded: st?.loaded || false, hasMore: st?.hasMore || false, loading: true } } });
  try {
    const r = await api.messages(chatId, before);
    const cur = get().msgs[chatId];
    const merged = older ? [...r.messages, ...(cur?.list || [])] : r.messages;
    // Keep any live messages that arrived while loading.
    const ids = new Set(merged.map((m) => m.id));
    for (const m of cur?.list || []) if (!ids.has(m.id)) merged.push(m);
    merged.sort((a, b) => a.seq - b.seq);
    set({ msgs: { ...get().msgs, [chatId]: { list: merged, loaded: true, hasMore: r.hasMore, loading: false } } });
  } catch (e) {
    set({ msgs: { ...get().msgs, [chatId]: { list: st?.list || [], loaded: false, hasMore: false, loading: false } } });
    toast('加载消息失败', (e as Error).message, 'error');
  }
}

export async function loadTurns(chatId: string) {
  try {
    const list = await api.turns(chatId);
    set({ turns: { ...get().turns, [chatId]: list } });
  } catch {
    /* shown as empty */
  }
}

export function draftOf(chatId: string): Draft {
  return get().drafts[chatId] || { text: '', attachments: [] };
}

export function setDraft(chatId: string, patch: Partial<Draft>) {
  const cur = draftOf(chatId);
  set({ drafts: { ...get().drafts, [chatId]: { ...cur, ...patch } } });
}

export function addAttachment(chatId: string, a: Attachment) {
  const cur = draftOf(chatId);
  set({ drafts: { ...get().drafts, [chatId]: { ...cur, attachments: [...cur.attachments, a] } } });
}

export function removeAttachment(chatId: string, id: string) {
  const cur = draftOf(chatId);
  set({ drafts: { ...get().drafts, [chatId]: { ...cur, attachments: cur.attachments.filter((a) => a.id !== id) } } });
}

export async function sendMessage(chatId: string, textOverride?: string) {
  const d = draftOf(chatId);
  const text = (textOverride ?? d.text).trim();
  if (!text && !d.attachments.length) return;
  set({ drafts: { ...get().drafts, [chatId]: { text: '', attachments: [] } } });
  askNotificationPermission();
  try {
    const msg = await api.send(chatId, text, d.attachments);
    const st = get().msgs[chatId];
    if (st?.loaded) set({ msgs: { ...get().msgs, [chatId]: { ...st, list: upsertMsg(st.list, msg) } } });
  } catch (e) {
    set({ drafts: { ...get().drafts, [chatId]: d } });
    toast('发送失败', (e as Error).message, 'error');
  }
}

export function setComputer(patch: Partial<AppState['computer']>) {
  set({ computer: { ...get().computer, ...patch } });
}

export function previewOf(projectId: string): PreviewUi {
  return get().preview[projectId] || { path: '/', title: '', console: [], picking: false, recording: false, steps: [], reloadKey: 0, device: 'fill' };
}

export function updatePreview(projectId: string, patch: Partial<PreviewUi> | ((p: PreviewUi) => Partial<PreviewUi>)) {
  const cur = previewOf(projectId);
  const p = typeof patch === 'function' ? patch(cur) : patch;
  set({ preview: { ...get().preview, [projectId]: { ...cur, ...p } } });
}

export function focusTurn(chatId: string, turnId: string, path?: string) {
  set({ focusTurn: { chatId, turnId, path, nonce: Date.now() }, computer: { ...get().computer, open: true, tab: 'changes' }, mobilePane: 'computer' });
}

export function openFileInEditor(projectId: string, path: string) {
  set({ openFile: { projectId, path, nonce: Date.now() }, computer: { ...get().computer, open: true, tab: 'files' }, mobilePane: 'computer' });
}

/** Opens a terminal (in the active chat's project) running a command, e.g. `claude auth login`. */
export function requestTerminal(command: string) {
  set({ terminalRequest: { command, nonce: Date.now() }, view: 'chat', computer: { ...get().computer, open: true, tab: 'terminal' }, mobilePane: 'computer' });
}

export function openModal(modal: AppState['modal']) {
  set({ modal });
}

export function closeModal() {
  set({ modal: null });
}

/** The project a chat's bots work in: its isolated workspace when it has one, otherwise its project. */
export function chatProjectId(chat: Chat | null | undefined, projects: Record<string, Project> = get().projects): string | null {
  if (!chat) return null;
  if (chat.workspaceId && projects[chat.workspaceId]) return chat.workspaceId;
  return chat.projectId;
}

export function useChatProject(chat: Chat | null | undefined): Project | null {
  return useStore((s) => {
    const id = chatProjectId(chat, s.projects);
    return id ? (s.projects[id] ?? null) : null;
  });
}

/** The user's projects, without the chats' isolated workspaces. */
export function listProjects(projects: Record<string, Project>): Project[] {
  return Object.values(projects)
    .filter((p) => !p.workspace)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The project (or workspace) the computer pane of the open chat shows. */
export function activeProjectId(): string | null {
  const s = get();
  return chatProjectId(s.activeChatId ? s.chats[s.activeChatId] : null, s.projects);
}

export function dmOf(botId: string): Chat | undefined {
  return Object.values(get().chats).find((c) => c.kind === 'dm' && c.botIds[0] === botId);
}

let attachSeq = 0;
export function attachmentId() {
  return `att_${Date.now().toString(36)}_${++attachSeq}`;
}
