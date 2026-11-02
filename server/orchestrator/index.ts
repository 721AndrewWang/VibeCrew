import os from 'node:os';
import type { CanUseTool, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment, Bot, Chat, ChatMessage, MessageTrigger, Project, Trigger } from '../../shared/types';
import { crewServer } from '../agents/crewTools';
import { permissionModeFor } from '../agents/permissions';
import { buildSystemAppend, buildTurnPrompt, contextDelta, type NewInput, newInputNote, renderUserMessage } from '../agents/prompts';
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
import { type Delivery, forgetChatJobs, jobsRunningIn, onJobDone, runningJobs, stopChatJobs } from '../jobs';
import { jobLine } from '../jobs/spill';
import { type JobHandler, type JobHost, jobTools } from '../jobs/tools';
import { closeLayerSessions, forgetLayers, layersBusy, refreshWorkerSessions, resetLayers, routerEvent, routerMode, sharedWorkerActive, stopLayers, workerWorkingIn } from '../layers';
import { subscriptionsOn } from '../layers/subscriptions';
import { logger } from '../log';
import { chatProjectId, configOf, decorate, gitIn, HttpError, touchProject } from '../projects';
import { quietly } from '../quietWrites';
import { type Budget, measureInjected, RECALL_RESUME_NOTE, recallBudget } from '../recall';
import { parseVerdict, reviewDiff } from '../review';
import { shadowRoute } from '../router';
import { sandboxOptions } from '../sandbox';
import { skills } from '../skills';
import { continueNote, leadContinues, stalledLead, stallNote } from '../stall';
import { bots, chats, jobs, messages, projects, routines, settings, uid } from '../store';
import { chatThread, closeThread, publishTrigger, routineThread } from '../triggers';
import { monthSpend, shareOfTurn, usageOf } from '../usage';
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
  /** The turn's tool gate: `start` asks it about the command, as Claude Code asks it about Bash. */
  gate: CanUseTool;
  /** Full duplex: input for this bot that arrived during the turn, not yet handed to the model. */
  inbox: NewInput[];
  /** Sequence numbers of chat messages the model was handed mid-turn. */
  injected: Set<number>;
}

const queues = new Map<string, Job[]>();
const running = new Map<string, Running>();
const sessions = new Map<string, AgentSession>();
/** Sessions to recreate once their current turn ends (bot settings changed). */
const staleSessions = new Set<string>();
/** The context lines a session was last sent; later turns send only what changed. */
const contextSent = new WeakMap<AgentSession, string[]>();
/** Sessions started with the chain of recall on (their tools are fixed): the budgets their prompts use. */
const recallSessions = new WeakMap<AgentSession, Budget>();
/** Recall sessions resumed from a transcript, whose first turn says recall replaced chat_history. */
const recallResumed = new WeakSet<AgentSession>();
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

  // The chain of recall (ADR 005): a session's tools are fixed when it starts, so it keeps the budget it started with.
  const recall = recallBudget();
  const cfg = sessionConfig(chat, bot, project, { recall });
  const onSessionId = (sid: string) => {
    const c = chats.get(chat.id);
    if (!c || c.sessions[bot.id] === sid) return;
    c.sessions[bot.id] = sid;
    chats.save();
  };
  const members = bots
    .all()
    .filter((b) => chat.botIds.includes(b.id))
    .map((b) => b.name);
  const session = FAKE ? new FakeSession(cfg, bot.name, members, onSessionId) : new BotSession(cfg, onSessionId);
  sessions.set(key, session);
  if (recall) recallSessions.set(session, recall);
  if (recall && cfg.resume) recallResumed.add(session);
  return session;
}

/**
 * The Claude Code session a bot gets in a chat: its own turns (resumed), or a background sub-task
 * of it (a new conversation, without the full-duplex tools). Both go through the model gateway as
 * the bot (ADR 009), and both get recall instead of chat_history while the chain of recall is on.
 */
function sessionConfig(chat: Chat, bot: Bot, project: Project | null, opts: { subtask?: { actKey: string }; recall?: Budget } = {}): SessionConfig {
  const team = bots.all();
  const conf = project ? configOf(project) : null;
  const eff = effectiveBot(chat, bot);
  const recall = !!opts.recall;
  const duplex = !!bot.fullDuplex && !opts.subtask;
  const host = duplex ? jobHost(chat.id, bot.id) : undefined;
  const handlers = host ? jobTools(host) : undefined;
  return {
    cwd: project?.path || os.homedir(),
    model: botModel(eff.model, { role: 'bot', botId: bot.id }),
    effort: eff.effort || undefined,
    systemAppend: buildSystemAppend({ bot: eff, chat, project, team, skills: skills.list(), subtask: !!opts.subtask, recall }),
    resume: bot.freshSession || opts.subtask ? undefined : chat.sessions[bot.id],
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
        recall,
        actKey: opts.subtask?.actKey,
        jobs: host,
      }) as McpServerConfig,
      ...pluginServers(bot),
    },
    settingSources: bot.loadUserSettings ? ['user', 'project', 'local'] : ['project', 'local'],
    env: agentEnv({ role: 'bot', botId: bot.id }, eff.model || settings.get().defaultModel || undefined),
    midTurnNote: duplex ? () => drainInbox(chat.id, bot.id) : undefined,
    fakeTools: handlers ? (handlers as Record<string, JobHandler>) : undefined,
  };
}

// ---------------------------------------------------------------- full duplex (ADR 004)

/** The running turn of this bot in this chat, if it is one. */
function turnOf(chatId: string, botId: string): Running | undefined {
  const r = running.get(chatId);
  return r && r.job.botId === botId ? r : undefined;
}

/** What arrived for the bot during its turn, handed to the model once, after its current step. */
function drainInbox(chatId: string, botId: string): string | null {
  const r = turnOf(chatId, botId);
  if (!r?.inbox.length) return null;
  const items = r.inbox.splice(0);
  for (const i of items) r.injected.add(i.seq);
  return newInputNote(items);
}

/** Input for a full-duplex bot whose turn is running: it reads it after its current step. */
function offerMidTurn(chatId: string, botId: string, item: NewInput) {
  const r = turnOf(chatId, botId);
  // Only what came after the turn began: the message that started it is already in its prompt.
  if (r && item.seq > r.msg.seq && bots.get(botId)?.fullDuplex) r.inbox.push(item);
}

/**
 * The turn is over: if the model was handed every message that came in during it, the bot has
 * seen them, and the turn queued for them is not needed. Otherwise it runs as usual.
 */
function settleMidTurn(chatId: string, botId: string, r: Running) {
  if (!r.injected.size) return;
  const chat = chats.get(chatId);
  if (!chat) return;
  const after = messages.sorted(chatId).filter((m) => m.seq > r.msg.seq && !m.uiOnly && !(m.role === 'bot' && m.botId === botId));
  if (!after.length || !after.every((m) => r.injected.has(m.seq))) return;
  chat.cursors[botId] = Math.max(chat.cursors[botId] ?? 0, ...after.map((m) => m.seq));
  chats.save();
  const q = queues.get(chatId);
  if (q)
    queues.set(
      chatId,
      q.filter((j) => !(j.botId === botId && (j.trigger.type === 'user' || j.trigger.type === 'job'))),
    );
}

/** What the start/stop/status tools of a bot in a chat need, read fresh at each call. */
function jobHost(chatId: string, botId: string): JobHost {
  const here = () => {
    const chat = chats.get(chatId);
    const bot = bots.get(botId);
    if (!chat || !bot) throw new Error('The chat or the bot no longer exists');
    const project = projects.get(chatProjectId(chat)) ?? null;
    return { chat, bot, project, cwd: project?.path || os.homedir() };
  };
  return {
    chatId,
    botId,
    level: () => {
      const { chat, bot } = here();
      return effectiveBot(chat, bot).permission;
    },
    where: () => {
      const { project, cwd } = here();
      return { projectId: project?.id ?? null, cwd };
    },
    turnMessageId: () => turnOf(chatId, botId)?.msg.id,
    gateCommand: async (command, title) => {
      const r = turnOf(chatId, botId);
      if (!r) return 'start can only be used during your own turn.';
      // The same question Claude Code would ask about Bash: deny list, rules, level, approval card.
      const d = await r.gate('Bash', { command, description: title }, { signal: new AbortController().signal, toolUseID: uid('start_') } as Parameters<CanUseTool>[2]);
      if (d?.behavior === 'allow') return null;
      return (d && 'message' in d && d.message) || 'Not allowed.';
    },
    commandSpec: (command) => {
      const { project, cwd } = here();
      const conf = project ? configOf(project) : null;
      const s = settings.get();
      // The demo agent has no Claude Code to run a sandboxed Bash call in.
      const sandbox = FAKE ? undefined : sandboxOptions(s.sandbox.enabled, s.sandbox.allowedDomains, conf?.allowedDomains);
      return {
        command,
        sandbox,
        denyRules: s.denyRules || [],
        deniedReason: (toolName, input) => deniedReason(toolName, input, cwd),
        env: { CREW_JOB: '1' },
        // The helper session is the bot's own spend: through the gateway it counts toward the bot's windows.
        agentEnv: agentEnv({ role: 'bot', botId }),
      };
    },
    taskSpec: (task) => {
      const { chat, bot, project, cwd } = here();
      const cfg = sessionConfig(chat, bot, project, { subtask: { actKey: `${chatId}:${botId}:${uid('st_')}` }, recall: recallBudget() });
      return {
        task,
        content: [`<context>\n${contextLines(project).join('\n')}\n</context>`, `Your task, from your main session:\n\n${task}`].join('\n\n'),
        session: () => (FAKE ? new FakeSession(cfg, bot.name, [], () => {}) : new BotSession(cfg, () => {})),
        hooks: (stream, status) => ({
          beforeEdit: () => {},
          canUseTool: permissionGate({
            chat,
            bot,
            project,
            cwd,
            stream,
            who: `${bot.name} (background sub-task)`,
            status: (st) => status(st.state === 'waiting' ? st.detail || 'an action' : null),
          }),
        }),
      };
    },
  };
}

/** A job ended: its result goes into the chat as an event, and the bot that started it gets a turn. */
function deliverJob({ job, text, turn }: Delivery) {
  const chat = chats.get(job.chatId);
  if (!chat) return;
  const bot = bots.get(job.botId);
  const msg = systemMessage(chat, text, { notice: 'job', jobId: job.id });
  const t = publishTrigger({
    source: 'job',
    summary: `${bot?.name || 'A bot'}'s job: ${jobLine(job)}`,
    thread: chatThread(chat),
    ref: { kind: 'message', chatId: chat.id, messageId: msg.id },
    chatId: chat.id,
    projectId: job.projectId,
    explicit: true,
    related: [job.id, ...(job.startedBy ? [job.startedBy] : [])],
    action: turn && bot ? `Delivered to ${bot.name}` : 'Posted in the chat',
  });
  const cur = jobs.get(job.id);
  if (cur) {
    cur.resultMessageId = msg.id;
    cur.triggerId = t?.id;
    jobs.set(cur);
    bus.emit({ t: 'job', job: cur });
  }
  if (!turn || !bot || !chat.botIds.includes(bot.id) || routerMode(chat)) return;
  offerMidTurn(chat.id, bot.id, { seq: msg.seq, who: 'System', text });
  enqueue({ chatId: chat.id, botId: bot.id, trigger: { type: 'job', jobId: job.id }, hopsLeft: chat.maxHops });
}
onJobDone(deliverJob);

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
  systemMessage(chat, `${bot.name}'s session context reached ${Math.round(tokens / 1000)}k tokens, so this turn starts a fresh session with the last ${recent.length} messages.`, { uiOnly: true });
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
  refreshWorkerSessions((w) => w.botId === botId);
}

export function invalidateChat(chatId: string) {
  for (const key of [...sessions.keys()]) if (key.startsWith(`${chatId}:`)) closeSession(key);
  refreshWorkerSessions((w) => w.chatId === chatId);
}

export function invalidateAllSessions() {
  for (const key of [...sessions.keys()]) closeSession(key);
  refreshWorkerSessions(() => true);
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
  return running.has(chatId) || !!queues.get(chatId)?.length || locked.has(chatId) || preparing.has(chatId) || layersBusy(chatId);
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
  if (preparing.has(chatId)) throw new HttpError(409, `The workspace is still being prepared; wait until it's ready before ${what}`);
  if (running.has(chatId) || queues.get(chatId)?.length) throw new HttpError(409, `A bot is working; wait for this turn to end before ${what}`);
  if (locked.has(chatId)) throw new HttpError(409, "The previous operation hasn't finished yet, please wait");
  const shared = sharedWorkerActive(chatId);
  if (shared) throw new HttpError(409, `A Worker ("${shared.title}") is working in this chat's folder; wait for it to finish before ${what}`);
  const job = runningJobs(chatId)[0];
  if (job) throw new HttpError(409, `A background job ("${job.title}") is running in this chat's folder; stop it or wait for it before ${what}`);
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

/**
 * Like withChatLocked, but waits its turn instead of refusing: for Crew's own git work in a chat
 * that is in two-layer mode (a Worker's workspace being made, a Worker's branch being merged).
 */
export async function whenChatFree<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  while (locked.has(chatId) || preparing.has(chatId) || running.has(chatId) || queues.get(chatId)?.length) await new Promise((r) => setTimeout(r, 300));
  locked.add(chatId);
  const chat = chats.get(chatId);
  try {
    return await quietly([chatProjectId(chat), chat?.projectId], fn);
  } finally {
    locked.delete(chatId);
    // Crew's own changes (a Worker's branch merged in): file events still arriving are not outside edits.
    const pid = chatProjectId(chats.get(chatId) || chat);
    if (pid) lastTurnEnd.set(pid, Date.now());
    void pump(chatId);
  }
}

/** A bot turn (or a two-layer Worker) is running in the project (or workspace) right now. */
export function projectRunning(projectId: string): boolean {
  for (const r of running.values()) if (chatProjectId(chats.get(r.job.chatId)) === projectId) return true;
  return workerWorkingIn(projectId) || jobsRunningIn(projectId);
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
        systemMessage(
          chat,
          `${bot.name} has used up this month's budget ($${bot.monthlyBudgetUsd.toFixed(2)}; spent $${spent.toFixed(2)}), so it won't take tasks for now. You can raise the budget or remove the limit in its settings.`,
        );
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
    const recall = recallSessions.get(s);
    const opts = {
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
    };
    let promptText = buildTurnPrompt(opts);
    if (recall) {
      // The same turn without Inline & Spill, for the before/after the log and the turn keep.
      const without = promptText;
      promptText = buildTurnPrompt({ ...opts, context: contextDelta(contextSent.get(s), context, 'env'), recall });
      if (recallResumed.delete(s)) promptText = `${RECALL_RESUME_NOTE}\n\n${promptText}`;
      msg.meta = { ...msg.meta, injected: measureInjected(`${chat.title} / ${bot.name}`, promptText, without) };
    }
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
  const gate = permissionGate({ chat, bot, project, cwd, stream });
  const hooks = {
    onMessage: (m: Parameters<TurnStream['handle']>[0]) => stream.handle(m),
    beforeEdit: (fp: string | undefined) => recorder?.beforeEdit(fp),
    canUseTool: gate,
  };

  let session = getSession(chat, bot, project);
  const turn: Running = { job, msg, session, stream, gate, inbox: [], injected: new Set() };
  running.set(chat.id, turn);
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
      turn.session = session;
      result = await session.run(contentFor(session), hooks);
    }
    progress.cancel();
    stream.finish(result);
    // Where to find this turn in Claude Code's transcript (none for the demo agent).
    if (session.sessionId && !session.sessionId.startsWith('fake-')) msg.meta = { ...msg.meta, trace: { sessionId: session.sessionId, cwd, from: msg.ts, to: Date.now() } };
    if (session.sessionId) msg.meta = { ...msg.meta, sessionId: session.sessionId };
    shareOfTurn(msg);
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
  settleMidTurn(chat.id, bot.id, turn);
  const recorded = recorder?.finish();
  if (recorded) {
    msg.changes = { files: recorded.files.map((f) => f.path) };
    bus.emit({ t: 'turn', turn: summarize(recorded) });
  }
  msg.text = stream.finalText();
  // In a workspace every turn becomes a commit on the chat's branch.
  let unresolved: string[] | undefined;
  let commitError: string | undefined;
  if (project?.workspace) {
    try {
      unresolved = (await autoCommit(project.workspace.worktree, `${bot.name}: ${commitSubject(msg.text, 'Update files')}`)).unresolved;
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
  if (unresolved?.length)
    systemMessage(
      fresh,
      `The merge isn't finished: ${unresolved.join(', ')} still have unresolved conflicts (conflict markers, or files that need git add / git rm). Nothing will be committed until they're resolved.`,
    );
  if (commitError && project?.workspace) {
    systemMessage(
      fresh,
      `Couldn't commit this turn's changes to branch ${project.workspace.branch}: ${commitError}. The changes are still in the workspace files, but they can't be merged until this is fixed.`,
      { uiOnly: true },
    );
  }
  settleStatus(bot.id, msg.status === 'error' ? msg.error?.slice(0, 80) : undefined);
  if (msg.status === 'error') {
    notify(`${bot.name} hit an error`, msg.error?.slice(0, 140) || '', { chatId: chat.id, level: 'error' });
    const what = (msg.error || 'Unknown error').split('\n')[0].slice(0, 80);
    recordFriction({ kind: 'turn-error', key: `${bot.name}: ${what}`, detail: msg.error || '', chatId: chat.id, chatTitle: chat.title, botName: bot.name });
  } else if (msg.status === 'done') notify(`${bot.name} is done`, preview(msg.text).slice(0, 100) || 'Task complete', { chatId: chat.id, level: 'success' });

  // Bot-to-bot handoffs.
  let mentioned: Bot[] = [];
  if (msg.status === 'done' && fresh.kind === 'group') {
    const members = bots.all().filter((b) => fresh.botIds.includes(b.id) && b.id !== bot.id);
    mentioned = ALL_RE.test(msg.text) ? members : parseMentions(msg.text, members);
    if (mentioned.length) {
      if (job.hopsLeft > 0) {
        for (const m of mentioned) enqueue({ chatId: fresh.id, botId: m.id, trigger: { type: 'mention', by: bot.id }, hopsLeft: job.hopsLeft - 1 });
      } else {
        systemMessage(fresh, `The auto-relay hit its limit (${fresh.maxHops} hops). Reply with a message to let everyone continue.`, { uiOnly: true });
        recordFriction({ kind: 'hop-limit', key: `"${fresh.title}" limit ${fresh.maxHops} hops`, detail: `Stopped after ${bot.name}`, chatId: fresh.id, chatTitle: fresh.title, botName: bot.name });
      }
    }
  }
  publishTurnResult(fresh, bot, job, msg, project, msg.status === 'done' && job.hopsLeft > 0 ? mentioned : []);

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
      recordFriction({ kind: 'stall', key: `Nobody picked up after ${bot.name}`, detail: msg.text.replace(/\s+/g, ' ').slice(0, 120), chatId: fresh.id, chatTitle: fresh.title, botName: bot.name });
      // As a handoff from the teammate, so the lead reads its report in full.
      enqueue({ chatId: fresh.id, botId: lead.id, trigger: { type: 'mention', by: bot.id }, hopsLeft: fresh.maxHops });
    } else if (leadContinues({ chat: fresh, bot, msg, mentioned, history: messages.sorted(fresh.id) })) {
      // The lead said its next step is its own: give it that turn now.
      systemMessage(fresh, continueNote(bot.name), { notice: 'stall' });
      enqueue({ chatId: fresh.id, botId: bot.id, trigger: { type: 'system' }, hopsLeft: fresh.maxHops });
    }
  }
}

/** The turn's result, as a Trigger on the thread of whatever started it (the chat's topic, or its routine). */
function publishTurnResult(chat: Chat, bot: Bot, job: Job, msg: ChatMessage, project: Project | null, handedTo: Bot[]) {
  const routine = job.trigger.type === 'routine' ? routines.get(job.trigger.routineId) : undefined;
  const firstLine = (msg.error || 'Unknown error').split('\n')[0];
  publishTrigger({
    source: 'turn',
    summary: msg.status === 'error' ? `${bot.name}'s turn failed: ${firstLine}` : msg.status === 'stopped' ? `${bot.name}'s turn was stopped` : `${bot.name}: ${preview(msg.text) || '(no text)'}`,
    thread: routine ? routineThread(routine, chat) : chatThread(chat),
    ref: { kind: 'message', chatId: chat.id, messageId: msg.id },
    chatId: chat.id,
    projectId: project?.id ?? null,
    // A handoff is a bot's explicit request to a teammate; the chat has already queued it.
    explicit: handedTo.length > 0,
    subjects: msg.status === 'error' ? [firstLine] : [],
    facts: { status: msg.status },
    action: handedTo.length ? `Handed to ${handedTo.map((b) => b.name).join(', ')}` : undefined,
  });
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
    systemMessage(chat, `${skeptic.name} joined the chat`);
  }
  chat.cursors[skeptic.id] = Math.min(chat.cursors[skeptic.id] ?? from, from);
  systemMessage(chat, `This change matches the project's auto adversarial review rules, so ${skeptic.name}, please review it:\n${reasons.map((r) => `- ${r}`).join('\n')}`);
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
  if (!chat) throw new Error('Chat not found');
  const text = input.text.trim();
  if (!text && !input.attachments?.length) throw new Error("Message can't be empty");
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
  // Two-layer mode: the chat's Router decides who does what; no bot turn is queued here.
  if (routerMode(chat)) return routeToRouter(chat, msg);
  // Handled by the lead: a chat that had a Router does not hand it over again after a restart.
  if (chat.router) chat.router.cursor = msg.seq;
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
      systemMessage(chat, `${outsiders.map((b) => b.name).join(', ')} joined the group`);
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
  publishTrigger({
    source: 'user',
    summary: preview(msg.text) || '[attachment]',
    thread: chatThread(chat),
    ref: { kind: 'message', chatId, messageId: msg.id },
    chatId,
    projectId: chatProjectId(chat),
    explicit: true,
    action: targets.length ? `Sent to ${targets.map((b) => b.name).join(', ')}` : 'No bot in the chat to send it to',
  });
  for (const b of targets) enqueue({ chatId, botId: b.id, trigger: { type: 'user' }, hopsLeft: chat.maxHops });
  // Full duplex: a bot working right now reads this after its current step (text only).
  if (!msg.attachments?.some((a) => a.kind === 'image')) for (const b of targets) offerMidTurn(chatId, b.id, { seq: msg.seq, who: 'User', text: renderUserMessage(msg) });
  return msg;
}

/** A user message in a chat in two-layer mode: into the Router's inbox, with whom it addressed. */
function routeToRouter(chat: Chat, msg: ChatMessage): ChatMessage {
  const routing = msg.prompt ? `${msg.text}\n${msg.prompt}` : msg.text;
  // Mentioning someone outside the group invites them in, as in a normal group chat.
  const outsiders = parseMentions(
    routing,
    bots.all().filter((b) => !chat.botIds.includes(b.id)),
  );
  if (outsiders.length) {
    chat.botIds.push(...outsiders.map((b) => b.id));
    systemMessage(chat, `${outsiders.map((b) => b.name).join(', ')} joined the group`);
  }
  const members = bots.all().filter((b) => chat.botIds.includes(b.id));
  const to = ALL_RE.test(msg.text) ? [] : parseMentions(routing, members);
  takenByRouter(chat, msg.seq);
  emitChat(chat);
  const t = publishTrigger({
    source: 'user',
    summary: preview(msg.text) || '[attachment]',
    thread: chatThread(chat),
    ref: { kind: 'message', chatId: chat.id, messageId: msg.id },
    chatId: chat.id,
    projectId: chatProjectId(chat),
    explicit: true,
    action: 'Sent to the Router',
  });
  routerEvent(chat.id, {
    kind: 'user',
    id: msg.id,
    at: msg.ts,
    seq: msg.seq,
    text: msg.prompt || msg.text,
    to: to.map((b) => b.name).join(', ') || undefined,
    attachments: msg.attachments?.length,
    triggerId: t?.id,
  });
  return msg;
}

/**
 * A message the two layers take (the Router, or Workers subscribed to its thread) is not the bots'
 * to answer: once the chat is back with its lead, they must not get it again as a new request and
 * redo what the Workers did. It stays readable with chat_history.
 */
function takenByRouter(chat: Chat, seq: number) {
  for (const b of chat.botIds) chat.cursors[b] = Math.max(chat.cursors[b] ?? 0, seq);
}

/**
 * Runs a routine: posts its prompt into the chat and queues the bot. `publish` records the run on
 * the Trigger bus before it is routed: in two-layer mode, a run on a thread a Worker subscribes to
 * has gone straight to that Worker (ADR 003), and the Router only observes it.
 */
export function runInChat(chatId: string, botId: string, prompt: string, trigger: MessageTrigger, routineName?: string, publish?: (msg: ChatMessage) => Trigger | null): ChatMessage {
  const chat = chats.get(chatId);
  if (!chat) throw new Error('Chat not found');
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
  const t = publish?.(msg) ?? null;
  // Two-layer mode: the Router decides, told which member the routine names, unless subscribed Workers already have it.
  if (routerMode(chat)) {
    takenByRouter(chat, msg.seq);
    chats.save();
    if (!t?.filter.direct?.length) {
      const threadId = t && subscriptionsOn(settings.get().superAgent) ? t.threadId : undefined;
      routerEvent(chatId, {
        kind: 'routine',
        id: msg.id,
        at: msg.ts,
        seq: msg.seq,
        text: msg.prompt || msg.text,
        routine: routineName || 'routine',
        bot: bots.get(botId)?.name,
        triggerId: threadId && t?.id,
        threadId,
      });
    }
  } else {
    if (chat.router) chat.router.cursor = msg.seq;
    enqueue({ chatId, botId, trigger, hopsLeft: chat.maxHops, routineName });
  }
  return msg;
}

export async function stopChat(chatId: string) {
  await stopLayers(chatId);
  await stopChatJobs(chatId, 'The user stopped the chat');
  const q = queues.get(chatId) || [];
  queues.delete(chatId);
  for (const j of q) settleStatus(j.botId);
  const r = running.get(chatId);
  if (!r) return;
  r.stream.stopped = true;
  denyApprovals(chatId, 'The user stopped the task');
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
  resetLayers(chatId);
  void stopChatJobs(chatId, 'A new topic was started');
  closeThread(`chat:${chatId}`);
  const msg = systemMessage(chat, '—— New topic ——', { uiOnly: true });
  for (const b of chat.botIds) chat.cursors[b] = msg.seq;
  for (const b of chat.botIds) void resetActSession(`${chatId}:${b}`);
  emitChat(chat);
}

export function forgetChat(chatId: string) {
  queues.delete(chatId);
  forgetLayers(chatId);
  void forgetChatJobs(chatId).catch((e) => log.warn('forget jobs:', e));
  closeThread(`chat:${chatId}`);
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
  closeLayerSessions();
}
