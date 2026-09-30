import os from 'node:os';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalPart, Attachment, Bot, BotStatus, Chat, ChatMessage, MessageTrigger, Project } from '../shared/types';
import { bus, internal, notify } from './bus';
import { cleanEnv } from './config';
import { botModel, modelEnv } from './claudeAuth';
import { PLUGINS } from './data/catalog';
import { chatProjectId, configOf, devCommand, HttpError, touchProject } from './projects';
import { bots, chats, messages, projects, settings, uid } from './store';
import { skills } from './skills';
import { readUpload, IMAGE_MIMES } from './uploads';
import { ensureWatch } from './watcher';
import { devServer } from './devserver';
import { autoCommit, commitSubject, gitError } from './gitops';
import { resetActSession } from './browser';
import { crewServer } from './agents/crewTools';
import { decide, describeAction, permissionModeFor, rulesTouch, suggestRules } from './agents/permissions';
import { buildSystemAppend, buildTurnPrompt } from './agents/prompts';
import { summarize, TurnRecorder } from './agents/recorder';
import { BotSession, FakeSession, type AgentSession, type SessionConfig } from './agents/session';
import { TurnStream } from './agents/stream';

const FAKE = process.env.CREW_FAKE_AGENT === '1';
const IDLE_CLOSE_MS = 15 * 60_000;

interface Job {
  chatId: string;
  botId: string;
  trigger: MessageTrigger;
  hopsLeft: number;
  routineName?: string;
}

interface Running {
  job: Job;
  msg: ChatMessage;
  session: AgentSession;
  stream: TurnStream;
}

interface PendingApproval {
  chatId: string;
  botId: string;
  part: ApprovalPart;
  stream: TurnStream;
  resolve: (d: { allow: boolean; always?: boolean; message?: string; expired?: boolean }) => void;
}

const queues = new Map<string, Job[]>();
const running = new Map<string, Running>();
const sessions = new Map<string, AgentSession>();
/** Sessions to recreate once their current turn ends (bot settings changed). */
const staleSessions = new Set<string>();
const statuses = new Map<string, BotStatus>();
const approvals = new Map<string, PendingApproval>();
/** Chats whose workspace is being changed by git (merge, sync…): new turns wait until it is done. */
const locked = new Set<string>();
/** Chats waiting for their workspace's setup command (see holdTurns). */
const preparing = new Set<string>();
/** projectId -> page the user is looking at in the preview. */
const previewPages = new Map<string, string>();
/** projectId -> when a bot turn in it last ended. */
const lastTurnEnd = new Map<string, number>();

const sessionKey = (chatId: string, botId: string) => `${chatId}:${botId}`;

// ---------------------------------------------------------------- status

export function botStatuses(): Record<string, BotStatus> {
  return Object.fromEntries(statuses);
}

function setStatus(botId: string, status: Omit<BotStatus, 'since'>) {
  const prev = statuses.get(botId);
  if (prev && prev.state === status.state && prev.detail === status.detail && prev.chatId === status.chatId) return;
  const s = { ...status, since: prev?.state === status.state ? prev.since : Date.now() };
  statuses.set(botId, s);
  bus.emit({ t: 'bot_status', botId, status: s });
}

/** Idle unless the bot still has work queued or running somewhere. */
function settleStatus(botId: string, error?: string) {
  for (const [chatId, r] of running) if (r.job.botId === botId) return setStatus(botId, { state: 'thinking', chatId });
  for (const [chatId, q] of queues) if (q.some((j) => j.botId === botId)) return setStatus(botId, { state: 'queued', chatId });
  setStatus(botId, error ? { state: 'error', detail: error } : { state: 'idle' });
}

export function setPreviewPage(projectId: string, page: string) {
  previewPages.set(projectId, page);
}

// ---------------------------------------------------------------- helpers

function preview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/[#>*_`~\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function setLastMessage(chat: Chat, msg: ChatMessage) {
  const author = msg.role === 'user' ? '你' : msg.role === 'system' ? '系统' : bots.get(msg.botId)?.name || '机器人';
  const text = msg.role === 'bot' && !msg.text && msg.error ? `⚠️ ${msg.error}` : preview(msg.text) || (msg.attachments?.length ? '[附件]' : '');
  chat.lastMessage = { text, ts: msg.ts, author };
  chat.updatedAt = msg.ts;
}

function emitChat(chat: Chat) {
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
}

export function systemMessage(chat: Chat, text: string, opts: { uiOnly?: boolean } = {}): ChatMessage {
  const msg: ChatMessage = { id: uid('m_'), chatId: chat.id, seq: ++chat.seq, ts: Date.now(), role: 'system', text, uiOnly: opts.uiOnly || undefined };
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  setLastMessage(chat, msg);
  emitChat(chat);
  return msg;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bots @mentioned in the text, in order of first appearance. */
export function parseMentions(text: string, candidates: Bot[]): Bot[] {
  if (!candidates.length || !text.includes('@')) return [];
  const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`@(${sorted.map((b) => escapeRe(b.name)).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  const found: Bot[] = [];
  // Mentions inside code are examples, not handoffs.
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const m of clean.matchAll(re)) {
    const bot = sorted.find((b) => b.name.toLowerCase() === m[1].toLowerCase());
    if (bot && !found.includes(bot)) found.push(bot);
  }
  return found;
}

const ALL_RE = /@(所有人|全体|all|everyone)(?![A-Za-z0-9_-])/i;

/** The bots' environment: which endpoint, credentials and models their Claude Code uses. */
function agentEnv(): Record<string, string> {
  return cleanEnv(modelEnv());
}

function substitute(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? process.env[k] ?? '');
}

/** MCP servers for a bot: enabled catalog plugins plus custom entries. */
function pluginServers(bot: Bot): Record<string, McpServerConfig> {
  const secrets = settings.get().pluginSecrets || {};
  const out: Record<string, McpServerConfig> = {};
  const add = (name: string, e: (typeof PLUGINS)[number]['server']) => {
    if (e.type === 'http' || e.type === 'sse') {
      out[name] = {
        type: e.type,
        url: substitute(e.url || '', secrets),
        headers: Object.fromEntries(Object.entries(e.headers || {}).map(([k, v]) => [k, substitute(v, secrets)])),
      };
    } else if (e.command) {
      out[name] = {
        type: 'stdio',
        command: e.command,
        args: (e.args || []).map((a) => substitute(a, secrets)),
        env: Object.fromEntries(Object.entries(e.env || {}).map(([k, v]) => [k, substitute(v, secrets)])),
      };
    }
  };
  for (const id of bot.plugins || []) {
    const p = PLUGINS.find((x) => x.id === id);
    if (p) add(p.id, p.server);
  }
  for (const [name, e] of Object.entries(bot.mcpServers || {})) {
    if (name !== 'crew') add(name, e);
  }
  return out;
}

function contextLines(project: Project | null): string[] {
  const now = new Date();
  const week = '日一二三四五六'[now.getDay()];
  const lines = [`时间：${now.toLocaleString('zh-CN', { hour12: false })}（周${week}）`];
  if (!project) return lines;
  const cmd = devCommand(project);
  const ds = devServer(project.id).state;
  if (!cmd) lines.push('预览：静态网页，由 Crew 直接提供，保存文件后自动刷新。');
  else if (ds.status === 'running') lines.push(`开发服务器：运行中 ${ds.url}（命令 ${ds.command}）`);
  else if (ds.status === 'installing' || ds.status === 'starting') lines.push(`开发服务器：${ds.status === 'installing' ? '正在安装依赖' : '正在启动'}（${cmd}）`);
  else lines.push(`开发服务器：未运行（需要 ${cmd}，可以用 dev_server 工具启动）${ds.error ? `，上次错误：${ds.error}` : ''}`);
  const page = previewPages.get(project.id);
  if (page) lines.push(`用户正在预览的页面：${page}`);
  const conf = configOf(project);
  const denied = settings.get().denyRules || [];
  if (denied.length) lines.push(`禁止的操作（系统会直接拒绝，不要尝试，也不要换写法绕过）：${denied.join('、')}`);
  if (conf.commitGuide) lines.push(`这个项目的提交信息要求：${conf.commitGuide}`);
  if (conf.noAttribution) lines.push('这个项目的提交和 PR 里不要加任何 AI 署名（Co-Authored-By、Generated with 之类）。');
  return lines;
}

function imageBlocks(list: ChatMessage[]) {
  const out: { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }[] = [];
  for (const m of list) {
    for (const a of m.attachments || []) {
      if (a.kind !== 'image' || !IMAGE_MIMES.has(a.mime)) continue;
      const img = readUpload(a.url);
      if (img) out.push({ type: 'image', source: { type: 'base64', media_type: img.mime as 'image/png', data: img.data } });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- sessions

function getSession(chat: Chat, bot: Bot, project: Project | null): AgentSession {
  const key = sessionKey(chat.id, bot.id);
  const existing = sessions.get(key);
  if (existing && !existing.closed && !staleSessions.has(key)) return existing;
  if (existing) existing.close();
  staleSessions.delete(key);

  const team = bots.all();
  const conf = project ? configOf(project) : null;
  const eff = effectiveBot(chat, bot);
  const cfg: SessionConfig = {
    cwd: project?.path || os.homedir(),
    model: botModel(eff.model),
    effort: eff.effort || undefined,
    systemAppend: buildSystemAppend({ bot: eff, chat, project, team, skills: skills.list() }),
    resume: chat.sessions[bot.id],
    permissionMode: permissionModeFor(eff.permission),
    allowRules: [...bot.allowRules, 'mcp__crew'],
    askRules: [...bot.askRules, ...(conf?.askRules || [])],
    denyRules: settings.get().denyRules || [],
    deniedReason: (toolName, input) => deniedReason(toolName, input, project?.path || os.homedir()),
    attributionOff: !!conf?.noAttribution,
    mcpServers: {
      crew: crewServer({
        botId: bot.id,
        botName: bot.name,
        chatId: chat.id,
        projectId: () => chatProjectId(chats.get(chat.id)),
        currentPage: () => {
          const pid = chatProjectId(chats.get(chat.id));
          return pid ? previewPages.get(pid) : undefined;
        },
      }) as McpServerConfig,
      ...pluginServers(bot),
    },
    settingSources: bot.loadUserSettings ? ['user', 'project', 'local'] : ['project', 'local'],
    env: agentEnv(),
  };
  const onSessionId = (sid: string) => {
    const c = chats.get(chat.id);
    if (!c || c.sessions[bot.id] === sid) return;
    c.sessions[bot.id] = sid;
    chats.save();
  };
  const members = team.filter((b) => chat.botIds.includes(b.id)).map((b) => b.name);
  const session = FAKE ? new FakeSession(cfg, bot.name, members, onSessionId) : new BotSession(cfg, onSessionId);
  sessions.set(key, session);
  return session;
}

function closeSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  if (s.busy) {
    staleSessions.add(key);
    return;
  }
  s.close();
  sessions.delete(key);
}

/** Remembers how full the bot's context is after its turn: the composer's ring shows it. */
async function recordContext(chatId: string, botId: string, session: AgentSession) {
  const usage = await session.contextUsage?.().catch(() => null);
  const chat = chats.get(chatId);
  if (!usage || !chat || !chat.botIds.includes(botId)) return;
  chat.context = { ...chat.context, [botId]: { ...usage, at: Date.now() } };
  emitChat(chat);
}

/**
 * A bot as it works in this chat: the chat's switches (composer) override its own settings. A
 * read-only bot (a reviewer, say) stays read-only; that is its role, changed on the bot itself.
 */
export function effectiveBot(chat: Chat, bot: Bot): Bot {
  return {
    ...bot,
    permission: bot.permission === 'plan' ? 'plan' : chat.permission || bot.permission,
    model: chat.model !== undefined ? chat.model : bot.model,
    effort: chat.effort !== undefined ? chat.effort : bot.effort,
  };
}

/**
 * The chat's switches changed. A running turn switches its permission mode at once; model and
 * effort (and the mode, for the rest) apply from the next turn, when the sessions restart.
 */
export function applyChatSettings(chatId: string) {
  const chat = chats.get(chatId);
  const r = running.get(chatId);
  if (chat && r) {
    const bot = bots.get(r.job.botId);
    if (bot) r.session.setPermissionMode?.(permissionModeFor(effectiveBot(chat, bot).permission));
  }
  invalidateChat(chatId);
}

/** Bot settings changed: its processes restart with the new configuration on the next turn. */
export function invalidateBot(botId: string) {
  for (const key of [...sessions.keys()]) if (key.endsWith(`:${botId}`)) closeSession(key);
}

export function invalidateChat(chatId: string) {
  for (const key of [...sessions.keys()]) if (key.startsWith(`${chatId}:`)) closeSession(key);
}

export function invalidateAllSessions() {
  for (const key of [...sessions.keys()]) closeSession(key);
}

/** Why the action is refused outright (Settings → 默认值 → 禁止的操作), or null. Read fresh on every call. */
function deniedReason(toolName: string, input: unknown, cwd: string): string | null {
  const rules = settings.get().denyRules || [];
  if (!rules.length || !rulesTouch(rules, toolName, input, cwd)) return null;
  return `这个操作被禁止了（设置 → 默认值 → 禁止的操作：${rules.join('、')}）。不要换一种写法绕过它；需要的话请用户自己来做。`;
}

/** A project's settings changed: bots working there (or in its workspaces) restart with them. */
export function invalidateProject(projectId: string) {
  for (const c of chats.all()) {
    const pid = chatProjectId(c);
    if (pid && (pid === projectId || projects.get(pid)?.workspace?.parentId === projectId)) invalidateChat(c.id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (!s.busy && now - s.lastUsed > IDLE_CLOSE_MS) {
      s.close();
      sessions.delete(key);
    }
  }
}, 60_000).unref();

// ---------------------------------------------------------------- queue

function enqueue(job: Job) {
  const q = queues.get(job.chatId) || [];
  if (q.some((j) => j.botId === job.botId)) return;
  const r = running.get(job.chatId);
  q.push(job);
  queues.set(job.chatId, q);
  if (!r || r.job.botId !== job.botId) setStatus(job.botId, { state: 'queued', chatId: job.chatId });
  void pump(job.chatId);
}

async function pump(chatId: string) {
  if (running.has(chatId) || locked.has(chatId) || preparing.has(chatId)) return;
  const q = queues.get(chatId);
  const job = q?.shift();
  if (!job) return;
  try {
    await runTurn(job);
  } catch (e) {
    console.error('[orchestrator] turn crashed', e);
  } finally {
    running.delete(chatId);
    settleStatus(job.botId);
    void pump(chatId);
  }
}

export function isChatBusy(chatId: string) {
  return running.has(chatId) || !!queues.get(chatId)?.length || locked.has(chatId) || preparing.has(chatId);
}

/** Holds a chat's bot turns until `work` settles, e.g. a new workspace's setup command; messages sent meanwhile wait. */
export function holdTurns(chatId: string, work: Promise<unknown>) {
  preparing.add(chatId);
  const done = () => {
    preparing.delete(chatId);
    void pump(chatId);
  };
  work.then(done, done);
}

/**
 * Runs a git operation on a chat's workspace while no bot turn can start there (messages sent
 * meanwhile stay queued). Refuses when a turn is running or another operation is in progress.
 */
export async function withChatLocked<T>(chatId: string, what: string, fn: () => Promise<T>): Promise<T> {
  if (preparing.has(chatId)) throw new HttpError(409, `工作区还在准备，等准备好再${what}`);
  if (running.has(chatId) || !!queues.get(chatId)?.length) throw new HttpError(409, `机器人正在工作，等这一轮结束再${what}`);
  if (locked.has(chatId)) throw new HttpError(409, '上一个操作还没完成，请稍等');
  locked.add(chatId);
  try {
    return await fn();
  } finally {
    locked.delete(chatId);
    void pump(chatId);
  }
}

/** A bot turn is running in the project (or workspace) right now. */
export function projectRunning(projectId: string): boolean {
  for (const r of running.values()) if (chatProjectId(chats.get(r.job.chatId)) === projectId) return true;
  return false;
}

/** A bot is working in the project, or just finished (its file events are still arriving). */
export function projectBusy(projectId: string): boolean {
  return projectRunning(projectId) || Date.now() - (lastTurnEnd.get(projectId) || 0) < 4000;
}

// ---------------------------------------------------------------- turns

async function runTurn(job: Job) {
  const chat = chats.get(job.chatId);
  const bot = bots.get(job.botId);
  if (!chat || !bot || !chat.botIds.includes(bot.id)) return;
  // A chat with an isolated workspace works in its worktree instead of the project folder.
  const project = projects.get(chatProjectId(chat)) ?? null;
  if (project) {
    ensureWatch(project.id);
    touchProject(project.id);
  }

  const cursor = chat.cursors[bot.id] ?? 0;
  const unseen = messages.sorted(chat.id).filter((m) => m.seq > cursor && !m.uiOnly && !(m.role === 'bot' && m.botId === bot.id) && m.status !== 'streaming');

  const msg: ChatMessage = {
    id: uid('m_'),
    chatId: chat.id,
    seq: ++chat.seq,
    ts: Date.now(),
    role: 'bot',
    botId: bot.id,
    text: '',
    parts: [],
    status: 'streaming',
    trigger: job.trigger,
    turnId: uid('t_'),
  };
  chat.cursors[bot.id] = msg.seq;
  chats.save();
  // Persisted right away so a restart mid-turn leaves a "stopped" message, not a gap.
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  setStatus(bot.id, { state: 'thinking', chatId: chat.id });

  const names = new Map(bots.all().map((b) => [b.id, b.name]));
  const promptText = buildTurnPrompt({ bot, chat, unseen, names, context: contextLines(project), trigger: job.trigger, routineName: job.routineName });
  const imgs = imageBlocks(unseen.filter((m) => m.role === 'user'));
  const content = imgs.length ? [{ type: 'text' as const, text: promptText }, ...imgs] : promptText;

  const recorder = project ? new TurnRecorder({ id: msg.turnId!, chatId: chat.id, botId: bot.id, messageId: msg.id, projectId: project.id }, project.path) : null;
  const onFiles = (pid: string, paths: string[]) => {
    if (project && pid === project.id) recorder?.watched(paths);
  };
  internal.on('files', onFiles);

  let lastActivity = '';
  const stream = new TurnStream(msg, (state, detail) => {
    const key = state + (detail || '');
    if (key === lastActivity) return;
    lastActivity = key;
    setStatus(bot.id, { state, detail, chatId: chat.id });
  });

  const cwd = project?.path || os.homedir();
  const hooks = {
    onMessage: (m: Parameters<TurnStream['handle']>[0]) => stream.handle(m),
    beforeEdit: (fp: string | undefined) => recorder?.beforeEdit(fp),
    canUseTool: async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; matchedAskRule?: unknown; decisionReason?: string; title?: string }) => {
      const current = bots.get(bot.id) || bot;
      const refused = deniedReason(toolName, input, cwd);
      if (refused) return { behavior: 'deny' as const, message: refused };
      // The project's own "must ask" rules apply to every bot working there.
      const projectRules = project ? configOf(project).askRules || [] : [];
      // The chat's mode switch is read each time: switching to 自动 applies to the running turn too.
      const level = effectiveBot(chats.get(chat.id) || chat, current).permission;
      const d = decide(projectRules.length ? { ...current, askRules: [...current.askRules, ...projectRules] } : current, level, toolName, input, cwd, opts);
      if (d.behavior === 'allow') return { behavior: 'allow' as const, updatedInput: input };
      if (d.behavior === 'deny') return { behavior: 'deny' as const, message: d.message };
      const desc = describeAction(toolName, input, cwd);
      const part: ApprovalPart = {
        type: 'approval',
        id: uid('a_'),
        toolName,
        input: slimInput(input),
        title: desc.title,
        detail: desc.detail,
        status: 'pending',
        rule: undefined,
        rules: suggestRules(toolName, input, cwd),
        reason: opts.decisionReason,
      };
      part.rule = part.rules?.[0];
      stream.addPart(part);
      setStatus(bot.id, { state: 'waiting', detail: desc.title, chatId: chat.id });
      notify(`${bot.name} 需要你的确认`, desc.title, { chatId: chat.id, level: 'warn' });
      const decision = await new Promise<{ allow: boolean; always?: boolean; message?: string; expired?: boolean }>((resolve) => {
        approvals.set(part.id, { chatId: chat.id, botId: bot.id, part, stream, resolve });
        opts.signal?.addEventListener('abort', () => resolve({ allow: false, expired: true }), { once: true });
      });
      approvals.delete(part.id);
      part.status = decision.allow ? 'allowed' : decision.expired ? 'expired' : 'denied';
      stream.updatePart(part);
      setStatus(bot.id, { state: 'tool', detail: toolName, chatId: chat.id });
      const newRules = (part.rules || []).filter(Boolean);
      if (decision.allow && decision.always && newRules.length) {
        const b = bots.get(bot.id);
        if (b && newRules.some((r) => !b.allowRules.includes(r))) {
          b.allowRules = [...new Set([...b.allowRules, ...newRules])];
          b.updatedAt = Date.now();
          bots.set(b);
          bus.emit({ t: 'bot', bot: b });
        }
      }
      if (decision.allow) return { behavior: 'allow' as const, updatedInput: input };
      return {
        behavior: 'deny' as const,
        message: decision.message ? `用户拒绝了这个操作，并说：${decision.message}` : '用户拒绝了这个操作。请换一种做法，或者先问问用户。',
      };
    },
  };

  let session = getSession(chat, bot, project);
  running.set(chat.id, { job, msg, session, stream });
  try {
    let result;
    try {
      result = await session.run(content, hooks);
    } catch (e) {
      // A stale resume id fails before anything streams: start a fresh session once.
      const resumeFailed = !!chat.sessions[bot.id] && !stream.parts.length && !stream.stopped && /conversation|session|resume/i.test(String((e as Error)?.message));
      if (!resumeFailed) throw e;
      delete chat.sessions[bot.id];
      chats.save();
      sessions.delete(sessionKey(chat.id, bot.id));
      session = getSession(chat, bot, project);
      running.set(chat.id, { job, msg, session, stream });
      result = await session.run(content, hooks);
    }
    stream.finish(result);
    void recordContext(chat.id, bot.id, session);
  } catch (e) {
    stream.fail(e);
    sessions.get(sessionKey(chat.id, bot.id))?.close();
    sessions.delete(sessionKey(chat.id, bot.id));
  } finally {
    internal.off('files', onFiles);
    for (const [id, a] of approvals) {
      if (a.stream === stream) {
        a.resolve({ allow: false, expired: true });
        approvals.delete(id);
      }
    }
    if (staleSessions.has(sessionKey(chat.id, bot.id))) closeSession(sessionKey(chat.id, bot.id));
  }

  if (project) lastTurnEnd.set(project.id, Date.now());
  const turn = recorder?.finish();
  if (turn) {
    msg.changes = { files: turn.files.map((f) => f.path) };
    bus.emit({ t: 'turn', turn: summarize(turn) });
  }
  msg.text = stream.finalText();
  // In a workspace every turn becomes a commit on the chat's branch.
  let unresolved: string[] | undefined;
  let commitError: string | undefined;
  if (project?.workspace) {
    try {
      unresolved = (await autoCommit(project.workspace.worktree, `${bot.name}：${commitSubject(msg.text, '更新文件')}`)).unresolved;
    } catch (e) {
      commitError = gitError(e);
      console.warn('[workspace] auto-commit failed:', commitError);
    }
  }
  messages.put(msg);
  bus.emit({ t: 'msg', msg });

  const fresh = chats.get(chat.id);
  if (!fresh) return;
  setLastMessage(fresh, msg);
  fresh.unread = (fresh.unread || 0) + 1;
  emitChat(fresh);
  if (unresolved?.length) systemMessage(fresh, `合并还没完成：${unresolved.join('、')} 还有冲突没处理（冲突标记，或者需要 git add / git rm 的文件）。处理完之后才会提交。`);
  if (commitError && project?.workspace) {
    systemMessage(fresh, `没能把这一轮的改动提交到分支 ${project.workspace.branch}：${commitError}。改动还在工作区的文件里，但在解决这个问题之前没法合并。`, { uiOnly: true });
  }
  settleStatus(bot.id, msg.status === 'error' ? msg.error?.slice(0, 80) : undefined);
  if (msg.status === 'error') notify(`${bot.name} 出错了`, msg.error?.slice(0, 140) || '', { chatId: chat.id, level: 'error' });
  else if (msg.status === 'done') notify(`${bot.name} 完成了`, preview(msg.text).slice(0, 100) || '任务完成', { chatId: chat.id, level: 'success' });

  // Bot-to-bot handoffs.
  if (msg.status === 'done' && fresh.kind === 'group') {
    const members = bots.all().filter((b) => fresh.botIds.includes(b.id) && b.id !== bot.id);
    const mentioned = ALL_RE.test(msg.text) ? members : parseMentions(msg.text, members);
    if (mentioned.length) {
      if (job.hopsLeft > 0) {
        for (const m of mentioned) enqueue({ chatId: fresh.id, botId: m.id, trigger: { type: 'mention', by: bot.id }, hopsLeft: job.hopsLeft - 1 });
      } else {
        systemMessage(fresh, `自动接力已达到上限（${fresh.maxHops} 次）。回复一条消息即可让大家继续。`, { uiOnly: true });
      }
    }
  }
}

function slimInput(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 20_000 ? v.slice(0, 20_000) + '…' : v;
  return out;
}

// ---------------------------------------------------------------- public API

export function sendUserMessage(chatId: string, input: { text: string; attachments?: Attachment[] }): ChatMessage {
  const chat = chats.get(chatId);
  if (!chat) throw new Error('对话不存在');
  const text = input.text.trim();
  if (!text && !input.attachments?.length) throw new Error('消息不能为空');
  const expanded = skills.expand(text);
  const msg: ChatMessage = {
    id: uid('m_'),
    chatId,
    seq: ++chat.seq,
    ts: Date.now(),
    role: 'user',
    text,
    attachments: input.attachments?.length ? input.attachments : undefined,
    trigger: { type: 'user' },
  };
  if (expanded.skill) {
    msg.prompt = expanded.text;
    msg.skill = expanded.skill.name;
  }
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  setLastMessage(chat, msg);
  chat.unread = 0;

  let targets: Bot[] = [];
  const allBots = bots.all();
  if (chat.kind === 'dm') {
    const b = bots.get(chat.botIds[0]);
    if (b) targets = [b];
  } else {
    // Mentioning someone outside the group invites them in.
    const outsiders = parseMentions(text, allBots.filter((b) => !chat.botIds.includes(b.id)));
    if (outsiders.length) {
      chat.botIds.push(...outsiders.map((b) => b.id));
      for (const b of outsiders) chat.cursors[b.id] = msg.seq - 1;
      invalidateChat(chat.id);
      emitChat(chat);
      systemMessage(chat, `${outsiders.map((b) => b.name).join('、')} 加入了群聊`);
    }
    const members = allBots.filter((b) => chat.botIds.includes(b.id));
    targets = ALL_RE.test(text) ? members : parseMentions(text, members);
    if (!targets.length) {
      const lead = bots.get(chat.leadBotId) && chat.botIds.includes(chat.leadBotId!) ? bots.get(chat.leadBotId)! : members[0];
      if (lead) targets = [lead];
    }
  }
  emitChat(chat);
  for (const b of targets) enqueue({ chatId, botId: b.id, trigger: { type: 'user' }, hopsLeft: chat.maxHops });
  return msg;
}

/** Runs a routine: posts its prompt into the chat and queues the bot. */
export function runInChat(chatId: string, botId: string, prompt: string, trigger: MessageTrigger, routineName?: string): ChatMessage {
  const chat = chats.get(chatId);
  if (!chat) throw new Error('对话不存在');
  const expanded = skills.expand(prompt.trim());
  const msg: ChatMessage = {
    id: uid('m_'),
    chatId,
    seq: ++chat.seq,
    ts: Date.now(),
    role: 'user',
    text: prompt.trim(),
    trigger,
  };
  if (expanded.skill) {
    msg.prompt = expanded.text;
    msg.skill = expanded.skill.name;
  }
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  setLastMessage(chat, msg);
  emitChat(chat);
  enqueue({ chatId, botId, trigger, hopsLeft: chat.maxHops, routineName });
  return msg;
}

export async function stopChat(chatId: string) {
  const q = queues.get(chatId) || [];
  queues.delete(chatId);
  for (const j of q) settleStatus(j.botId);
  const r = running.get(chatId);
  if (!r) return;
  r.stream.stopped = true;
  for (const [id, a] of approvals) {
    if (a.chatId === chatId) {
      a.resolve({ allow: false, message: '用户停止了任务' });
      approvals.delete(id);
    }
  }
  await r.session.interrupt();
  // Kill the process if the turn does not wind down on its own.
  setTimeout(() => {
    const still = running.get(chatId);
    if (still && still.msg.id === r.msg.id) {
      still.session.close();
      sessions.delete(sessionKey(chatId, r.job.botId));
    }
  }, 8000);
}

export function resolveApproval(id: string, decision: { allow: boolean; always?: boolean; message?: string }) {
  const a = approvals.get(id);
  if (!a) return false;
  a.resolve(decision);
  return true;
}

/** Starts a new topic: the bots forget this chat's history. */
export function resetChat(chatId: string) {
  const chat = chats.get(chatId);
  if (!chat) return;
  for (const key of [...sessions.keys()]) {
    if (key.startsWith(`${chatId}:`)) {
      sessions.get(key)?.close();
      sessions.delete(key);
    }
  }
  chat.sessions = {};
  chat.context = {};
  const msg = systemMessage(chat, '—— 新话题 ——', { uiOnly: true });
  for (const b of chat.botIds) chat.cursors[b] = msg.seq;
  for (const b of chat.botIds) void resetActSession(`${chatId}:${b}`);
  emitChat(chat);
}

export function forgetChat(chatId: string) {
  queues.delete(chatId);
  for (const key of [...sessions.keys()]) {
    if (key.startsWith(`${chatId}:`)) {
      sessions.get(key)?.close();
      sessions.delete(key);
    }
  }
}

export function closeAllSessions() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}
