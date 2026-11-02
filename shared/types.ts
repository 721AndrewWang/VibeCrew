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
  /** One-line role, e.g. "Frontend engineer". */
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
  /** Paths (globs, relative to the project) this role may edit; anything else is refused. Empty = no limit. */
  editScope?: string[];
  /** Spend cap per calendar month in USD; the bot stops taking turns once reached. */
  monthlyBudgetUsd?: number;
  /** Start every turn in a new Claude Code session instead of resuming: for roles that check or review, whose earlier turns are not worth re-reading. */
  freshSession?: boolean;
  /** Adversarial reviewer: sees the user's request and the change, never teammates' explanations, and tries to refute it. */
  blindReview?: boolean;
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
  /** Two-layer mode (ADR 002): the Router's Claude Code session, and the seq of the last chat message it was given. */
  router?: { sessionId?: string; cursor?: number };
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
  /**
   * outside-edit: files changed outside the chat, a note about the work itself that blind reviewers
   * see too. stall: the chain stopped without a handoff and the lead was woken. trigger: the
   * Super-agent's event filter thought an event worth the user's attention (always uiOnly).
   */
  notice?: 'outside-edit' | 'stall' | 'trigger';
  /** The turn was cut short by a restart of Crew; what it had written is kept. */
  interrupted?: boolean;
  error?: string;
  turnId?: ID;
  trigger?: MessageTrigger;
  /** model: the one that did most of the turn (Claude Code may use a small model on the side). */
  meta?: {
    /** This turn's cost. */
    costUsd?: number;
    /** The session's running total after this turn, as Claude Code reports it (absent on turns saved before it was kept). */
    sessionCostUsd?: number;
    /** The Claude Code session the turn ran in. */
    sessionId?: string;
    /** This turn's tokens, all models. */
    tokens?: TurnTokens;
    /** The session's running token totals after this turn. */
    sessionTokens?: TurnTokens;
    durationMs?: number;
    numTurns?: number;
    model?: string;
    trace?: TraceRef;
    verdict?: { refuted: number };
    /** Estimated tokens of the prompt Crew injected, and of the same prompt without Inline & Spill (only while recall is on). */
    injected?: { tokens: number; without: number };
  };
  /** Files changed by this bot turn. */
  changes?: { files: string[]; reverted?: boolean };
  /** A note for the human only; never included in bot prompts. */
  uiOnly?: boolean;
  /** Posted by the chat's Router (two-layer mode), speaking as the lead. */
  router?: boolean;
  /** On a Router turn in its log: the ids of the events (messages, Workers, Triggers) the turn handled. */
  batch?: ID[];
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
  /** Hosts the sandboxed commands of this project may reach, on top of the global list. */
  allowedDomains?: string[];
  /** A workspace merges only after an adversarial review that refuted nothing at its current commit. */
  requireChallenge?: boolean;
  /** Call the adversarial reviewer by itself when a finished change matches these fixed rules. */
  autoChallenge?: AutoChallenge;
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
  /** The last adversarial review of this branch. */
  challenge?: ChallengeVerdict;
  /** Set when this is a Worker's workspace: branched from the chat's branch (baseBranch), merged back into it after each turn. */
  workerId?: ID;
}

export interface AutoChallenge {
  enabled: boolean;
  /** Changed files matching any of these globs (relative to the project) trigger a review. */
  paths: string[];
  /** So do changes of at least this many lines in total (added plus removed); 0 = no size rule. */
  minLines: number;
}

export interface ChallengeVerdict {
  /** The commit the reviewer saw (after its own counterexample tests were committed). */
  head: string;
  /** How many claims it refuted with a reproducible counterexample; 0 = not refuted. */
  refuted: number;
  at: number;
  messageId: ID;
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
  challenge?: ChallengeVerdict;
  /** The project requires a passing adversarial review before merging. */
  requireChallenge?: boolean;
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
  /** The app's logo and icon (Settings → Appearance), for every device and the desktop app. */
  logo: LogoId;
  /** Actions no bot may take, in any project or mode, e.g. "Bash(*prod-server*)". */
  denyRules: string[];
  sandbox: SandboxSettings;
  /** Group-chat routing by a cheap model: off, or shadow (decides and records, never acts). */
  routing: { mode: 'off' | 'shadow' };
  /** A resumed session whose context passes this many tokens starts over with a recap; 0 = never. */
  rotateAtTokens: number;
  /** A turn whose context passes this many tokens is asked to wrap up and hand back; 0 = never. */
  wrapUpAtTokens: number;
  /** Phone push through Bark for approvals left open; the URL itself stays on the server. */
  push: { configured: boolean; afterMinutes: number };
  /** The event-driven core (Trigger bus, threads, two-stage filter); off = Crew as before. */
  superAgent: SuperAgentSettings;
}

/**
 * Where an event came from. user and routine are always explicit requests; the others are
 * environment events the filter decides on.
 */
export type TriggerSource = 'user' | 'routine' | 'turn' | 'outside-edit' | 'preview-console';

/** Sources whose fast-path rule the user can change. */
export type FilteredSource = Exclude<TriggerSource, 'user' | 'routine'>;

/**
 * Per source, deterministic: act on explicit requests only (the rest is recorded as dropped), let
 * the rest through to the cheap model as candidates, or ignore the source (nothing is recorded).
 */
export type SourceMode = 'explicit' | 'candidate' | 'ignore';

export interface SourceRule {
  mode: SourceMode;
  /** Only events matching one of these become candidates: globs for file paths, substrings for error text. Empty = all. */
  allow: string[];
}

export interface SuperAgentSettings {
  enabled: boolean;
  sources: Record<FilteredSource, SourceRule>;
  /** Only events from these projects (a workspace counts as its parent) become candidates; empty = all. */
  projects: ID[];
  /** The slow path's policies, in the user's words: what is worth acting on. */
  policies: string;
  /** Candidates the cheap model sees per hour at most; the rest are dropped. */
  maxCandidatesPerHour: number;
  /** Two-layer mode: a resident Router per group chat that dispatches Workers (ADR 002). */
  router: RouterSettings;
  /** Inline & Spill context and the recall tool (ADR 005). */
  recall: RecallSettings;
}

export interface RecallSettings {
  /** Prompts inline by locality and spill the rest behind ids; agents get recall(id). Needs superAgent.enabled. */
  enabled: boolean;
  /** Words of anything not adjacent to the turn that are inlined before the rest spills. */
  inlineWords: number;
}

/** Kinds recall resolves; later milestones register more (background jobs). */
export type RecallKind = 'message' | 'chat' | 'env' | 'trigger' | 'thread' | 'worker' | (string & {});

/** A next hop: an id to recall, how it relates, and one line about it. */
export interface RecallLink {
  id: string;
  rel: string;
  summary: string;
}

/** An object as recall sees it: rendered under the Inline & Spill budgets. */
export interface RecallNode {
  id: string;
  kind: RecallKind;
  title: string;
  attrs: [string, string][];
  /** The full content; only the start is inlined, the rest is a read-more away. */
  body: string;
  /** Content from the environment (pages, files, tool output): rendered as data, not instructions. */
  untrusted?: boolean;
  /** Neighbours: the previous and next message, the message it answers. */
  around: RecallLink[];
  links: RecallLink[];
}

export interface RecallResult {
  id: string;
  /** What the agent reads. */
  text: string;
  node: RecallNode;
  /** Estimated tokens of text. */
  tokens: number;
}

export interface RouterSettings {
  /** Group chats get a Router that talks to the user and dispatches Workers; needs superAgent.enabled. */
  enabled: boolean;
  /** The Router's model: routing and short replies need no more than a lighter one. */
  model: string;
  /** The Workers' model; empty = the chat's model switch, else the default model in Settings. */
  workerModel: string;
  /** Workers active at once in one chat. */
  maxWorkers: number;
}

export type WorkerStatus = 'starting' | 'running' | 'waiting' | 'done' | 'error' | 'stopped';

/** One task a Router dispatched: its own session with full tools, in its own workspace, reporting back to the Router. */
export interface Worker {
  id: ID;
  /** The chat whose Router dispatched it. */
  chatId: ID;
  /** The member it runs as: role, permission level, editable paths, rules and budget. */
  botId: ID;
  title: string;
  /** The brief the Router wrote. */
  task: string;
  status: WorkerStatus;
  /** What it is waiting for, what it is preparing, or why it failed. */
  detail?: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  sessionId?: string;
  /** Where it works: its own workspace (a Project with workspace.workerId), or the chat's folder. */
  projectId: ID | null;
  /** Why it works in the chat's folder instead of a workspace of its own. */
  shared?: string;
  /** The commit its branch started from, and its last commit merged into the chat's branch. */
  base?: string;
  landedHead?: string;
  /** Its last turn's report to the Router. */
  report?: { at: number; status: 'done' | 'error' | 'stopped'; text: string };
  /** What Crew did with its changes after its last turn. */
  landing?: { at: number; files: string[]; commit?: string; conflicts?: string[]; error?: string };
  turns: number;
  costUsd: number;
  /** Ids of the triggers and messages of the batch that dispatched it. */
  related: ID[];
  /** Follow-ups from the Router waiting for the current turn to end. */
  pending?: string[];
  dismissedAt?: number;
}

/** A chat's Router as it is right now (not stored). */
export interface RouterInfo {
  chatId: ID;
  state: 'idle' | 'thinking' | 'error';
  /** Events waiting for its next turn. */
  queued: number;
  detail?: string;
  since: number;
}

/** Where a Trigger's full content is. */
export type TriggerRef =
  | { kind: 'message'; chatId: ID; messageId: ID }
  | { kind: 'routine'; routineId: ID; chatId: ID; messageId: ID }
  /** Stored beside the log (triggers/payloads/<id>.json): the event has no other home. */
  | { kind: 'payload' };

export interface TriggerFilter {
  /** candidate: waiting for the slow path. */
  verdict: 'act' | 'candidate' | 'drop';
  /** Who decided: rules in code, or the cheap model. */
  stage: 'fast' | 'slow';
  /** The rule that settled it, e.g. explicit-request, duplicate, not-allow-listed, policy. */
  rule: string;
  reason: string;
  slow?: { backend: string; costUsd: number; batch: number; decidedAt: number; invalid?: string };
  /** The notice an act decision posted. */
  delivered?: { chatId: ID; messageId: ID };
}

/** A semi-structured environment event: small by itself, with ids pointing at everything else. */
export interface Trigger {
  id: ID;
  at: number;
  source: TriggerSource;
  threadId: ID;
  projectId: ID | null;
  chatId: ID | null;
  /** One line, at most 200 characters. */
  summary: string;
  ref: TriggerRef;
  /** Ids of tightly related objects: the request a turn answered, the notes an edit produced. */
  related: ID[];
  /** The user, or the user's routine or a bot's handoff, asked for this. */
  explicit: boolean;
  /** Stable hash of the content, for de-duplication. */
  fingerprint: string;
  filter: TriggerFilter;
  /** What acting meant, e.g. "Sent to Chief". */
  action?: string;
}

/** A stream of related Triggers: one chat topic, one routine, or one workspace. */
export interface Thread {
  id: ID;
  /** chat:<chatId> | routine:<routineId> | workspace:<projectId> */
  key: string;
  kind: 'chat' | 'routine' | 'workspace';
  title: string;
  projectId: ID | null;
  chatId: ID | null;
  createdAt: number;
  lastAt: number;
  count: number;
  lastTriggerId?: ID;
  /** When an act decision last told the user about this thread (for the cooldown). */
  lastNoticeAt?: number;
  /** A chat thread closes when the chat starts a new topic; the next Trigger opens a new thread. */
  closedAt?: number;
}

export interface TriggerList {
  enabled: boolean;
  triggers: Trigger[];
  threads: Record<ID, Thread>;
  /** Over everything still in the log. */
  stats: { total: number; act: number; drop: number; candidate: number; slowCalls: number; slowCostUsd: number };
}

/** A Trigger with its payload resolved ("read more") and its neighbours, for walking the graph. */
export interface TriggerDetail {
  trigger: Trigger;
  thread: Thread | null;
  /** The full content, as text (cut at 20,000 characters). */
  detail: string;
  related: Trigger[];
  /** The thread's latest Triggers, newest first. */
  recent: Trigger[];
}

/** Claude Code's command sandbox: commands are confined, and reach only these domains (plus this machine). */
export interface SandboxSettings {
  enabled: boolean;
  /** Hosts commands may connect to, e.g. "registry.npmjs.org", "*.githubusercontent.com", "10.0.0.5:8080". */
  allowedDomains: string[];
}

export interface SandboxStatus {
  available: boolean;
  /** Programs it needs that are not installed (Linux: bubblewrap, socat). */
  missing: string[];
  /** What to do about it. */
  hint?: string;
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
  /** The role's capability profile: what it costs and what it may touch, not only how it talks. */
  model?: string;
  effort?: Effort;
  editScope?: string[];
  freshSession?: boolean;
  blindReview?: boolean;
  /** Added to the default "always allow" rules for this role. */
  allowRules?: string[];
  plugins?: string[];
}

/** Where the turn's trajectory is: Claude Code's transcript for the session, between these times. */
export interface TraceRef {
  sessionId: string;
  cwd: string;
  from: number;
  to: number;
}

export interface TraceUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
}

export type TraceBlock = { type: 'thinking'; text: string } | { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: string };

export type TraceStep =
  /** One API call: what the model was asked at this point, and what it answered. */
  | { kind: 'model'; at: number; waitMs: number; model: string; effort?: string; sidechain: boolean; usage: TraceUsage; blocks: TraceBlock[] }
  | { kind: 'tool_result'; at: number; waitMs: number; toolUseId: string; isError: boolean; text: string }
  /** What Crew (or a sub-agent) sent as the user message. */
  | { kind: 'prompt'; at: number; text: string; sidechain: boolean }
  /** Something Claude Code attached on its own (sandbox instructions, reminders). */
  | { kind: 'attachment'; at: number; type: string };

export interface TraceTotals {
  calls: number;
  tools: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  durationMs: number;
}

export type TurnTrace = { available: false; reason: string } | { available: true; sessionId: string; file: string; steps: TraceStep[]; totals: TraceTotals };

/** The bot settings an improvement may change: one field of one bot at a time. */
export type ImprovableField = 'description' | 'model' | 'effort' | 'permission' | 'allowRules' | 'askRules' | 'editScope' | 'freshSession' | 'monthlyBudgetUsd' | 'skill';

/** A skill learned from a turn, waiting for the user: the skill and what the safety screen found. */
export interface SkillDraft {
  name: string;
  title: string;
  description: string;
  icon: string;
  argsHint: string;
  body: string;
  /** Things the user should look at before accepting (must-ask commands, hosts outside the sandbox). */
  flags: string[];
}

/** A turn worth learning from: it finished, took real work, and was not refuted. */
export interface SkillCandidate {
  chatId: ID;
  messageId: ID;
  chatTitle: string;
  botName: string;
  ask: string;
  tools: number;
  at: number;
}

/** A proposed change to a bot's setup, backed by evidence from real turns; the user decides. */
export type FrictionKind = 'stall' | 'hop-limit' | 'approval-denied' | 'approval-readonly' | 'approval-slow' | 'outside-edit' | 'turn-error';

/** A moment Crew got in the way (server/friction.ts). `key` groups events with the same cause. */
export interface FrictionEvent {
  at: number;
  kind: FrictionKind;
  key: string;
  detail: string;
  chatId?: ID;
  chatTitle?: string;
  botName?: string;
}

export interface FrictionReport {
  days: number;
  since: number;
  total: number;
  kinds: { kind: FrictionKind; label: string; count: number; groups: { key: string; count: number; examples: FrictionEvent[] }[] }[];
  /** A message for a group working on Crew itself; {lead} stands for its lead's name. Empty when nothing happened. */
  brief: string;
}

export interface Improvement {
  id: ID;
  createdAt: number;
  botId: ID;
  botName: string;
  field: ImprovableField;
  before: unknown;
  after: unknown;
  /** Why, in a few sentences, pointing at what happened. */
  rationale: string;
  /** What should get better, so the effect can be checked later. */
  expected: string;
  evidence: { chatId: ID; messageId: ID; note: string }[];
  status: 'pending' | 'accepted' | 'rejected' | 'reverted' | 'stale';
  /** The proposal as the model wrote it, when the user edited it before deciding. */
  original?: unknown;
  editedAt?: number;
  decidedAt?: number;
  /** The user's reason when rejecting. */
  note?: string;
}

/** How the bot did before and after an accepted change (same number of turns each side, at most). */
export interface ImprovementEffect {
  before: { turns: number; avgCostUsd: number; refuted: number; errors: number };
  after: { turns: number; avgCostUsd: number; refuted: number; errors: number };
}

/** One shadow routing decision: who a cheap router would have picked, and how sure it was. */
export interface RoutingRecord {
  id: ID;
  at: number;
  chatId: ID;
  messageId: ID;
  text: string;
  candidates: { id: ID; name: string }[];
  /** The lead the message actually went to. */
  leadId: ID;
  backend: string;
  choice?: ID;
  /** Largest probability after averaging both candidate orders. */
  confidence?: number;
  probs?: Record<ID, number>;
  costUsd: number;
  /** The router's answer was unusable; counts as "escalate". */
  invalid?: string;
}

export interface RoutingReport {
  mode: 'off' | 'shadow';
  /** Records whose outcome is known (the lead answered and handed over to at most one teammate). */
  labeled: number;
  agreement: number | null;
  bins: { lo: number; hi: number; n: number; correct: number }[];
  /** Local labels still needed before a threshold is suggested. */
  needed: number;
  /**
   * How well confidence separates right from wrong guesses: the chance a random right guess was more
   * confident than a random wrong one. 0.5 is no better than chance. Null until both kinds exist.
   */
  auroc: number | null;
  /** Guesses at confidence >= 0.9 and how many of them were wrong: what a gate would let through wrongly. */
  confident: { n: number; wrong: number };
  /** The smallest threshold whose accepted decisions are accurate enough, judged by a lower bound. */
  threshold: { tau: number; coverage: number; accuracy: number; lower: number } | null;
  /** What the lead's routing-only turns cost on average: what a confident route would save each time. */
  avgRoutingTurnUsd: number | null;
  costUsd: number;
  recent: (RoutingRecord & { label?: ID | 'multi' | null })[];
}

export interface ModelOption {
  id: string;
  label: string;
  /** Rough price class, for choosing a role's model. */
  tier?: 'high' | 'mid' | 'low';
}

/** What a bot's turns cost over a period. */
export interface TurnTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface BotUsage {
  costUsd: number;
  turns: number;
  durationMs: number;
  /** Summed over the turns that recorded tokens (`tokenTurns` of them). */
  tokens: TurnTokens;
  tokenTurns: number;
  /** The turn that re-read the most from the cache. */
  peak?: { chatId: string; messageId: string; cacheRead: number };
}

export interface UsageSummary {
  today: BotUsage;
  month: BotUsage;
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
  /** Two-layer mode: Workers not yet dismissed, and the Routers that exist. */
  workers: Worker[];
  routers: RouterInfo[];
  devServers: DevServerState[];
  previews: PreviewInfo[];
  models: ModelOption[];
  /** botId → spend today and this month. */
  usage: Record<ID, UsageSummary>;
  providers: ProviderPreset[];
  features: { pty: boolean; browser: boolean; sandbox: SandboxStatus };
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
  | { t: 'usage'; usage: Record<ID, UsageSummary> }
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
  | { t: 'trigger'; trigger: Trigger; thread: Thread }
  | { t: 'worker'; worker: Worker }
  | { t: 'worker_deleted'; id: ID }
  | { t: 'router'; router: RouterInfo }
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
