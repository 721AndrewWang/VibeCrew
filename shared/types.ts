// Types shared by the server and the web client.

import type { LogoId } from './logos';

export type ID = string;

/**
 * How much a bot may do on its own.
 * - auto:   run everything except actions matching askRules (those still ask)
 * - edits:  edit files freely, ask before shell commands that are not allow-listed
 * - ask:    ask before every edit / command that is not allow-listed
 * - review: an AI reviewer (Claude Code "auto" mode) approves or blocks each action
 * - plan:   read-only; the bot explores and proposes a plan
 */
export type PermissionLevel = 'auto' | 'edits' | 'ask' | 'review' | 'plan';

export type Effort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface McpServerEntry {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface Bot {
  id: ID;
  /** Handle used for @mentions. Unique, no spaces. */
  name: string;
  emoji: string;
  color: string;
  /** One-line role, e.g. "前端工程师". */
  title: string;
  /** Persona and workflow; becomes part of the system prompt. */
  description: string;
  model: string;
  effort: Effort;
  permission: PermissionLevel;
  /** Actions the bot may take without asking, e.g. "Bash(npm run *)". */
  allowRules: string[];
  /** Actions that always need your approval, whatever the permission level. */
  askRules: string[];
  /** Custom MCP servers (JSON config). */
  mcpServers: Record<string, McpServerEntry>;
  /** Enabled plugins from the built-in catalog. */
  plugins: string[];
  /** Load the user's own Claude Code settings (their MCP servers, plugins, skills). */
  loadUserSettings: boolean;
  /** Project used by this bot's direct chat. */
  projectId: ID | null;
  template?: string;
  createdAt: number;
  updatedAt: number;
}

export type ChatKind = 'dm' | 'group';

export interface Chat {
  id: ID;
  kind: ChatKind;
  title: string;
  botIds: ID[];
  /** Group chats: who answers when nobody is @mentioned. */
  leadBotId: ID | null;
  projectId: ID | null;
  createdAt: number;
  updatedAt: number;
  lastMessage?: { text: string; ts: number; author: string };
  unread: number;
  pinned?: boolean;
  /** botId -> Claude Code session id. */
  sessions: Record<ID, string>;
  /** botId -> seq of the last message the bot has already seen. */
  cursors: Record<ID, number>;
  seq: number;
  /** Max automatic bot-to-bot handoffs after one user message. */
  maxHops: number;
  /** The chat's isolated workspace (a Project with `workspace` set); its bots work there instead. */
  workspaceId?: ID | null;
  /** Set from the composer's switches for every bot in this chat; unset = each bot's own setting. */
  permission?: PermissionLevel;
  model?: string;
  effort?: Effort;
  /** botId -> how full its context window was after its last turn (the composer's ring). */
  context?: Record<ID, ContextUsage>;
}

/** A bot's context window use, as Claude Code's /context reports it. */
export interface ContextUsage {
  /** The model the bot's session runs on. */
  model?: string;
  used: number;
  /** The window it is measured against (where auto-compaction kicks in). */
  max: number;
  percentage: number;
  at: number;
}

export interface ConsoleEntry {
  level: 'error' | 'warn' | 'info' | 'log';
  text: string;
  ts: number;
  source?: string;
}

export interface RecordedStep {
  type: 'click' | 'fill' | 'select' | 'check' | 'press' | 'navigate' | 'submit';
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  url?: string;
  ts: number;
}

export interface ElementInfo {
  page: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
  /** Source location hint (React/Vue/Svelte dev builds). */
  source?: string;
  component?: string;
}

export type Attachment =
  | { kind: 'image'; id: ID; name: string; mime: string; url: string }
  | ({ kind: 'element'; id: ID } & ElementInfo)
  | { kind: 'console'; id: ID; page: string; entries: ConsoleEntry[] }
  | { kind: 'file'; id: ID; path: string }
  | { kind: 'recording'; id: ID; page: string; steps: RecordedStep[] };

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
}

export interface ToolPart {
  type: 'tool';
  id: string;
  name: string;
  input: any;
  status: 'running' | 'done' | 'error';
  result?: string;
  images?: string[];
  /** Set when the call came from a sub-agent (Task tool). */
  parent?: string | null;
  startedAt: number;
  endedAt?: number;
}

export interface ApprovalPart {
  type: 'approval';
  id: string;
  toolName: string;
  input: any;
  title: string;
  detail?: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  /** Rule that "always allow" would add, e.g. "Bash(npm run *)". */
  rule?: string;
  /** All of them: a compound command needs one per command it runs. */
  rules?: string[];
  /** Claude Code's own reason for prompting, when it gave one. */
  reason?: string;
  /** What made Crew ask: the level, or the rule that matched. */
  because?: string;
}

export type MessagePart = TextPart | ThinkingPart | ToolPart | ApprovalPart;

export interface MessageTrigger {
  type: 'user' | 'mention' | 'routine' | 'system';
  by?: ID;
  routineId?: ID;
}

export interface ChatMessage {
  id: ID;
  chatId: ID;
  seq: number;
  ts: number;
  role: 'user' | 'bot' | 'system';
  botId?: ID;
  /** User text, or the concatenated text of a bot turn. */
  text: string;
  /** What the bots receive when it differs from text (an expanded /skill). */
  prompt?: string;
  /** Name of the skill a /command expanded to. */
  skill?: string;
  parts?: MessagePart[];
  attachments?: Attachment[];
  status?: 'queued' | 'streaming' | 'done' | 'error' | 'stopped';
  /** The turn was cut short by a restart of Crew; what it had written is kept. */
  interrupted?: boolean;
  error?: string;
  turnId?: ID;
  trigger?: MessageTrigger;
  /** model: the one that did most of the turn (Claude Code may use a small model on the side). */
  meta?: { costUsd?: number; durationMs?: number; numTurns?: number; model?: string };
  /** Files changed by this bot turn. */
  changes?: { files: string[]; reverted?: boolean };
  /** A note for the human only; never included in bot prompts. */
  uiOnly?: boolean;
}

export interface Project {
  id: ID;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  /** Overrides the detected dev command, e.g. "npm run dev". */
  devCommand?: string;
  /** Directory (relative) served when there is no dev server. */
  staticRoot?: string;
  /** Run in every new workspace of this project before the bots start there, e.g. "npm ci". */
  setupCommand?: string;
  /** How commit messages are written here, e.g. "English, imperative mood". Bots are told; merges follow it. */
  commitGuide?: string;
  /** No AI attribution in commits: neither Claude Code's Co-Authored-By trailer nor Crew's merge footer. */
  noAttribution?: boolean;
  /** Extra rules that always need the user's OK for every bot working here, e.g. "Bash(ssh:*)". */
  askRules?: string[];
  framework?: string;
  /** Detected (or configured) dev server command; null for static sites. Filled in by the server. */
  devDetected?: string | null;
  /** Set when this is a chat's isolated workspace: a git worktree of another project. */
  workspace?: WorkspaceInfo;
}

/**
 * A chat's own copy of a project: a git worktree on its own branch, so several chats can work on
 * one project at the same time without touching each other's files. Merged back on request.
 */
export interface WorkspaceInfo {
  /** The project it was branched from. */
  parentId: ID;
  chatId: ID;
  /** e.g. vc/landing-k3x9 */
  branch: string;
  /** Branch the work is merged back into, e.g. main. */
  baseBranch: string;
  /** Top level of the main repository (the parent may be a subfolder of it). */
  repo: string;
  /** Top level of the worktree; the workspace's `path` is the same subfolder inside it. */
  worktree: string;
  createdAt: number;
  mergedAt?: number;
}

export interface WorkspaceStatus {
  branch: string;
  baseBranch: string;
  path: string;
  /** The project's folder inside the repository ('' when it is the top); file paths below are from the top. */
  prefix: string;
  /** Commits on the workspace branch that the base branch does not have. */
  ahead: number;
  /** Commits on the base branch since the workspace branched off (or last synced). */
  behind: number;
  /** Uncommitted changes in the worktree. */
  dirty: boolean;
  /** Files that differ from the base branch, including uncommitted changes. */
  files: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }[];
  /** An unfinished `git merge` inside the workspace (conflicts being resolved). */
  merging: boolean;
  mergedAt?: number;
}

/** Merging into the base branch (or syncing from it) either succeeds or stops at conflicts; other failures are errors. */
export type WorkspaceMergeResult = { ok: true; commit: string; files: number } | { ok: false; conflicts: string[] };

export type DevServerStatus = 'stopped' | 'installing' | 'starting' | 'running' | 'error';

export interface DevServerState {
  projectId: ID;
  status: DevServerStatus;
  command?: string;
  url?: string;
  error?: string;
}

export interface PreviewInfo {
  projectId: ID;
  mode: 'static' | 'proxy';
  port: number;
  /** Where the proxied content really comes from. */
  target: string;
}

export interface Skill {
  name: string;
  title: string;
  description: string;
  icon: string;
  argsHint?: string;
  body: string;
  builtin: boolean;
  updatedAt: number;
}

export type RoutineTrigger =
  | { type: 'interval'; minutes: number }
  | { type: 'daily'; time: string; days?: number[] }
  | { type: 'cron'; expr: string }
  | { type: 'file_change'; debounceSec: number }
  | { type: 'git_commit' }
  | { type: 'manual' };

export interface Routine {
  id: ID;
  name: string;
  enabled: boolean;
  botId: ID;
  /** Chat that receives the run; null = the bot's direct chat. */
  chatId: ID | null;
  prompt: string;
  trigger: RoutineTrigger;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'running' | 'skipped';
  runCount: number;
  createdAt: number;
}

export interface TurnFile {
  path: string;
  /** null = file did not exist; undefined = unknown (changed by a shell command). */
  before?: string | null;
  after?: string | null;
  binary?: boolean;
  tooLarge?: boolean;
  source: 'tool' | 'watch';
}

export interface TurnRecord {
  id: ID;
  chatId: ID;
  botId: ID;
  messageId: ID;
  projectId: ID;
  startedAt: number;
  endedAt?: number;
  files: TurnFile[];
  reverted?: boolean;
}

export type TurnSummary = Omit<TurnRecord, 'files'> & {
  files: { path: string; status: 'added' | 'modified' | 'deleted' | 'unknown'; source: 'tool' | 'watch' }[];
};

/**
 * How the bots' Claude Code reaches a model: its own login, an Anthropic API key, or another
 * provider's Anthropic-compatible endpoint (DeepSeek, Kimi, GLM, Qwen, OpenRouter, Ollama…).
 */
export type AuthMode = 'claude-code' | 'api-key' | 'provider';

export interface ProviderSettings {
  /** ProviderPreset id, or 'custom'. */
  preset: string;
  baseUrl: string;
  /** Main model: Claude Code's opus / sonnet tiers and the bots' default. */
  model: string;
  /** Cheap model for background work (the haiku tier). */
  fastModel: string;
}

/** A provider whose Anthropic-compatible endpoint Claude Code can use, with its recommended setup. */
export interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  /** Sub-agents run on the main model rather than the fast one. */
  subagentsUseMain?: boolean;
  /** Further models to offer in the model pickers. */
  models?: string[];
  /** Where to get a key and read the provider's own instructions. */
  docsUrl?: string;
  /** Local servers that need some token but ignore its value. */
  defaultToken?: string;
  /** Variables the provider recommends (timeouts, compaction window). */
  env?: Record<string, string>;
  hint?: string;
}

export interface PublicSettings {
  defaultModel: string;
  authMode: AuthMode;
  hasApiKey: boolean;
  baseUrl: string;
  provider: ProviderSettings;
  hasProviderToken: boolean;
  lanEnabled: boolean;
  port: number;
  projectsRoot: string;
  defaultPermission: PermissionLevel;
  maxHops: number;
  /** The app's logo and icon (Settings → 外观), for every device and the desktop app. */
  logo: LogoId;
  /** Actions no bot may take, in any project or mode, e.g. "Bash(*prod-server*)". */
  denyRules: string[];
}

export interface BotStatus {
  state: 'idle' | 'queued' | 'thinking' | 'tool' | 'waiting' | 'error';
  detail?: string;
  chatId?: ID;
  since: number;
}

export interface PluginDef {
  id: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  server: McpServerEntry;
  /** Env vars / headers the user has to fill in. */
  needs?: string[];
}

export interface BotTemplate {
  id: string;
  name: string;
  emoji: string;
  color: string;
  title: string;
  description: string;
  permission: PermissionLevel;
  plugins?: string[];
}

export interface Bootstrap {
  version: string;
  settings: PublicSettings;
  bots: Bot[];
  chats: Chat[];
  projects: Project[];
  skills: Skill[];
  routines: Routine[];
  templates: BotTemplate[];
  plugins: PluginDef[];
  statuses: Record<ID, BotStatus>;
  devServers: DevServerState[];
  previews: PreviewInfo[];
  models: { id: string; label: string }[];
  providers: ProviderPreset[];
  features: { pty: boolean; browser: boolean };
  auth: AuthStatus;
  lanUrl?: string;
}

export interface AuthStatus {
  /** Claude Code CLI found on this machine. */
  cliFound: boolean;
  cliPath?: string;
  cliVersion?: string;
  loggedIn: boolean;
  method: string;
  /** Crew can run bots (CLI + login, or an API key). */
  ready: boolean;
  checkedAt: number;
}

/** Server -> client websocket events. */
export type ServerEvent =
  | { t: 'chat'; chat: Chat }
  | { t: 'chat_deleted'; id: ID }
  | { t: 'bot'; bot: Bot }
  | { t: 'bot_deleted'; id: ID }
  | { t: 'bot_status'; botId: ID; status: BotStatus }
  | { t: 'msg'; msg: ChatMessage }
  | { t: 'msg_deleted'; chatId: ID; id: ID }
  | { t: 'msg_part'; chatId: ID; id: ID; index: number; part: MessagePart }
  | { t: 'msg_text'; chatId: ID; id: ID; index: number; delta: string }
  | { t: 'project'; project: Project }
  | { t: 'project_deleted'; id: ID }
  | { t: 'devserver'; state: DevServerState }
  | { t: 'devserver_log'; projectId: ID; data: string }
  | { t: 'preview'; info: PreviewInfo }
  | { t: 'files_changed'; projectId: ID; paths: string[] }
  | { t: 'term_data'; id: string; data: string }
  | { t: 'term_exit'; id: string; code: number | null }
  | { t: 'bot_log'; projectId: ID; data: string }
  | { t: 'routine'; routine: Routine }
  | { t: 'routine_deleted'; id: ID }
  | { t: 'skill'; skill: Skill }
  | { t: 'skill_deleted'; name: string }
  | { t: 'turn'; turn: TurnSummary }
  | { t: 'settings'; settings: PublicSettings }
  | { t: 'auth'; auth: AuthStatus }
  | { t: 'notify'; title: string; body: string; chatId?: ID; level?: 'info' | 'success' | 'warn' | 'error' };

/** Client -> server websocket events. */
export type ClientEvent =
  | { t: 'term_open'; id: string; projectId: ID; cols: number; rows: number; command?: string }
  | { t: 'term_input'; id: string; data: string }
  | { t: 'term_resize'; id: string; cols: number; rows: number }
  | { t: 'term_close'; id: string }
  | { t: 'ping' };

/** Messages exchanged with the script injected into previewed pages. */
export type PreviewToHost =
  | { type: 'ready'; url: string; title: string }
  | { type: 'nav'; url: string; title: string }
  | { type: 'console'; entry: ConsoleEntry }
  | { type: 'picked'; info: ElementInfo }
  | { type: 'pick_end' }
  | { type: 'recorded'; step: RecordedStep };

export type HostToPreview = { type: 'hello' } | { type: 'pick'; on: boolean } | { type: 'record'; on: boolean } | { type: 'highlight'; selector: string } | { type: 'history'; dir: -1 | 1 };
