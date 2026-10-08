import os from 'node:os';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment, Bot, Chat, ChatMessage, MessageTrigger, Project } from '../../shared/types';
import { crewServer } from '../agents/crewTools';
import { permissionModeFor } from '../agents/permissions';
import { buildSystemAppend, buildTurnPrompt, contextDelta } from '../agents/prompts';
import { summarize, TurnRecorder } from '../agents/recorder';
import { type AgentSession, BotSession, FakeSession, type SessionConfig } from '../agents/session';
import { TurnStream } from '../agents/stream';
import { autoChallengeReasons, findSkeptic, resetAutoChallenge } from '../autoChallenge';
import { resetActSession } from '../browser';
import { bus, internal, notify } from '../bus';
import { botModel } from '../claudeAuth';
import { FAKE_AGENT } from '../config';
import { recordFriction } from '../friction';
import { autoCommit, commitSubject, gitError } from '../gitops';
import { logger } from '../log';
import { chatProjectId, configOf, decorate, gitIn, HttpError, touchProject } from '../projects';
import { quietly } from '../quietWrites';
import { parseVerdict, reviewDiff } from '../review';
import { shadowRoute } from '../router';
import { sandboxOptions } from '../sandbox';
import { skills } from '../skills';
import { continueNote, leadContinues, stalledLead, stallNote } from '../stall';
import { bots, chats, messages, projects, settings, uid } from '../store';
import { monthSpend, usageOf } from '../usage';
import { ensureWatch } from '../watcher';
import { setStatus } from './botStatus';
import { ALL_RE, emitChat, parseMentions, preview, setLastMessage, systemMessage } from './chatLog';
import { deniedReason, denyApprovals, expireApprovals, permissionGate } from './permissionGate';
import { agentEnv, contextLines, effectiveBot, imageBlocks, pluginServers, previewPageOf } from './turnContext';

export { botStatuses } from './botStatus';
export { parseMentions, systemMessage } from './chatLog';
export { resolveApproval } from './permissionGate';
export { effectiveBot, setPreviewPage } from './turnContext';

const log = logger('orchestrator');

const PROGRESS_SAVE_MS = 3000;

/** chatId:botId → when the chat was last told the bot's budget is spent. */
const budgetNotices = new Map<string, number>();

/** Runs fn at most once per `ms`, on the trailing edge; cancel() drops a pending call. */
function throttle(ms: number, fn: () => void) {
  let timer: NodeJS.Timeout | null = null;
  let last = 0;
  return {
    call() {
      if (timer) return;
      timer = setTimeout(
        () => {
          timer = null;
          last = Date.now();
          fn();
        },
        Math.max(0, ms - (Date.now() - last)),
      );
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

const FAKE = FAKE_AGENT;
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

const queues = new Map<string, Job[]>();
const running = new Map<string, Running>();
const sessions = new Map<string, AgentSession>();
/** Sessions to recreate once their current turn ends (bot settings changed). */
const staleSessions = new Set<string>();
/** The context lines a session was last sent; later turns send only what changed. */
const contextSent = new WeakMap<AgentSession, string[]>();
/** Chats whose workspace is being changed by git (merge, sync…): new turns wait until it is done. */
const locked = new Set<string>();
/** Chats waiting for their workspace's setup command (see holdTurns). */
const preparing = new Set<string>();
/** projectId -> when a bot turn in it last ended. */
const lastTurnEnd = new Map<string, number>();

const sessionKey = (chatId: string, botId: string) => `${chatId}:${botId}`;

// ---------------------------------------------------------------- status

/** Idle unless the bot still has work queued or running somewhere. */
function settleStatus(botId: string, error?: string) {
  for (const [chatId, r] of running) if (r.job.botId === botId) return setStatus(botId, { state: 'thinking', chatId });
  for (const [chatId, q] of queues) if (q.some((j) => j.botId === botId)) return setStatus(botId, { state: 'queued', chatId });
  setStatus(botId, error ? { state: 'error', detail: error } : { state: 'idle' });
}

// ---------------------------------------------------------------- sessions

function getSession(chat: Chat, bot: Bot, project: Project | null): AgentSession {
  const key = sessionKey(chat.id, bot.id);
  const existing = sessions.get(key);
  // A fresh-session role gets a new conversation every turn: its earlier turns are not re-read.
  if (existing && !existing.closed && !staleSessions.has(key) && !bot.freshSession) return existing;
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
    resume: bot.freshSession ? undefined : chat.sessions[bot.id],
    permissionMode: permissionModeFor(eff.permission),
    allowRules: [...bot.allowRules, 'mcp__crew'],
    askRules: [...bot.askRules, ...(conf?.askRules || [])],
    denyRules: settings.get().denyRules || [],
    deniedReason: (toolName, input) => deniedReason(toolName, input, project?.path || os.homedir()),
    wrapUpAt: () => settings.get().wrapUpAtTokens,
    attributionOff: !!conf?.noAttribution,
    sandbox: sandboxOptions(settings.get().sandbox.enabled, settings.get().sandbox.allowedDomains, conf?.allowedDomains),
    mcpServers: {
      crew: crewServer({
        botId: bot.id,
        botName: bot.name,
        chatId: chat.id,
        blind: !!bot.blindReview,
        projectId: () => chatProjectId(chats.get(chat.id)),
        currentPage: () => {
          const pid = chatProjectId(chats.get(chat.id));
          return pid ? previewPageOf(pid) : undefined;
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
  if (!usage || !chat?.botIds.includes(botId)) return;
  chat.context = { ...chat.context, [botId]: { ...usage, at: Date.now() } };
  emitChat(chat);
  // Every call re-reads the whole session: past this size its next turn starts over with a recap.
  const limit = settings.get().rotateAtTokens;
  if (limit > 0 && usage.used >= limit && !bots.get(botId)?.freshSession) rotateNext.set(sessionKey(chatId, botId), usage.used);
}

/** Bots whose last turn here was complex: their next turn is reminded to keep what it learned. */
const nudgeNext = new Set<string>();
/** Tool calls that make a turn "complex" (Hermes uses five). */
export const COMPLEX_TURN_TOOLS = 5;

/** Sessions to start over on their next turn, with how many tokens they had grown to. */
const rotateNext = new Map<string, number>();
/**
 * The size saved with the chat, for a session that outgrew the limit before Crew restarted (the
 * in-memory mark is gone, the session is resumed from disk).
 */
function savedOversize(chat: Chat, bot: Bot): number | undefined {
  const limit = settings.get().rotateAtTokens;
  const used = chat.context?.[bot.id]?.used ?? 0;
  if (limit > 0 && chat.sessions[bot.id] && used >= limit && !bots.get(bot.id)?.freshSession) return used;
  return undefined;
}

/** Messages a started-over session gets again. */
const RECAP_MESSAGES = 12;

/**
 * Starts the bot's session in this chat over: the next turn is a new conversation that gets the
 * last few messages again (its own included). Returns the size the old session had reached.
 */
function rotateSession(chat: Chat, bot: Bot): number | null {
  const key = sessionKey(chat.id, bot.id);
  const tokens = rotateNext.get(key) ?? savedOversize(chat, bot);
  if (tokens === undefined) return null;
  rotateNext.delete(key);
  closeSession(key);
  delete chat.sessions[bot.id];
  // The size belonged to the old session; the new one reports its own after the turn.
  if (chat.context?.[bot.id]) delete chat.context[bot.id];
  const recent = messages
    .sorted(chat.id)
    .filter((m) => !m.uiOnly && m.status !== 'streaming')
    .slice(-RECAP_MESSAGES);
  if (recent.length) chat.cursors[bot.id] = recent[0].seq - 1;
  chats.save();
  systemMessage(chat, `${bot.name} 的会话上下文到了 ${Math.round(tokens / 1000)}k token，这一轮换成新会话，带上最近 ${recent.length} 条消息。`, { uiOnly: true });
  return tokens;
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
    log.error('turn crashed', e);
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
  // A setup command's writes are Crew's, not edits made outside the chat.
  const chat = chats.get(chatId);
  void quietly([chatProjectId(chat), chat?.projectId], () => work).then(done, done);
}

/**
 * Runs a git operation on a chat's workspace while no bot turn can start there (messages sent
 * meanwhile stay queued). Refuses when a turn is running or another operation is in progress.
 */
export async function withChatLocked<T>(chatId: string, what: string, fn: () => Promise<T>): Promise<T> {
  if (preparing.has(chatId)) throw new HttpError(409, `工作区还在准备，等准备好再${what}`);
  if (running.has(chatId) || queues.get(chatId)?.length) throw new HttpError(409, `机器人正在工作，等这一轮结束再${what}`);
  if (locked.has(chatId)) throw new HttpError(409, '上一个操作还没完成，请稍等');
  locked.add(chatId);
  try {
    // Git operations on the workspace (and a merge into its parent's checkout) are Crew's writes.
    const chat = chats.get(chatId);
    return await quietly([chatProjectId(chat), chat?.projectId], fn);
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

  // A role with a monthly budget stops taking turns once it is spent (said once an hour per chat).
  if (bot.monthlyBudgetUsd) {
    const spent = monthSpend(bot.id);
    if (spent >= bot.monthlyBudgetUsd) {
      const key = `${chat.id}:${bot.id}`;
      if (Date.now() - (budgetNotices.get(key) || 0) > 3600_000) {
        budgetNotices.set(key, Date.now());
        systemMessage(chat, `${bot.name} 这个月的预算（$${bot.monthlyBudgetUsd.toFixed(2)}）已经用完（已用 $${spent.toFixed(2)}），先不接任务。可以在它的设置里提高预算或去掉上限。`);
      }
      return;
    }
  }

  const rotatedFrom = rotateSession(chat, bot);
  const cursor = chat.cursors[bot.id] ?? 0;
  // After a rotation the bot's own recent replies come back too: the new session has none of them.
  const unseen = messages.sorted(chat.id).filter((m) => m.seq > cursor && !m.uiOnly && (rotatedFrom !== null || !(m.role === 'bot' && m.botId === bot.id)) && m.status !== 'streaming');

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
  const context = contextLines(project);
  const imgs = imageBlocks(unseen.filter((m) => m.role === 'user'));
  // A blind reviewer gets the change itself instead of what teammates said about it.
  const review = bot.blindReview && project ? await reviewDiff(project) : undefined;
  /** The prompt for this session: the full context the first time, then only what changed. */
  const contentFor = (s: AgentSession) => {
    const promptText = buildTurnPrompt({
      bot,
      chat,
      unseen,
      names,
      context: contextDelta(contextSent.get(s), context),
      trigger: job.trigger,
      routineName: job.routineName,
      review,
      recap: rotatedFrom !== null ? { tokens: rotatedFrom } : undefined,
      nudge: rotatedFrom === null && nudgeNext.delete(sessionKey(chat.id, bot.id)),
    });
    contextSent.set(s, context);
    return imgs.length ? [{ type: 'text' as const, text: promptText }, ...imgs] : promptText;
  };

  const recorder = project ? new TurnRecorder({ id: msg.turnId!, chatId: chat.id, botId: bot.id, messageId: msg.id, projectId: project.id }, project.path) : null;
  const onFiles = (pid: string, paths: string[]) => {
    if (project && pid === project.id) recorder?.watched(paths);
  };
  internal.on('files', onFiles);

  let lastActivity = '';
  // Progress goes to disk every few seconds, so a crash mid-turn keeps what the bot had written.
  const progress = throttle(PROGRESS_SAVE_MS, () => messages.put(msg));
  const stream = new TurnStream(
    msg,
    (state, detail) => {
      const key = state + (detail || '');
      if (key === lastActivity) return;
      lastActivity = key;
      setStatus(bot.id, { state, detail, chatId: chat.id });
    },
    progress.call,
  );

  const cwd = project?.path || os.homedir();
  const hooks = {
    onMessage: (m: Parameters<TurnStream['handle']>[0]) => stream.handle(m),
    beforeEdit: (fp: string | undefined) => recorder?.beforeEdit(fp),
    canUseTool: permissionGate({ chat, bot, project, cwd, stream }),
  };

  let session = getSession(chat, bot, project);
  running.set(chat.id, { job, msg, session, stream });
  try {
    let result: Awaited<ReturnType<typeof session.run>>;
    try {
      result = await session.run(contentFor(session), hooks);
    } catch (e) {
      // A stale resume id fails before anything streams: start a fresh session once.
      const resumeFailed = !!chat.sessions[bot.id] && !stream.parts.length && !stream.stopped && /conversation|session|resume/i.test(String((e as Error)?.message));
      if (!resumeFailed) throw e;
      delete chat.sessions[bot.id];
      chats.save();
      sessions.delete(sessionKey(chat.id, bot.id));
      session = getSession(chat, bot, project);
      running.set(chat.id, { job, msg, session, stream });
      result = await session.run(contentFor(session), hooks);
    }
    progress.cancel();
    stream.finish(result);
    // Where to find this turn in Claude Code's transcript (none for the demo agent).
    if (session.sessionId && !session.sessionId.startsWith('fake-')) msg.meta = { ...msg.meta, trace: { sessionId: session.sessionId, cwd, from: msg.ts, to: Date.now() } };
    void recordContext(chat.id, bot.id, session);
  } catch (e) {
    stream.fail(e);
    sessions.get(sessionKey(chat.id, bot.id))?.close();
    sessions.delete(sessionKey(chat.id, bot.id));
  } finally {
    internal.off('files', onFiles);
    expireApprovals(stream);
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
      log.warn('workspace auto-commit failed:', commitError);
    }
  }
  if (bot.blindReview && msg.status === 'done') await recordVerdict(msg, project);
  // A complex turn: the bot's next turn here (same session) is nudged to keep what it learned.
  const toolCalls = (msg.parts || []).filter((p) => p.type === 'tool').length;
  if (msg.status === 'done' && toolCalls >= COMPLEX_TURN_TOOLS && !bot.freshSession && !bot.blindReview) nudgeNext.add(sessionKey(chat.id, bot.id));
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  bus.emit({ t: 'usage', usage: usageOf() });

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
  if (msg.status === 'error') {
    notify(`${bot.name} 出错了`, msg.error?.slice(0, 140) || '', { chatId: chat.id, level: 'error' });
    const what = (msg.error || '未知错误').split('\n')[0].slice(0, 80);
    recordFriction({ kind: 'turn-error', key: `${bot.name}：${what}`, detail: msg.error || '', chatId: chat.id, chatTitle: chat.title, botName: bot.name });
  } else if (msg.status === 'done') notify(`${bot.name} 完成了`, preview(msg.text).slice(0, 100) || '任务完成', { chatId: chat.id, level: 'success' });

  // Bot-to-bot handoffs.
  let mentioned: Bot[] = [];
  if (msg.status === 'done' && fresh.kind === 'group') {
    const members = bots.all().filter((b) => fresh.botIds.includes(b.id) && b.id !== bot.id);
    mentioned = ALL_RE.test(msg.text) ? members : parseMentions(msg.text, members);
    if (mentioned.length) {
      if (job.hopsLeft > 0) {
        for (const m of mentioned) enqueue({ chatId: fresh.id, botId: m.id, trigger: { type: 'mention', by: bot.id }, hopsLeft: job.hopsLeft - 1 });
      } else {
        systemMessage(fresh, `自动接力已达到上限（${fresh.maxHops} 次）。回复一条消息即可让大家继续。`, { uiOnly: true });
        recordFriction({ kind: 'hop-limit', key: `「${fresh.title}」上限 ${fresh.maxHops} 次`, detail: `${bot.name} 之后停住`, chatId: fresh.id, chatTitle: fresh.title, botName: bot.name });
      }
    }
  }

  // The chain of turns is over: a change that matches the project's rules gets an adversarial review.
  if (msg.status === 'done' && project && !bot.blindReview && !queues.get(fresh.id)?.length) await maybeAutoChallenge(fresh, project);

  // Still nothing queued: a teammate reported back without handing on. Wake the lead.
  if (!queues.get(fresh.id)?.length) {
    const lead = stalledLead({
      chat: fresh,
      bot,
      msg,
      mentioned,
      history: messages.sorted(fresh.id),
      trigger: job.trigger,
      members: bots.all().filter((b) => fresh.botIds.includes(b.id)),
    });
    if (lead) {
      systemMessage(fresh, stallNote(bot.name, lead.name), { notice: 'stall' });
      recordFriction({ kind: 'stall', key: `${bot.name} 交回后没人接手`, detail: msg.text.replace(/\s+/g, ' ').slice(0, 120), chatId: fresh.id, chatTitle: fresh.title, botName: bot.name });
      // As a handoff from the teammate, so the lead reads its report in full.
      enqueue({ chatId: fresh.id, botId: lead.id, trigger: { type: 'mention', by: bot.id }, hopsLeft: fresh.maxHops });
    } else if (leadContinues({ chat: fresh, bot, msg, mentioned, history: messages.sorted(fresh.id) })) {
      // The lead said its next step is its own: give it that turn now.
      systemMessage(fresh, continueNote(bot.name), { notice: 'stall' });
      enqueue({ chatId: fresh.id, botId: bot.id, trigger: { type: 'system' }, hopsLeft: fresh.maxHops });
    }
  }
}

async function maybeAutoChallenge(chat: Chat, project: Project) {
  const skeptic = findSkeptic(bots.all());
  if (!skeptic) return;
  const reasons = await autoChallengeReasons(chat, project, configOf(project).autoChallenge).catch((e) => {
    log.warn('auto challenge:', e);
    return null;
  });
  if (!reasons) return;
  // It reviews against what the user asked for: start it from the user's latest request at least.
  const asked = messages
    .sorted(chat.id)
    .filter((m) => m.role === 'user')
    .at(-1);
  const from = asked ? asked.seq - 1 : chat.seq;
  if (!chat.botIds.includes(skeptic.id)) {
    chat.botIds.push(skeptic.id);
    invalidateChat(chat.id);
    systemMessage(chat, `${skeptic.name} 加入了对话`);
  }
  chat.cursors[skeptic.id] = Math.min(chat.cursors[skeptic.id] ?? from, from);
  systemMessage(chat, `这次的改动符合项目的自动对抗审查规则，请 ${skeptic.name} 审一次：\n${reasons.map((r) => `- ${r}`).join('\n')}`);
  enqueue({ chatId: chat.id, botId: skeptic.id, trigger: { type: 'system' }, hopsLeft: chat.maxHops });
}

/**
 * Keeps an adversarial reviewer's verdict: on the message, and on the workspace against the commit
 * it saw, which is what a "challenge before merge" project checks.
 */
async function recordVerdict(msg: ChatMessage, project: Project | null) {
  const v = parseVerdict(msg.text);
  if (!v) return;
  msg.meta = { ...msg.meta, verdict: v };
  const ws = project?.workspace;
  if (!project || !ws) return;
  const head = (await gitIn(ws.worktree, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (!head) return;
  const p = projects.get(project.id);
  if (!p?.workspace) return;
  p.workspace.challenge = { head, refuted: v.refuted, at: Date.now(), messageId: msg.id };
  projects.set(p);
  bus.emit({ t: 'project', project: decorate(p) });
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
  resetAutoChallenge(chat.id);

  let targets: Bot[] = [];
  const allBots = bots.all();
  if (chat.kind === 'dm') {
    const b = bots.get(chat.botIds[0]);
    if (b) targets = [b];
  } else {
    // A skill may name who should do it (/challenge → @Skeptic): its expansion routes too.
    const routing = msg.prompt ? `${text}\n${msg.prompt}` : text;
    // Mentioning someone outside the group invites them in.
    const outsiders = parseMentions(
      routing,
      allBots.filter((b) => !chat.botIds.includes(b.id)),
    );
    if (outsiders.length) {
      chat.botIds.push(...outsiders.map((b) => b.id));
      for (const b of outsiders) chat.cursors[b.id] = msg.seq - 1;
      invalidateChat(chat.id);
      emitChat(chat);
      systemMessage(chat, `${outsiders.map((b) => b.name).join('、')} 加入了群聊`);
    }
    const members = allBots.filter((b) => chat.botIds.includes(b.id));
    targets = ALL_RE.test(text) ? members : parseMentions(routing, members);
    if (!targets.length) {
      const lead = bots.get(chat.leadBotId) && chat.botIds.includes(chat.leadBotId!) ? bots.get(chat.leadBotId)! : members[0];
      if (lead) targets = [lead];
      // What a cheap router would have picked, recorded on the side; the message still goes to the lead.
      if (lead) void shadowRoute(chat, msg, members, lead).catch((e) => log.warn('shadow routing:', e));
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
  denyApprovals(chatId, '用户停止了任务');
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
