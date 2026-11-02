// The Worker layer (ADR 002): each task the Router dispatches runs in a session of its own, with
// full tools, as one of the chat's members (its role, permission level, editable paths, rules and
// budget), on the strongest configured model, in a git worktree of its own branched from the
// chat's branch. Workers never post in the chat: when a turn ends, Crew commits the worktree,
// merges it into the chat's branch ("landing"), and hands the report to the Router.

import os from 'node:os';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Bot, Chat, ChatMessage, Project, Worker, WorkerStatus } from '../../shared/types';
import { crewServer } from '../agents/crewTools';
import { permissionModeFor } from '../agents/permissions';
import { buildSystemAppend, buildTurnPrompt, contextDelta, renderUserMessage } from '../agents/prompts';
import { type AgentSession, BotSession, FakeSession, type SessionConfig } from '../agents/session';
import type { TurnStream } from '../agents/stream';
import { bus } from '../bus';
import { botModel } from '../claudeAuth';
import { FAKE_AGENT } from '../config';
import { autoCommit, commitSubject, gitError, isMerging, zList } from '../gitops';
import { logger } from '../log';
import { whenChatFree } from '../orchestrator';
import { preview } from '../orchestrator/chatLog';
import { deniedReason, denyStreamApprovals, expireApprovals, permissionGate } from '../orchestrator/permissionGate';
import { agentEnv, contextLines, effectiveBot, imageBlocks, pluginServers, previewPageOf } from '../orchestrator/turnContext';
import { chatProjectId, configOf, gitIn } from '../projects';
import { reviewDiff } from '../review';
import { sandboxOptions } from '../sandbox';
import { skills } from '../skills';
import { bots, chats, messages, projects, settings, uid, workers } from '../store';
import { chatThread, publishTrigger } from '../triggers';
import { monthSpend } from '../usage';
import { ensureWatch } from '../watcher';
import { checkGit, createWorkerWorkspace, retireWorkerWorkspace, runSetup, type Workspace, workspaceOf } from '../workspaces';
import { doCreate } from '../workspaces/create';
import { type WorkerLine, workerPrompt } from './prompts';
import { leadOf, routerEvent } from './router';
import { runLogged } from './turn';

const log = logger('workers');

export const ACTIVE: ReadonlySet<WorkerStatus> = new Set(['starting', 'running', 'waiting']);
const REPORT_CHARS = 6000;
/** Finished Workers are dismissed (worktree removed) after this long without news. */
const IDLE_DISMISS_MS = 6 * 3600_000;
/** Dismissed Workers' records and transcripts are kept this long, for list_workers and the UI. */
const KEEP_DISMISSED_MS = 14 * 86_400_000;

/** What only this process knows about a Worker: its session, the turn under way, a stop request. */
interface Live {
  session: AgentSession | null;
  stream: TurnStream | null;
  running: boolean;
  stop: boolean;
  /** Stopped with the whole chat: the Router is not told. */
  quiet: boolean;
  first?: { userMessageIds: string[]; setupNote?: string };
  /** The environment lines the session was last sent. */
  context?: string[];
  /** Its settings changed while a turn ran: the session closes when the turn ends. */
  stale?: boolean;
}

/** Idle Worker sessions close after this long; the next turn resumes them from their transcript. */
const IDLE_CLOSE_MS = 15 * 60_000;
const live = new Map<string, Live>();
const liveOf = (id: string): Live => {
  const l = live.get(id) ?? { session: null, stream: null, running: false, stop: false, quiet: false };
  live.set(id, l);
  return l;
};

const isActive = (w: Worker) => ACTIVE.has(w.status) && !w.dismissedAt;

export function chatWorkers(chatId: string, opts: { all?: boolean } = {}): Worker[] {
  return workers
    .all()
    .filter((w) => w.chatId === chatId && (opts.all || !w.dismissedAt))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function activeWorkers(chatId: string): Worker[] {
  return chatWorkers(chatId).filter(isActive);
}

/** A Worker working in the chat's own folder right now: git operations on that folder must wait. */
export function sharedWorkerActive(chatId: string): Worker | undefined {
  return activeWorkers(chatId).find((w) => w.shared);
}

export function listWorkers(chatId?: string): Worker[] {
  return workers
    .all()
    .filter((w) => !w.dismissedAt && (!chatId || w.chatId === chatId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The Router's <workers> lines. */
export function workerLines(chatId: string): WorkerLine[] {
  return chatWorkers(chatId).map((w) => ({
    id: w.id,
    bot: bots.get(w.botId)?.name || 'deleted bot',
    status: w.status,
    title: w.title,
    note: isActive(w) ? w.detail : w.report ? `report: ${preview(w.report.text).slice(0, 100)}` : undefined,
  }));
}

function save(w: Worker, patch: Partial<Worker> = {}) {
  const isNew = !workers.has(w.id);
  const moved = patch.status !== undefined && patch.status !== w.status;
  Object.assign(w, patch, { updatedAt: Date.now() });
  workers.set(w);
  // A restart settles Workers by their saved status: a new one, or a new status, is written at once.
  if (isNew || moved) workers.flush();
  bus.emit({ t: 'worker', worker: w });
}

/** The Workers' model: the chat's own switch, else the setting, else the default model. */
function workerModel(chat: Chat): string {
  return chat.model !== undefined ? chat.model : settings.get().superAgent.router.workerModel;
}

// ---------------------------------------------------------------- dispatch

export interface DispatchInput {
  title: string;
  task: string;
  /** The batch's trigger and message ids. */
  related: string[];
  /** The user's messages in the batch: the Worker gets them verbatim, with their attachments. */
  userMessageIds: string[];
}

/** Starts a Worker in the background and returns it at once (the gates are the caller's). */
export function startWorker(chat: Chat, bot: Bot, input: DispatchInput): Worker {
  const now = Date.now();
  const w: Worker = {
    id: uid('wk_'),
    chatId: chat.id,
    botId: bot.id,
    title: input.title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Task',
    task: input.task.trim().slice(0, 20_000),
    status: 'starting',
    detail: 'Getting its workspace ready',
    createdAt: now,
    updatedAt: now,
    projectId: null,
    turns: 0,
    costUsd: 0,
    related: input.related.slice(0, 20),
  };
  save(w);
  liveOf(w.id).first = { userMessageIds: input.userMessageIds };
  void launch(w).catch((e) => {
    log.warn(`worker ${w.id} could not start:`, e);
    liveOf(w.id).first = undefined;
    finish(w, 'error', `Couldn't start: ${(e as Error).message}`);
  });
  return w;
}

/** Why a chat's Workers cannot have workspaces of their own, or null when they can. */
async function noWorkspaceReason(chat: Chat): Promise<string | null> {
  const parent = projects.get(chat.projectId);
  if (!parent) return 'the chat has no project';
  if (workspaceOf(chat)) return null;
  try {
    await checkGit(parent.path);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function launch(w: Worker) {
  const chat = chats.get(w.chatId);
  if (!chat) throw new Error('The chat no longer exists');
  const l = liveOf(w.id);
  const reason = await noWorkspaceReason(chat);
  if (reason) {
    // Checked and set with no await in between: two Workers dispatched together cannot both share the folder.
    const other = activeWorkers(chat.id).find((x) => x.id !== w.id && x.shared);
    if (other) {
      l.first = undefined;
      return finish(w, 'error', `${other.id} is already working in the chat's folder, and Workers can't have a workspace of their own here (${reason})`);
    }
    save(w, { projectId: chatProjectId(chat), shared: reason, detail: undefined });
  } else {
    // The chat's branch is where Workers' changes come together: the chat moves into a workspace first.
    if (!workspaceOf(chat)) save(w, { detail: "Moving the chat into a workspace of its own (Workers' changes are merged there)" });
    const chatWs = await whenChatFree(chat.id, async () => workspaceOf(chats.get(chat.id) || chat) ?? ((await doCreate(chat.id)) as Workspace));
    save(w, { detail: 'Creating its own workspace' });
    const { ws, base } = await whenChatFree(chat.id, () => createWorkerWorkspace(chatWs, w));
    // On disk before any work happens there: after a crash, startup finds the worktrees by these records.
    projects.flush();
    chats.flush();
    save(w, { projectId: ws.id, base, landedHead: base, detail: undefined });
    const setup = configOf(ws).setupCommand;
    if (setup && !l.stop) {
      save(w, { detail: `Preparing its workspace: ${setup}` });
      const r = await runSetup(ws.path, setup);
      if (!r.ok && l.first) l.first.setupNote = `The workspace setup command \`${setup}\` failed (${r.how}), so some dependencies may be missing:\n${r.out.slice(-1500)}`;
      save(w, { detail: undefined });
    }
  }
  if (l.stop) return finish(w, 'stopped', 'Stopped before it began');
  await runLoop(w);
}

// ---------------------------------------------------------------- turns

/** Runs turns while there is something to do: the task, then follow-ups that came in meanwhile. */
async function runLoop(w: Worker) {
  const l = liveOf(w.id);
  if (l.running) return;
  l.running = true;
  try {
    while (!l.stop && (l.first || w.pending?.length) && !w.dismissedAt) {
      const first = l.first;
      l.first = undefined;
      const followUps = w.pending || [];
      save(w, { pending: [] });
      await runTurn(w, first, followUps);
    }
  } finally {
    l.running = false;
  }
}

function getSession(w: Worker, chat: Chat, bot: Bot, project: Project | null): AgentSession {
  const l = liveOf(w.id);
  if (l.session && !l.session.closed) return l.session;
  const eff = effectiveBot(chat, bot);
  const conf = project ? configOf(project) : null;
  const cwd = project?.path || os.homedir();
  const lead = leadOf(chat);
  const cfg: SessionConfig = {
    cwd,
    model: botModel(workerModel(chat), { role: 'worker', botId: bot.id }),
    effort: eff.effort || undefined,
    systemAppend: buildSystemAppend({ bot: eff, chat, project, team: bots.all(), skills: skills.list(), worker: { lead: lead?.name || 'the lead', shared: w.shared } }),
    resume: w.sessionId,
    permissionMode: permissionModeFor(eff.permission),
    allowRules: [...bot.allowRules, 'mcp__crew'],
    askRules: [...bot.askRules, ...(conf?.askRules || [])],
    denyRules: settings.get().denyRules || [],
    deniedReason: (toolName, input) => deniedReason(toolName, input, cwd),
    wrapUpAt: () => settings.get().wrapUpAtTokens,
    attributionOff: !!conf?.noAttribution,
    sandbox: sandboxOptions(settings.get().sandbox.enabled, settings.get().sandbox.allowedDomains, conf?.allowedDomains),
    mcpServers: {
      crew: crewServer({
        botId: bot.id,
        botName: bot.name,
        chatId: chat.id,
        blind: !!bot.blindReview,
        projectId: () => w.projectId,
        currentPage: () => (w.projectId ? previewPageOf(w.projectId) : undefined),
        actKey: w.id,
        worker: true,
      }) as McpServerConfig,
      ...pluginServers(bot),
    },
    settingSources: bot.loadUserSettings ? ['user', 'project', 'local'] : ['project', 'local'],
    env: agentEnv({ role: 'worker', botId: bot.id }, workerModel(chat) || settings.get().defaultModel || undefined),
    role: 'worker',
  };
  const onSessionId = (sid: string) => {
    if (w.sessionId !== sid) save(w, { sessionId: sid });
  };
  l.session = FAKE_AGENT ? new FakeSession(cfg, bot.name, [], onSessionId) : new BotSession(cfg, onSessionId);
  l.context = undefined;
  if (w.model !== (cfg.model || 'default')) save(w, { model: cfg.model || 'default' });
  return l.session;
}

/** The turn's prompt: the task (and the user's own words) the first time, follow-ups after. */
async function promptFor(w: Worker, chat: Chat, bot: Bot, project: Project | null, first: Live['first'], followUps: string[]) {
  const l = liveOf(w.id);
  const lead = leadOf(chat);
  const context = contextLines(project);
  const delta = contextDelta(l.context, context);
  l.context = context;
  if (first?.setupNote) delta.push(first.setupNote);
  const users = (first?.userMessageIds || []).map((id) => messages.get(chat.id, id)).filter((m): m is ChatMessage => !!m);
  const conflict = w.landing?.conflicts?.length && project?.workspace ? { branch: project.workspace.baseBranch, files: w.landing.conflicts } : undefined;
  let text: string;
  if (bot.blindReview && first) {
    // A blind reviewer sees the user's words and the chat branch's change, and the task as a handover.
    const chatWs = workspaceOf(chat);
    const review = chatWs ? await reviewDiff(chatWs).catch(() => undefined) : project ? await reviewDiff(project).catch(() => undefined) : undefined;
    const handover: ChatMessage = { id: 'handover', chatId: chat.id, seq: 0, ts: Date.now(), role: 'bot', botId: lead?.id, text: `@${bot.name} ${w.task}` };
    text = buildTurnPrompt({
      bot,
      chat,
      unseen: [...users, handover],
      names: new Map(bots.all().map((b) => [b.id, b.name])),
      context: delta,
      trigger: { type: 'mention', by: lead?.id },
      review,
    });
  } else {
    text = workerPrompt({
      context: delta,
      lead: lead?.name || 'the Router',
      title: first ? w.title : undefined,
      task: first ? w.task : undefined,
      followUps,
      userWords: users.map((m) => ({ seq: m.seq, text: renderUserMessage(m) })),
      conflict,
    });
  }
  const imgs = first ? imageBlocks(users) : [];
  return imgs.length ? [{ type: 'text' as const, text }, ...imgs] : text;
}

async function runTurn(w: Worker, first: Live['first'], followUps: string[]) {
  const chat = chats.get(w.chatId);
  const bot = bots.get(w.botId);
  if (!chat || !bot) return finish(w, 'error', 'The chat or its member no longer exists');
  if (bot.monthlyBudgetUsd && monthSpend(bot.id) >= bot.monthlyBudgetUsd) return finish(w, 'error', `${bot.name} has used up this month's budget`);
  const project = projects.get(w.projectId) ?? null;
  // Never fall back to another folder (home) with full tools: no workspace, no turn.
  if (!project && !(w.shared && !w.projectId)) return finish(w, 'error', 'Its workspace is gone (or was never made); dispatch a new Worker');
  const cwd = project?.path || os.homedir();
  const l = liveOf(w.id);
  save(w, { status: 'running', detail: undefined });
  const status = (state: string, detail?: string) => {
    const next: WorkerStatus = state === 'waiting' ? 'waiting' : 'running';
    const d = state === 'waiting' || state === 'tool' ? detail : undefined;
    if (w.status !== next || w.detail !== d) save(w, { status: next, detail: d });
  };
  const { msg, session } = await runLogged({
    logId: w.id,
    botId: bot.id,
    cwd,
    trigger: { type: 'mention', by: leadOf(chat)?.id },
    session: () => getSession(w, chat, bot, project),
    forgetResume: () => {
      if (!w.sessionId) return false;
      l.session?.close();
      l.session = null;
      save(w, { sessionId: undefined });
      return true;
    },
    content: () => promptFor(w, chat, bot, project, first, followUps),
    hooks: (stream) => ({
      beforeEdit: () => {},
      canUseTool: permissionGate({ chat, bot, project, cwd, stream, status: (s) => status(s.state, s.detail), who: `${bot.name} (Worker "${w.title}")` }),
    }),
    onActivity: (state, detail) => status(state, detail),
    started: (stream, s) => {
      l.stream = stream;
      l.session = s;
      // Stopped while the session was being set up.
      if (l.stop) {
        stream.stopped = true;
        void s.interrupt();
      }
    },
  });
  if (l.stream) expireApprovals(l.stream);
  l.stream = null;
  if (!session) l.session = null;
  if (l.stale) {
    l.session?.close();
    l.session = null;
    l.stale = false;
  }
  if (session?.sessionId && session.sessionId !== w.sessionId) w.sessionId = session.sessionId;

  let landing: Worker['landing'];
  if (project?.workspace?.workerId) landing = await commitAndLand(w, bot, project as Workspace, msg);
  const outcome = l.stop || msg.status === 'stopped' ? 'stopped' : msg.status === 'done' ? 'done' : 'error';
  const text = (outcome === 'error' ? `Failed: ${msg.error || 'unknown error'}\n\n${msg.text}` : msg.text).trim().slice(0, REPORT_CHARS);
  save(w, { turns: w.turns + 1, costUsd: w.costUsd + (msg.meta?.costUsd || 0), landing: landing ?? w.landing });
  publishResult(w, chat, bot, msg, outcome);
  finish(w, outcome, outcome === 'error' ? (msg.error || '').split('\n')[0].slice(0, 160) : undefined, text);
}

/** Commits the turn's work to the Worker's branch and, when the turn finished, merges it into the chat's branch. */
async function commitAndLand(w: Worker, bot: Bot, ws: Workspace, msg: ChatMessage): Promise<Worker['landing']> {
  const at = Date.now();
  try {
    await autoCommit(ws.workspace.worktree, `${bot.name}: ${commitSubject(msg.text, w.title)}`);
  } catch (e) {
    return { at, files: [], error: `Couldn't commit its changes: ${gitError(e)}` };
  }
  if (msg.status !== 'done') return { at, files: [], error: `The turn did not finish, so nothing was merged; its work so far is on branch ${ws.workspace.branch}` };
  return land(w);
}

/**
 * Merges the Worker's branch into the chat's branch, inside the chat's worktree and under the
 * chat's lock. A conflict aborts the merge and leaves both branches as they were.
 */
export async function land(w: Worker): Promise<NonNullable<Worker['landing']>> {
  const at = Date.now();
  const info = projects.get(w.projectId)?.workspace;
  const chat = chats.get(w.chatId);
  const chatWs = chat ? workspaceOf(chat) : null;
  if (!info) return { at, files: [], error: 'Its workspace is gone' };
  if (!chatWs || chatWs.workspace.branch !== info.baseBranch)
    return { at, files: [], error: `The chat no longer works on ${info.baseBranch}, so nothing was merged; the work is on branch ${info.branch}` };
  const head = (await gitIn(info.worktree, ['rev-parse', 'HEAD'])).trim();
  const from = w.landedHead || w.base || head;
  if (head === from) return { at, files: [] };
  const files = zList(await gitIn(info.worktree, ['diff', '--name-only', '-z', from, head]).catch(() => ''));
  const bot = bots.get(w.botId);
  return whenChatFree(chatWs.workspace.chatId, async () => {
    const target = chatWs.workspace.worktree;
    if (await isMerging(target)) return { at, files: [], error: `${info.baseBranch} is in the middle of a sync with conflicts, so nothing was merged yet; the work is on branch ${info.branch}` };
    try {
      await autoCommit(target, 'Crew: save changes before merging a worker');
      await gitIn(target, ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-verify', '-q', '-m', `Merge worker "${w.title}"${bot ? ` (${bot.name})` : ''}`, info.branch]);
    } catch (e) {
      const conflicts = zList(await gitIn(target, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => ''));
      await gitIn(target, ['merge', '--abort']).catch(() => {});
      return conflicts.length ? { at, files, conflicts } : { at, files: [], error: `Couldn't merge: ${gitError(e)}` };
    }
    w.landedHead = head;
    // The preview and the file tree follow the chat's workspace.
    ensureWatch(chatWs.id);
    return { at, files, commit: (await gitIn(target, ['rev-parse', '--short', 'HEAD'])).trim() };
  });
}

/** What the Router reads about a landing. */
export function landingText(w: Worker): string | undefined {
  const l = w.landing;
  const branch = projects.get(w.projectId)?.workspace?.baseBranch || "the chat's branch";
  if (w.shared) return `It works in the chat's folder directly (${w.shared}).`;
  if (!l) return undefined;
  if (l.conflicts?.length) return `Its changes conflict with ${branch} in ${l.conflicts.join(', ')}; nothing was merged. message_worker can ask it to bring in ${branch} and resolve them.`;
  if (l.error) return `${l.error}.`;
  if (!l.files.length) return 'It changed no files this turn.';
  return `Crew merged its changes into ${branch}: ${l.files.slice(0, 8).join(', ')}${l.files.length > 8 ? ` and ${l.files.length - 8} more` : ''}.`;
}

/** The turn's result as a Trigger on the chat's thread, settled on the fast path: it went to the Router directly. */
function publishResult(w: Worker, chat: Chat, bot: Bot, msg: ChatMessage, outcome: string) {
  const firstLine = (msg.error || 'Unknown error').split('\n')[0];
  publishTrigger({
    source: 'turn',
    summary: outcome === 'error' ? `${bot.name}'s Worker "${w.title}" failed: ${firstLine}` : `${bot.name}'s Worker "${w.title}": ${preview(msg.text) || `(${outcome})`}`,
    thread: chatThread(chat),
    ref: { kind: 'message', chatId: w.id, messageId: msg.id },
    chatId: chat.id,
    projectId: w.projectId,
    facts: { status: msg.status, routed: true },
    related: w.related.filter((id) => id.startsWith('tg_')),
    action: `Reported to the Router of "${chat.title}"`,
  });
}

/** Records how the turn (or the start) ended and tells the Router, unless the whole chat was stopped. */
function finish(w: Worker, outcome: 'done' | 'error' | 'stopped', detail?: string, text?: string) {
  const l = liveOf(w.id);
  const report = { at: Date.now(), status: outcome, text: text ?? (detail ? `${outcome === 'error' ? 'Failed' : 'Stopped'}: ${detail}` : '') };
  save(w, { status: outcome, detail, report });
  if (l.quiet) return;
  const bot = bots.get(w.botId);
  routerEvent(w.chatId, { kind: 'worker', id: w.id, at: Date.now(), bot: bot?.name || 'deleted bot', title: w.title, status: outcome, report: report.text, landing: landingText(w) });
}

// ---------------------------------------------------------------- control

/** A follow-up from the Router: run now if the Worker is idle, else after its current turn. */
export function messageWorker(w: Worker, text: string): 'started' | 'queued' {
  const l = liveOf(w.id);
  l.stop = false;
  l.quiet = false;
  const busy = l.running || w.status === 'starting';
  save(w, { pending: [...(w.pending || []), text.trim().slice(0, 20_000)] });
  if (!busy) void runLoop(w);
  return busy ? 'queued' : 'started';
}

/** Stops a Worker's turn (or its start). `quiet`: the whole chat was stopped, so the Router is not told. */
export async function stopWorker(id: string, opts: { quiet?: boolean; why?: string } = {}): Promise<boolean> {
  const w = workers.get(id);
  if (!w || !isActive(w)) return false;
  const l = liveOf(id);
  l.stop = true;
  l.quiet = !!opts.quiet;
  if (w.pending?.length) save(w, { pending: [] });
  const stream = l.stream;
  if (stream) {
    stream.stopped = true;
    denyStreamApprovals(stream, opts.why || 'The task was stopped');
    const session = l.session;
    await session?.interrupt();
    // Kill the process if the turn does not wind down on its own.
    setTimeout(() => {
      if (l.stream === stream) {
        session?.close();
        l.session = null;
      }
    }, 8000).unref();
  } else if (w.status === 'starting') save(w, { detail: 'Stopping once its workspace is ready' });
  return true;
}

/** Stops every Worker of a chat, without telling its Router (the user stopped the chat). */
export async function stopChatWorkers(chatId: string) {
  await Promise.all(activeWorkers(chatId).map((w) => stopWorker(w.id, { quiet: true, why: 'The user stopped the chat' })));
}

/** Removes a finished Worker's workspace; a branch whose work never reached the chat's branch is kept. */
export async function dismissWorker(w: Worker) {
  if (isActive(w)) throw new Error('Stop the Worker first');
  const l = live.get(w.id);
  l?.session?.close();
  live.delete(w.id);
  save(w, { dismissedAt: Date.now(), pending: [] });
  const ws = projects.get(w.projectId);
  if (ws?.workspace?.workerId === w.id) await retireWorkerWorkspace(ws as Workspace).catch((e) => log.warn('retire worker workspace:', gitError(e)));
}

/** A new topic: finished Workers go; running ones carry on and report to the Router's new session. */
export async function dismissFinished(chatId: string) {
  for (const w of chatWorkers(chatId)) if (!isActive(w)) await dismissWorker(w);
}

/** The chat is deleted: its Workers stop and go, records and transcripts too. */
export async function forgetWorkers(chatId: string) {
  await stopChatWorkers(chatId);
  for (const w of chatWorkers(chatId, { all: true })) {
    live.get(w.id)?.session?.close();
    live.delete(w.id);
    workers.delete(w.id);
    messages.deleteChat(w.id);
    bus.emit({ t: 'worker_deleted', id: w.id });
  }
}

/**
 * Settings a Worker's session was made with changed (the chat's switches, the bot, the sandbox):
 * idle sessions close and resume with the new settings next turn; busy ones close when their turn
 * ends, and switch their permission mode at once.
 */
export function refreshWorkerSessions(match: (w: Worker) => boolean) {
  for (const [id, l] of live) {
    const w = workers.get(id);
    if (!w || !l.session || !match(w)) continue;
    if (!l.session.busy) {
      l.session.close();
      l.session = null;
      continue;
    }
    l.stale = true;
    const chat = chats.get(w.chatId);
    const bot = bots.get(w.botId);
    if (chat && bot) l.session.setPermissionMode?.(permissionModeFor(effectiveBot(chat, bot).permission));
  }
}

export function closeIdleWorkerSessions(now = Date.now()) {
  for (const l of live.values()) {
    if (l.session && !l.session.busy && now - l.session.lastUsed > IDLE_CLOSE_MS) {
      l.session.close();
      l.session = null;
    }
  }
}

/** A Worker is working in this folder right now (its own workspace, or a chat's folder it shares). */
export function workerWorkingIn(projectId: string): boolean {
  return workers.all().some((w) => isActive(w) && w.projectId === projectId);
}

export function closeWorkerSessions() {
  for (const l of live.values()) l.session?.close();
}

/**
 * On start: Workers a restart cut off are stopped, and their chats' Routers will be told (returned);
 * long-dismissed ones are forgotten. Returns the ids whose workspaces stay.
 */
export function recoverWorkers(now = Date.now()): { live: Set<string>; interrupted: Worker[] } {
  const interrupted: Worker[] = [];
  for (const w of workers.all()) {
    if (w.dismissedAt && now - w.dismissedAt > KEEP_DISMISSED_MS) {
      workers.delete(w.id);
      messages.deleteChat(w.id);
      continue;
    }
    if (!ACTIVE.has(w.status)) continue;
    w.status = 'stopped';
    w.detail = 'Crew restarted';
    w.report = { at: now, status: 'stopped', text: 'Interrupted by a restart of Crew; its work so far is kept on its branch.' };
    w.pending = [];
    w.updatedAt = now;
    workers.set(w);
    interrupted.push(w);
  }
  return {
    live: new Set(
      workers
        .all()
        .filter((w) => !w.dismissedAt)
        .map((w) => w.id),
    ),
    interrupted,
  };
}

/** Hourly: finished Workers nobody has touched for hours give their worktrees back. */
export function sweepWorkers(now = Date.now()) {
  for (const w of workers.all()) if (!w.dismissedAt && !isActive(w) && now - w.updatedAt > IDLE_DISMISS_MS) void dismissWorker(w).catch(() => {});
}
