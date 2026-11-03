// The Worker layer (ADR 002): each task the Router dispatches runs in a session of its own, with
// full tools, as one of the chat's members (its role, permission level, editable paths, rules and
// budget), on the strongest configured model, in a git worktree of its own branched from the
// chat's branch. Workers never post in the chat: when a turn ends, Crew commits the worktree,
// merges it into the chat's branch ("landing"), and hands the report to the Router.

import os from 'node:os';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { familyInfo } from '../../shared/families';
import { WORKER_ACTIVE } from '../../shared/status';
import type { Bot, Chat, ChatMessage, Project, SkillFamily, Worker, WorkerDelivery, WorkerOutcome, WorkerStatus } from '../../shared/types';
import type { SpeculativeClaimArgs } from '../agents/crewTools';
import { type CrewContext, crewServer, draftAction } from '../agents/crewTools';
import { permissionModeFor } from '../agents/permissions';
import { buildSystemAppend, buildTurnPrompt, contextDelta, renderUserMessage } from '../agents/prompts';
import { type AgentSession, BotSession, FakeSession, type SessionConfig } from '../agents/session';
import type { TurnStream } from '../agents/stream';
import { bus } from '../bus';
import { botModel } from '../claudeAuth';
import { FAKE_AGENT } from '../config';
import type { DraftFields } from '../drafts';
import { autoCommit, commitSubject, gitError, isMerging, zList } from '../gitops';
import { logger } from '../log';
import { IDLE_CLOSE_MS, whenChatFree } from '../orchestrator';
import { preview } from '../orchestrator/chatLog';
import { deniedReason, denyStreamApprovals, expireApprovals, permissionGate } from '../orchestrator/permissionGate';
import { agentEnv, contextLines, effectiveBot, imageBlocks, pluginServers, previewPageOf } from '../orchestrator/turnContext';
import { chatProjectId, configOf, gitIn } from '../projects';
import { type Budget, measureInjected, RECALL_RESUME_NOTE, recallBudget } from '../recall';
import { reviewDiff } from '../review';
import { agentEnvOptions } from '../safety';
import { sandboxOptions } from '../sandbox';
import { skills } from '../skills';
import { bots, chats, messages, projects, settings, uid, workers } from '../store';
import { chatThread, deliveriesRead, deliveriesUnread, ensureThread, handBackTrigger, publishTrigger, type ThreadSpec, threadsOf, workspaceThread } from '../triggers';
import { overMonthlyBudget } from '../usage';
import { ensureWatch } from '../watcher';
import { checkGit, createSpeculativeWorkspace, createWorkerWorkspace, retireWorkerWorkspace, runSetup, type Workspace, workspaceOf } from '../workspaces';
import { doCreate } from '../workspaces/create';
import { deliveredNote, type WorkerLine, workerPrompt } from './prompts';
import { leadOf, routerEvent } from './router';
import { pushInbox, subscriptionsOn } from './subscriptions';
import { runLogged } from './turn';

const log = logger('workers');

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
  /** Who stopped it and why (the Watchdog, the user): a speculative run's discard says so (ADR 011). */
  why?: string;
  first?: { userMessageIds: string[]; setupNote?: string };
  /** The environment lines the session was last sent. */
  context?: string[];
  /** Its settings changed while a turn ran: the session closes when the turn ends. */
  stale?: boolean;
  /** The session was started with the chain of recall on: the budgets its prompts use. */
  recall?: Budget;
  /** It resumed a transcript with recall on: its next prompt says recall replaced chat_history. */
  recallNote?: boolean;
}

const live = new Map<string, Live>();
const liveOf = (id: string): Live => {
  const l = live.get(id) ?? { session: null, stream: null, running: false, stop: false, quiet: false };
  live.set(id, l);
  return l;
};

const isActive = (w: Worker) => WORKER_ACTIVE.has(w.status) && !w.dismissedAt;

/** A chat's Workers; speculative runs (ADR 008) are quiet, so they count only when asked for. */
export function chatWorkers(chatId: string, opts: { all?: boolean; speculative?: boolean } = {}): Worker[] {
  return workers
    .all()
    .filter((w) => w.chatId === chatId && (opts.all || !w.dismissedAt) && (opts.speculative || !w.speculation))
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
    .filter((w) => !w.dismissedAt && !w.speculation && (!chatId || w.chatId === chatId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------- speculative runs (ADR 008)

/**
 * What the speculative module provides for its runs: a run is a Worker with `speculation` set, and
 * this is where it differs. Registered by server/speculative (the Worker layer does not import it).
 */
export interface SpeculativeHost {
  /** Where the problem was observed: the chat's workspace or the project folder. */
  source(w: Worker): Project | undefined;
  /** The commit to start from instead of the folder's current state: a GitHub check's head (ADR 011). */
  baseCommit?(w: Worker): string | undefined;
  /** Makes that commit local when it is not: a read-only fetch of the pull request's head (ADR 110). Throws why it could not. */
  fetchBase?(w: Worker, source: Project): Promise<void>;
  checkCommand(w: Worker): string;
  model(w: Worker, chat: Chat): string;
  /** The run's prompt, built in its throwaway workspace. */
  prompt(w: Worker, project: Project, context: string[]): string;
  /** speculative_result: what the model is told, or it throws. */
  claim(w: Worker, args: SpeculativeClaimArgs): string;
  /** Its throwaway workspace exists (base: the observed state). */
  launched(w: Worker, ws: Project, base: string): void;
  /** The turn (or the start) ended; its work is committed. Verification and surfacing are the host's. */
  ended(w: Worker, outcome: WorkerOutcome, detail?: string): void;
}

let host: SpeculativeHost | null = null;

export function setSpeculativeHost(h: SpeculativeHost) {
  host = h;
}

/** The text a speculative run is in, for its gate's refusals. */
const UNATTENDED = 'a silent speculative run';

/** The Router's <workers> lines. */
export function workerLines(chatId: string): WorkerLine[] {
  const subscribed = subscriptionsOn(settings.get().superAgent);
  return chatWorkers(chatId).map((w) => ({
    id: w.id,
    bot: bots.get(w.botId)?.name || 'deleted bot',
    status: w.status,
    title: w.title,
    note: isActive(w) ? w.detail : w.report ? `report: ${preview(w.report.text).slice(0, 100)}` : undefined,
    threads: subscribed ? threadsOf(w.threads).map((t) => ({ id: t.id, title: t.title })) : undefined,
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
  /** Subscribe it to the threads it works on (ADR 003): the chat's workspace once it is ready, and these (the batch's routines). */
  subscribe?: boolean;
  threads?: string[];
  /** The lifecycle family whose skills are its playbook (checked against the project by the caller, ADR 007). */
  family?: SkillFamily;
  /** A speculative run (ADR 008): its record's id. It never subscribes, reports or lands. */
  speculation?: string;
}

/** The Worker's family when that family only reads (ADR 007): it may not edit files, and changes ask. */
export function readOnlyFamily(w: Pick<Worker, 'family'>): SkillFamily | undefined {
  return w.family && familyInfo(w.family)?.readOnly ? w.family : undefined;
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
    family: input.family,
    speculation: input.speculation,
  };
  // A blind reviewer stays blind: nothing from the environment or other Workers reaches it.
  if (input.subscribe && !bot.blindReview && !input.speculation)
    w.threads = threadsOf(input.threads)
      .filter((t) => t.kind !== 'chat')
      .map((t) => t.id);
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
  if (w.speculation) return launchSpeculative(w, l);
  const reason = await noWorkspaceReason(chat);
  if (reason) {
    // Checked and set with no await in between: two Workers dispatched together cannot both share the folder.
    const other = activeWorkers(chat.id).find((x) => x.id !== w.id && x.shared);
    if (other) {
      l.first = undefined;
      return finish(w, 'error', `${other.id} is already working in the chat's folder, and Workers can't have a workspace of their own here (${reason})`);
    }
    save(w, { projectId: chatProjectId(chat), shared: reason, detail: undefined });
    const folder = projects.get(chatProjectId(chat));
    if (w.threads && folder) subscribe(w, workspaceThread(folder));
  } else {
    // The chat's branch is where Workers' changes come together: the chat moves into a workspace first.
    if (!workspaceOf(chat)) save(w, { detail: "Moving the chat into a workspace of its own (Workers' changes are merged there)" });
    const chatWs = await whenChatFree(chat.id, async () => workspaceOf(chats.get(chat.id) || chat) ?? ((await doCreate(chat.id)) as Workspace));
    // Where its changes land, shared with the chat's other Workers: their merges, hand edits, console errors.
    if (w.threads) subscribe(w, workspaceThread(chatWs));
    save(w, { detail: 'Creating its own workspace' });
    const { ws, base } = await whenChatFree(chat.id, () => createWorkerWorkspace(chatWs, w));
    // On disk before any work happens there: after a crash, startup finds the worktrees by these records.
    projects.flush();
    chats.flush();
    save(w, { projectId: ws.id, base, landedHead: base, detail: undefined });
    await prepare(w, ws, l);
  }
  if (l.stop) return finish(w, 'stopped', 'Stopped before it began');
  await runLoop(w);
}

/** Runs the project's setup command in a Worker's new workspace; a failure is noted for its first prompt. */
async function prepare(w: Worker, ws: Workspace, l: Live) {
  const setup = configOf(ws).setupCommand;
  if (!setup || l.stop) return;
  save(w, { detail: `Preparing its workspace: ${setup}` });
  const r = await runSetup(ws.path, setup, agentEnvOptions(ws));
  if (!r.ok && l.first) l.first.setupNote = `The workspace setup command \`${setup}\` failed (${r.how}), so some dependencies may be missing:\n${r.out.slice(-1500)}`;
  save(w, { detail: undefined });
}

/**
 * A speculative run's start (ADR 008): a throwaway worktree of the state the problem was seen in.
 * No chat lock, no move into a workspace, no subscriptions: nothing the user would notice.
 */
async function launchSpeculative(w: Worker, l: Live) {
  const source = host?.source(w);
  if (!host || !source) throw new Error('The folder the problem was seen in is gone');
  if (host.fetchBase) {
    save(w, { detail: "Fetching the pull request's head" });
    await host.fetchBase(w, source);
  }
  save(w, { detail: 'Creating its throwaway workspace' });
  const { ws, base } = await createSpeculativeWorkspace(source, w, host.baseCommit?.(w));
  projects.flush();
  save(w, { projectId: ws.id, base, landedHead: base, detail: undefined });
  host.launched(w, ws, base);
  await prepare(w, ws, l);
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
    // A routine run delivered to it is a request of its own; environment events only ride along.
    while (!l.stop && (l.first || w.pending?.length || w.inbox?.some((d) => d.explicit)) && !w.dismissedAt) {
      const first = l.first;
      l.first = undefined;
      const followUps = w.pending || [];
      const delivered = w.inbox || [];
      save(w, { pending: [], ...(delivered.length ? { inbox: [] } : {}) });
      deliveriesRead(delivered.filter((d) => !d.explicit).map((d) => d.triggerId));
      await runTurn(w, first, followUps, delivered);
    }
  } finally {
    l.running = false;
    settleInbox(w);
  }
}

// ---------------------------------------------------------------- subscriptions (ADR 003)

/** Adds a thread to the Worker's subscriptions, storing the thread if nothing has happened on it yet. */
function subscribe(w: Worker, spec: ThreadSpec) {
  const th = ensureThread(spec);
  if (!w.threads?.includes(th.id)) save(w, { threads: [...(w.threads || []), th.id] });
}

/** The Worker leaves a thread (its own call, or the user's): later events there go to the Router again. */
export function unsubscribeWorker(w: Worker, threadId: string): boolean {
  if (!w.threads?.includes(threadId)) return false;
  save(w, { threads: w.threads.filter((id) => id !== threadId) });
  return true;
}

/** A Trigger on one of its threads. A routine run wakes a finished Worker; anything else waits for its session's next step. */
export function deliverToWorker(w: Worker, d: WorkerDelivery) {
  const inbox = pushInbox(w.inbox, d);
  const dropped = (w.inbox || []).filter((x) => !inbox.includes(x)).map((x) => x.triggerId);
  save(w, { inbox, received: (w.received || 0) + 1 });
  if (dropped.length) deliveriesUnread(w.id, dropped, { drop: true });
  const l = liveOf(w.id);
  if (d.explicit && !l.running && w.status !== 'starting') {
    l.stop = false;
    l.quiet = false;
    void runLoop(w);
  }
}

/** What arrived while a turn runs, for the session's next step (the PostToolUse hook); routine runs wait for a turn of their own. */
function takeDeliveries(id: string): string | null {
  const w = workers.get(id);
  const env = (w?.inbox || []).filter((d) => !d.explicit);
  if (!w || !env.length) return null;
  save(w, { inbox: (w.inbox || []).filter((d) => d.explicit) });
  deliveriesRead(env.map((d) => d.triggerId));
  return deliveredNote(env, Date.now(), !!liveOf(id).recall);
}

/**
 * The Worker went idle with deliveries its session never read (they came after its last step, or
 * it was stopped): a routine run goes to the Router, an environment event back to the normal path
 * unless another Worker read it. All dropped when the user stopped the whole chat.
 */
function settleInbox(w: Worker) {
  const l = liveOf(w.id);
  const left = w.inbox || [];
  if (!left.length || l.running) return;
  save(w, { inbox: [] });
  deliveriesUnread(
    w.id,
    left.filter((d) => !d.explicit).map((d) => d.triggerId),
    { drop: l.quiet },
  );
  if (!l.quiet) for (const d of left.filter((x) => x.explicit)) handBackTrigger(w, d.threadId, d.triggerId, 'It stopped before taking this run');
}

/** The Worker's thread tools: each returns what the model is told, or throws. */
function threadHandlers(id: string): NonNullable<CrewContext['threads']> {
  const mine = (threadId: string) => {
    const w = workers.get(id);
    const t = String(threadId || '').trim();
    if (!w?.threads?.includes(t)) throw new Error(`You do not subscribe to ${t || 'that thread'}. Each event you got names its thread (thread="th_…").`);
    return { w, t };
  };
  return {
    unsubscribe(threadId) {
      const { w, t } = mine(threadId);
      unsubscribeWorker(w, t);
      return `Unsubscribed from ${t}; its events go to the Router again.`;
    },
    handBack(threadId, triggerId, note) {
      const { w, t } = mine(threadId);
      const tg = handBackTrigger(w, t, triggerId, note);
      if (triggerId && !tg) throw new Error(`${triggerId} did not come to you on ${t}.`);
      unsubscribeWorker(w, t);
      return tg ? `Gave ${tg.id} back to the Router, and unsubscribed from ${t}.` : `Unsubscribed from ${t}; you had received no event there to give back.`;
    },
  };
}

/** The same tools for the demo agent, which calls them without an MCP client. */
function fakeThreadTools(id: string): SessionConfig['fakeTools'] {
  const h = threadHandlers(id);
  const run = async (fn: () => string) => {
    try {
      return { text: fn() };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    unsubscribe_thread: (a) => run(() => h.unsubscribe(String(a.thread))),
    hand_back: (a) => run(() => h.handBack(String(a.thread), s(a.event), s(a.note))),
  };
}

function getSession(w: Worker, chat: Chat, bot: Bot, project: Project | null): AgentSession {
  const l = liveOf(w.id);
  if (l.session && !l.session.closed) return l.session;
  const eff = effectiveBot(chat, bot);
  const conf = project ? configOf(project) : null;
  const cwd = project?.path || os.homedir();
  const lead = leadOf(chat);
  // Read when the session starts: switching subscriptions or recall on or off refreshes Worker sessions.
  const subscribed = subscriptionsOn(settings.get().superAgent) && !!w.threads;
  const recall = recallBudget();
  // A speculative run (ADR 008): its own gateway role and model, its check command pre-allowed, its claim tool.
  const spec = w.speculation && host ? host : null;
  const check = spec ? spec.checkCommand(w) : '';
  const model = spec ? spec.model(w, chat) : workerModel(chat);
  const role = spec ? ('speculative' as const) : ('worker' as const);
  const claim = spec ? (args: SpeculativeClaimArgs) => spec.claim(w, args) : undefined;
  const crewCtx: CrewContext = {
    botId: bot.id,
    botName: bot.name,
    chatId: chat.id,
    blind: !!bot.blindReview,
    projectId: () => w.projectId,
    currentPage: () => (w.projectId ? previewPageOf(w.projectId) : undefined),
    actKey: w.id,
    worker: true,
    workerId: w.id,
    threads: subscribed ? threadHandlers(w.id) : undefined,
    recall: !!recall,
    speculative: claim ? { result: claim } : undefined,
  };
  const actor = { botId: bot.id, botName: bot.name, chatId: chat.id, workerId: w.id };
  const cfg: SessionConfig = {
    cwd,
    model: botModel(model, { role, botId: bot.id }),
    effort: eff.effort || undefined,
    systemAppend: buildSystemAppend({
      bot: eff,
      chat,
      project,
      team: bots.all(),
      skills: skills.forPrompt(project),
      worker: { lead: lead?.name || 'the lead', shared: w.shared, subscriptions: subscribed, speculative: spec ? { checkCommand: check } : undefined },
      recall: !!recall,
    }),
    resume: w.sessionId,
    permissionMode: permissionModeFor(eff.permission),
    allowRules: [...bot.allowRules, 'mcp__crew', ...(check ? [`Bash(${check})`, `Bash(${check}:*)`] : [])],
    askRules: [...bot.askRules, ...(conf?.askRules || [])],
    denyRules: settings.get().denyRules || [],
    deniedReason: (toolName, input) => deniedReason(toolName, input, cwd, { project, actor, readOnly: readOnlyFamily(w) }),
    wrapUpAt: () => settings.get().wrapUpAtTokens,
    deliveries: subscribed ? () => takeDeliveries(w.id) : undefined,
    attributionOff: !!conf?.noAttribution,
    sandbox: sandboxOptions(settings.get().sandbox.enabled, settings.get().sandbox.allowedDomains, conf?.allowedDomains, cwd),
    mcpServers: {
      crew: crewServer(crewCtx) as McpServerConfig,
      ...pluginServers(bot),
    },
    settingSources: bot.loadUserSettings ? ['user', 'project', 'local'] : ['project', 'local'],
    env: agentEnv({ role, botId: bot.id }, model || settings.get().defaultModel || undefined, project),
    role: spec ? 'speculative' : 'worker',
    fakeTools: claim
      ? {
          speculative_result: async (args) => {
            try {
              return { text: claim(args as unknown as SpeculativeClaimArgs) };
            } catch (e) {
              return { text: (e as Error).message, isError: true };
            }
          },
        }
      : {
          ...(subscribed ? fakeThreadTools(w.id) : undefined),
          draft_external_action: (args) => draftAction(crewCtx, args as unknown as DraftFields),
        },
  };
  const onSessionId = (sid: string) => {
    if (w.sessionId !== sid) save(w, { sessionId: sid });
  };
  l.session = FAKE_AGENT ? new FakeSession(cfg, bot.name, [], onSessionId) : new BotSession(cfg, onSessionId);
  l.context = undefined;
  l.recall = recall;
  l.recallNote = !!recall && !!cfg.resume;
  if (w.model !== (cfg.model || 'default')) save(w, { model: cfg.model || 'default' });
  return l.session;
}

/** The turn's prompt: the task (and the user's own words) the first time, follow-ups after. */
async function promptFor(w: Worker, chat: Chat, bot: Bot, project: Project | null, first: Live['first'], followUps: string[], delivered: WorkerDelivery[], msg: ChatMessage) {
  const l = liveOf(w.id);
  const lead = leadOf(chat);
  const context = contextLines(project);
  const sent = l.context;
  l.context = context;
  // A speculative run's task is the host's; follow-ups never come (nobody talks to it).
  if (w.speculation && host && project && first) return host.prompt(w, project, contextDelta(sent, context));
  const users = (first?.userMessageIds || []).map((id) => messages.get(chat.id, id)).filter((m): m is ChatMessage => !!m);
  const conflict = w.landing?.conflicts?.length && project?.workspace ? { branch: project.workspace.baseBranch, files: w.landing.conflicts } : undefined;
  // A blind reviewer sees the user's words and the chat branch's change, and the task as a handover.
  const chatWs = bot.blindReview && first ? workspaceOf(chat) : undefined;
  const review = bot.blindReview && first ? (chatWs ? await reviewDiff(chatWs).catch(() => undefined) : project ? await reviewDiff(project).catch(() => undefined) : undefined) : undefined;
  const build = (recall?: Budget) => {
    const delta = contextDelta(sent, context, recall ? 'env' : undefined);
    if (first?.setupNote) delta.push(first.setupNote);
    if (bot.blindReview && first) {
      const handover: ChatMessage = { id: 'handover', chatId: chat.id, seq: 0, ts: Date.now(), role: 'bot', botId: lead?.id, text: `@${bot.name} ${w.task}` };
      return buildTurnPrompt({
        bot,
        chat,
        unseen: [...users, handover],
        names: new Map(bots.all().map((b) => [b.id, b.name])),
        context: delta,
        trigger: { type: 'mention', by: lead?.id },
        review,
      });
    }
    return workerPrompt({
      context: delta,
      lead: lead?.name || 'the Router',
      title: first ? w.title : undefined,
      task: first ? w.task : undefined,
      followUps,
      userWords: users.map((m) => ({ seq: m.seq, text: renderUserMessage(m, recall?.user) })),
      conflict,
      threads: first ? threadsOf(w.threads).map((t) => ({ id: t.id, title: t.title, kind: t.kind })) : undefined,
      delivered,
      recall: !!recall,
      playbook:
        first && w.family
          ? {
              family: w.family,
              readOnly: !!readOnlyFamily(w),
              skills: skills.forFamily(project, w.family, 'worker').map((s) => ({ name: s.name, title: s.title, body: s.body })),
            }
          : undefined,
    });
  };
  let text = build();
  if (l.recall) {
    const without = text;
    text = build(l.recall);
    if (l.recallNote) {
      l.recallNote = false;
      text = `${RECALL_RESUME_NOTE}\n\n${text}`;
    }
    msg.meta = { ...msg.meta, injected: measureInjected(`Worker ${w.id} (${bot.name})`, text, without) };
  }
  const imgs = first ? imageBlocks(users) : [];
  return imgs.length ? [{ type: 'text' as const, text }, ...imgs] : text;
}

async function runTurn(w: Worker, first: Live['first'], followUps: string[], delivered: WorkerDelivery[] = []) {
  const chat = chats.get(w.chatId);
  const bot = bots.get(w.botId);
  if (!chat || !bot) return finish(w, 'error', 'The chat or its member no longer exists');
  if (overMonthlyBudget(bot)) return finish(w, 'error', `${bot.name} has used up this month's budget`);
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
    content: (_s, msg) => promptFor(w, chat, bot, project, first, followUps, delivered, msg),
    hooks: (stream) => ({
      beforeEdit: () => {},
      canUseTool: permissionGate({
        chat,
        bot,
        project,
        cwd,
        stream,
        status: (s) => status(s.state, s.detail),
        who: `${bot.name} (Worker "${w.title}")`,
        workerId: w.id,
        readOnly: readOnlyFamily(w),
        unattended: w.speculation ? UNATTENDED : undefined,
      }),
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

  if (w.speculation) return endSpeculative(w, project, msg, l.stop);

  let landing: Worker['landing'];
  if (project?.workspace?.workerId) landing = await commitAndLand(w, bot, project as Workspace, msg);
  const outcome = l.stop || msg.status === 'stopped' ? 'stopped' : msg.status === 'done' ? 'done' : 'error';
  const text = (outcome === 'error' ? `Failed: ${msg.error || 'unknown error'}\n\n${msg.text}` : msg.text).trim().slice(0, REPORT_CHARS);
  save(w, { turns: w.turns + 1, costUsd: w.costUsd + (msg.meta?.costUsd || 0), landing: landing ?? w.landing });
  if (landing) publishLanding(w, chat, bot, landing);
  publishResult(w, chat, bot, msg, outcome);
  finish(w, outcome, outcome === 'error' ? (msg.error || '').split('\n')[0].slice(0, 160) : undefined, text);
}

/**
 * A speculative run's turn ended: its work is committed to its throwaway branch, never landed, and
 * nothing is reported to a Router or published as a turn result. The host verifies it (ADR 008).
 */
async function endSpeculative(w: Worker, project: Project | null, msg: ChatMessage, stopped: boolean) {
  const outcome = stopped || msg.status === 'stopped' ? 'stopped' : msg.status === 'done' ? 'done' : 'error';
  let detail = outcome === 'error' ? (msg.error || 'unknown error').split('\n')[0].slice(0, 160) : outcome === 'stopped' ? liveOf(w.id).why : undefined;
  const wt = project?.workspace?.worktree;
  if (wt) await autoCommit(wt, `Speculative run: ${commitSubject(msg.text, w.title)}`).catch((e) => (detail = `Couldn't commit its changes: ${gitError(e)}`));
  save(w, { turns: w.turns + 1, costUsd: w.costUsd + (msg.meta?.costUsd || 0) });
  finish(w, outcome, detail, msg.text.trim().slice(0, REPORT_CHARS));
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

/**
 * Another Worker's merge, for the Workers sharing the chat's branch (ADR 003). Written by Crew from
 * facts (who, which files, which commit), never from the Worker's own words: not a channel between Workers.
 */
function publishLanding(w: Worker, chat: Chat, bot: Bot, landing: NonNullable<Worker['landing']>) {
  const chatWs = workspaceOf(chat);
  if (!subscriptionsOn(settings.get().superAgent) || !chatWs || !landing.commit || !landing.files.length) return;
  const files = landing.files;
  const list = `${files.slice(0, 8).join(', ')}${files.length > 8 ? ` and ${files.length - 8} more` : ''}`;
  const text = `${bot.name}'s Worker ${w.id} ("${w.title}") merged ${files.length} file${files.length === 1 ? '' : 's'} into ${chatWs.workspace.branch} (commit ${landing.commit}): ${list}`;
  publishTrigger({
    source: 'landing',
    summary: text,
    thread: workspaceThread(chatWs),
    ref: { kind: 'payload' },
    payload: { text, files: files.slice(0, 200), commit: landing.commit, workerId: w.id },
    chatId: chat.id,
    projectId: chatWs.id,
    subjects: files,
    related: [w.id],
    origin: w.id,
  });
}

/** Records how the turn (or the start) ended and tells the Router, unless the whole chat was stopped. */
function finish(w: Worker, outcome: WorkerOutcome, detail?: string, text?: string) {
  const l = liveOf(w.id);
  const report = { at: Date.now(), status: outcome, text: text ?? (detail ? `${outcome === 'error' ? 'Failed' : 'Stopped'}: ${detail}` : ''), ...(l.quiet ? { quiet: true } : {}) };
  save(w, { status: outcome, detail, report });
  // It never got to run (a failed start): what was delivered to it goes on.
  if (!l.running) settleInbox(w);
  // A speculative run tells nobody: its host decides what comes of it.
  if (w.speculation) {
    host?.ended(w, outcome, detail);
    return;
  }
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

/**
 * A Worker that failed or was stopped starts over in a new session, from a recap: its task again,
 * what it reported last, where its work is, and the note. Its branch and workspace stay.
 */
export function restartWorker(w: Worker, recap: string) {
  if (isActive(w) || w.dismissedAt) throw new Error(`Only a failed or stopped Worker can be restarted (this one is ${w.dismissedAt ? 'dismissed' : w.status})`);
  const l = liveOf(w.id);
  l.session?.close();
  l.session = null;
  l.context = undefined;
  l.stop = false;
  l.quiet = false;
  l.first = { userMessageIds: [] };
  save(w, { sessionId: undefined, status: 'starting', detail: 'Restarting in a new session', pending: [recap] });
  void runLoop(w);
}

/** Stops a Worker's turn (or its start). `quiet`: the whole chat was stopped, so the Router is not told. */
export async function stopWorker(id: string, opts: { quiet?: boolean; why?: string } = {}): Promise<boolean> {
  const w = workers.get(id);
  if (!w || !isActive(w)) return false;
  const l = liveOf(id);
  l.stop = true;
  l.quiet = !!opts.quiet;
  l.why = opts.why;
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
  await Promise.all(
    chatWorkers(chatId, { speculative: true })
      .filter(isActive)
      .map((w) => stopWorker(w.id, { quiet: true, why: 'The user stopped the chat' })),
  );
}

/** Removes a finished Worker's workspace; a branch whose work never reached the chat's branch is kept. */
export async function dismissWorker(w: Worker) {
  if (isActive(w)) throw new Error('Stop the Worker first');
  const l = live.get(w.id);
  l?.session?.close();
  live.delete(w.id);
  deliveriesUnread(
    w.id,
    (w.inbox || []).map((d) => d.triggerId),
    { drop: true },
  );
  save(w, { dismissedAt: Date.now(), pending: [], ...(w.inbox?.length ? { inbox: [] } : {}), ...(w.threads?.length ? { threads: [] } : {}) });
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
  for (const w of chatWorkers(chatId, { all: true, speculative: true })) {
    live.get(w.id)?.session?.close();
    live.delete(w.id);
    deliveriesUnread(
      w.id,
      (w.inbox || []).map((d) => d.triggerId),
      { drop: true },
    );
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
export function recoverWorkers(now = Date.now()): { live: Set<string>; interrupted: Worker[]; undelivered: { worker: Worker; threadId: string; triggerId: string }[] } {
  const interrupted: Worker[] = [];
  const undelivered: { worker: Worker; threadId: string; triggerId: string }[] = [];
  for (const w of workers.all()) {
    if (w.dismissedAt && now - w.dismissedAt > KEEP_DISMISSED_MS) {
      workers.delete(w.id);
      messages.deleteChat(w.id);
      continue;
    }
    // Routine runs still in its inbox go to the Router (resumeRouters); stale environment events are dropped.
    if (w.inbox?.length) {
      for (const d of w.inbox) if (d.explicit) undelivered.push({ worker: w, threadId: d.threadId, triggerId: d.triggerId });
      w.inbox = [];
      workers.set(w);
    }
    if (!WORKER_ACTIVE.has(w.status)) continue;
    w.status = 'stopped';
    w.detail = 'Crew restarted';
    w.report = { at: now, status: 'stopped', text: 'Interrupted by a restart of Crew; its work so far is kept on its branch.' };
    w.pending = [];
    w.updatedAt = now;
    workers.set(w);
    // A speculative run is discarded by its host (ADR 008); no Router ever knew of it.
    if (!w.speculation) interrupted.push(w);
  }
  return {
    live: new Set(
      workers
        .all()
        .filter((w) => !w.dismissedAt)
        .map((w) => w.id),
    ),
    interrupted,
    undelivered,
  };
}

/** Hourly: finished Workers nobody has touched for hours give their worktrees back. */
export function sweepWorkers(now = Date.now()) {
  for (const w of workers.all()) if (!w.dismissedAt && !w.speculation && !isActive(w) && now - w.updatedAt > IDLE_DISMISS_MS) void dismissWorker(w).catch(() => {});
}
