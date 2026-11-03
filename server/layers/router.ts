// The Router layer (ADR 002): one resident session per group chat in two-layer mode. It is given
// every event in the chat that needs a decision (the user's messages, routine runs, Workers'
// reports, environment Triggers the filter acted on), keeps the chat's context, is the only one
// that talks to the user (speaking as the lead), and dispatches Workers. It never executes:
// its Claude Code session has no built-in tools, only the crew_router tools (tools.ts).
//
// Events that arrive while it is thinking wait in its inbox and all go into the next turn
// together: one call, several decisions.

import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { familyInfo } from '../../shared/families';
import type { Bot, Chat, ChatMessage, RouterInfo } from '../../shared/types';
import { type AgentSession, BotSession, FakeSession, type SessionConfig } from '../agents/session';
import type { TurnStream } from '../agents/stream';
import { NO_TOOL_SEARCH } from '../agents/toolSearch';
import { findSkeptic } from '../autoChallenge';
import { bus, notify } from '../bus';
import { botModel } from '../claudeAuth';
import { FAKE_AGENT, HOME_DIR } from '../config';
import { MODEL_OPTIONS } from '../data/catalog';
import { githubRouterSection } from '../github/prompt';
import { githubChannelOf } from '../github/router';
import { logger } from '../log';
import { emitChat, systemMessage } from '../orchestrator/chatLog';
import { deniedReason } from '../orchestrator/permissionGate';
import { agentEnv } from '../orchestrator/turnContext';
import { type Budget, measureInjected, RECALL_RESUME_NOTE, recallBudget } from '../recall';
import { projectFamilies } from '../skills';
import { bots, chats, messages, projects, routerLogId, settings, workers } from '../store';
import { directRuns, handBackTrigger } from '../triggers';
import { overMonthlyBudget } from '../usage';
import { BatchQueue } from './batch';
import { type DirectLine, explicitEvent, type FamilyLine, type RouterEvent, recapText, renderBatch, routerSystemPrompt, type TeamMember } from './prompts';
import { routerRedo } from './recovery';
import { subscriptionsOn } from './subscriptions';
import { routerMcpServer, routerTools, type TurnCtx } from './tools';
import { runLogged } from './turn';
import { landingText, type recoverWorkers, workerLines } from './workers';

const log = logger('router');

/** The lifecycle families the chat's project opted in to, with the adversarial reviewer for review (ADR 007). */
function familiesFor(chat: Chat): FamilyLine[] {
  const members = bots.all().filter((b) => chat.botIds.includes(b.id));
  const skeptic = findSkeptic(members);
  return projectFamilies(projects.get(chat.projectId)).map((id) => {
    const f = familyInfo(id);
    return { id, description: f.description, readOnly: f.readOnly, reviewer: id === 'review' ? skeptic?.name : undefined };
  });
}

/** Messages a new Router session gets again, so the conversation carries on. */
const RECAP_MESSAGES = 12;
/**
 * One folder for every Router, whatever its chat's project: Claude Code keeps transcripts per
 * folder, and a chat moving into its workspace must not cost the Router its session.
 */
const ROUTER_CWD = path.join(HOME_DIR, 'router');
const TOPIC_MARK = '—— New topic ——';
/** Direct deliveries kept for the Router's next batch at most; it observes them, it does not decide. */
const OBSERVED_MAX = 50;

/** Group chats run in two layers while the Super-agent and its Router switch are both on. */
export function routerMode(chat: Chat | null | undefined): boolean {
  const sa = settings.get().superAgent;
  return !!chat && chat.kind === 'group' && sa.enabled && sa.router.enabled;
}

/** Who the Router speaks as: the chat's lead, else its first member. */
export function leadOf(chat: Chat): Bot | undefined {
  const lead = chat.leadBotId && chat.botIds.includes(chat.leadBotId) ? bots.get(chat.leadBotId) : undefined;
  return lead ?? bots.all().find((b) => chat.botIds.includes(b.id));
}

function profileOf(b: Bot): string {
  const bits: string[] = [];
  if (b.permission === 'plan') bits.push('read-only');
  if (b.blindReview) bits.push("blind reviewer: sees only the user's words and the change");
  if (b.editScope?.length) bits.push(`edits only ${b.editScope.slice(0, 3).join(', ')}${b.editScope.length > 3 ? ', etc.' : ''}`);
  const tier = MODEL_OPTIONS.find((m) => m.id === b.model)?.tier;
  if (tier === 'low') bits.push('usually on a cheap model');
  return bits.join('; ');
}

class ChatRouter {
  readonly queue: BatchQueue<RouterEvent>;
  session: AgentSession | null = null;
  stream: TurnStream | null = null;
  current: TurnCtx | null = null;
  state: RouterInfo['state'] = 'idle';
  detail?: string;
  since = Date.now();
  /** Triggers that went straight to this chat's Workers since the Router's last turn (ADR 003). */
  observed: DirectLine[] = [];
  /** The session outgrew rotateAtTokens: the next turn starts a new one, with a recap. */
  private rotateAt: number | null = null;
  private readonly tools = routerTools(() => this.current);
  /** The budgets this Router's session was started with (the chain of recall), or none. */
  private recall: Budget | undefined;
  private recallNote = false;

  constructor(readonly chatId: string) {
    this.queue = new BatchQueue(
      (batch) => this.run(batch),
      () => this.emit(),
    );
  }

  /**
   * Environment events never share a turn with explicit ones: the dispatch gate holds per event,
   * so injected text cannot ride along with the user's next "ok".
   */
  private async run(batch: RouterEvent[]) {
    const explicit = batch.filter(explicitEvent);
    const environment = batch.filter((e) => !explicitEvent(e));
    if (explicit.length) await this.turn(explicit);
    if (environment.length) await this.turn(environment);
  }

  info(): RouterInfo {
    return { chatId: this.chatId, state: this.state, queued: this.queue.waiting, detail: this.detail, since: this.since };
  }

  emit() {
    bus.emit({ t: 'router', router: this.info() });
  }

  private setState(state: RouterInfo['state'], detail?: string) {
    if (state === this.state && detail === this.detail) return;
    if (state !== this.state) this.since = Date.now();
    this.state = state;
    this.detail = detail;
    this.emit();
  }

  get busy() {
    return this.queue.busy;
  }

  private getSession(chat: Chat, lead: Bot): AgentSession {
    if (this.session && !this.session.closed) return this.session;
    const rs = settings.get().superAgent.router;
    const subscribed = subscriptionsOn(settings.get().superAgent);
    // The tools are fixed for the session's life: so is whether it has recall.
    this.recall = recallBudget();
    // A resumed session keeps the system prompt it started with: its first batch says recall is new.
    this.recallNote = !!this.recall && !!chat.router?.sessionId;
    fs.mkdirSync(ROUTER_CWD, { recursive: true });
    // GitHub as an asynchronous channel (ADR 102): its tool and prompt section, fixed for the session's life like the rest.
    const github = githubChannelOf(chat);
    const team: TeamMember[] = bots
      .all()
      .filter((b) => chat.botIds.includes(b.id))
      .map((b) => ({ name: b.id === lead.id ? `${b.name} (you)` : b.name, title: b.title, profile: profileOf(b) }));
    const cfg: SessionConfig = {
      cwd: ROUTER_CWD,
      model: botModel(rs.model, { role: 'router', botId: lead.id }),
      systemAppend: '',
      systemPrompt: routerSystemPrompt({
        lead: lead.name,
        leadTitle: lead.title,
        chat: chat.title,
        role: lead.description,
        team,
        maxWorkers: rs.maxWorkers,
        subscriptions: subscribed,
        recall: !!this.recall,
        families: familiesFor(chat),
      }),
      // No Bash, Read, Edit, Write, WebFetch or Task: the Router coordinates, Workers execute.
      tools: [],
      resume: chat.router?.sessionId,
      permissionMode: 'default',
      allowRules: ['mcp__crew_router'],
      askRules: [],
      denyRules: settings.get().denyRules || [],
      // The deny hook every agent session has (blocked actions, then the command guard, ADR 007), as for the Watchdog.
      deniedReason: (toolName, input) => deniedReason(toolName, input, ROUTER_CWD, { actor: { botId: lead.id, botName: lead.name, chatId: chat.id } }),
      mcpServers: { crew_router: routerMcpServer(this.tools, { subscriptions: subscribed, recall: !!this.recall, github: !!github }) as McpServerConfig },
      // No settings files, CLAUDE.md or hooks: nothing in the project can widen what the Router may do.
      settingSources: [],
      env: { ...agentEnv({ role: 'router', botId: lead.id }, rs.model || settings.get().defaultModel || undefined), ...NO_TOOL_SEARCH },
      role: 'router',
      fakeTools: this.tools,
    };
    if (github) cfg.systemPrompt += `\n${githubRouterSection(github.conf.repos, subscribed).join('\n')}`;
    const onSessionId = (sid: string) => {
      const c = chats.get(this.chatId);
      if (!c || c.router?.sessionId === sid) return;
      c.router = { ...c.router, sessionId: sid };
      chats.save();
    };
    const members = bots
      .all()
      .filter((b) => chat.botIds.includes(b.id))
      .map((b) => b.name);
    this.session = FAKE_AGENT ? new FakeSession(cfg, lead.name, members, onSessionId) : new BotSession(cfg, onSessionId);
    return this.session;
  }

  /** The latest messages of the current topic before `beforeSeq`, for a new session's recap. */
  private recap(chat: Chat, beforeSeq: number, why: string): string | undefined {
    const list = messages.sorted(chat.id);
    const topicStart = [...list].reverse().find((m) => m.role === 'system' && m.uiOnly && m.text === TOPIC_MARK)?.seq ?? 0;
    const lead = leadOf(chat);
    const who = (m: ChatMessage) => (m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : m.router || m.botId === lead?.id ? 'You' : `@${bots.get(m.botId)?.name || 'teammate'}`);
    const lines = list
      .filter((m) => m.seq > topicStart && m.seq < beforeSeq && !m.uiOnly && m.status !== 'streaming' && m.text.trim())
      .slice(-RECAP_MESSAGES)
      .map((m) => ({ who: who(m), seq: m.seq, text: m.prompt || m.text }));
    return lines.length ? recapText({ why, lines }) : undefined;
  }

  private async turn(batch: RouterEvent[]) {
    const chat = chats.get(this.chatId);
    if (!chat) return;
    const lead = leadOf(chat);
    if (!lead) {
      systemMessage(chat, 'This chat has no bot to act as its Router.', { uiOnly: true });
      return;
    }
    // Handed over now: after a restart, only messages past this point are given again.
    const seqs = batch.flatMap((e) => (e.kind === 'user' || e.kind === 'routine' ? [e.seq] : []));
    if (seqs.length) {
      chat.router = { ...chat.router, cursor: Math.max(chat.router?.cursor ?? 0, ...seqs) };
      // At once: a cursor lost in a crash would hand these messages over a second time.
      chats.flush();
    }
    if (overMonthlyBudget(lead)) {
      systemMessage(
        chat,
        `${lead.name} speaks for this chat's Router and has used up this month's budget ($${lead.monthlyBudgetUsd.toFixed(2)}), so the Router can't take events for now. Raise the budget or remove the limit in its settings.`,
      );
      return;
    }

    // Why this turn starts a new session, if it does: the recap is built when the prompt is.
    let recapWhy: string | undefined;
    const firstSeq = seqs.length ? Math.min(...seqs) : chat.seq + 1;
    if (this.rotateAt !== null) {
      recapWhy = `the previous one had grown to ${Math.round(this.rotateAt / 1000)}k tokens of context, re-read on every call`;
      this.rotateAt = null;
      this.session?.close();
      this.session = null;
      chat.router = { ...chat.router, sessionId: undefined };
      chats.save();
    } else if (!this.session && !chat.router?.sessionId) recapWhy = 'you are taking over this conversation as its Router';

    const related = [...new Set(batch.flatMap((e) => [e.id, ...((e.kind === 'user' || e.kind === 'routine') && e.triggerId ? [e.triggerId] : [])]))];
    // A routine's thread is what a Worker dispatched for its run subscribes to.
    const threads = [...new Set(batch.flatMap((e) => (e.kind === 'routine' && e.threadId ? [e.threadId] : [])))];
    this.current = {
      chatId: chat.id,
      lead,
      explicit: batch.some(explicitEvent),
      related,
      userMessageIds: batch.flatMap((e) => (e.kind === 'user' ? [e.id] : [])),
      threads,
      reports: batch.flatMap((e) => (e.kind === 'worker' ? [e.id] : [])),
    };
    const direct = this.observed.splice(0);
    if (subscriptionsOn(settings.get().superAgent)) countRouterEvents(chat.id, 'decided', batch.length);
    this.setState('thinking');
    const { msg, session } = await runLogged({
      logId: routerLogId(chat.id),
      botId: lead.id,
      cwd: ROUTER_CWD,
      trigger: { type: 'system' },
      batch: batch.map((e) => e.id),
      session: () => this.getSession(chat, lead),
      forgetResume: () => {
        const c = chats.get(this.chatId);
        if (!c?.router?.sessionId) return false;
        this.session?.close();
        this.session = null;
        c.router = { ...c.router, sessionId: undefined };
        chats.save();
        recapWhy ??= 'the previous session could not be resumed';
        return true;
      },
      content: (_s, msg) => {
        const now = Date.now();
        const recap = recapWhy ? this.recap(chat, firstSeq, recapWhy) : undefined;
        const lines = workerLines(chat.id);
        const text = renderBatch(batch, lines, now, recap, direct);
        if (!this.recall) return text;
        let spilled = renderBatch(batch, lines, now, recap, direct, this.recall);
        if (this.recallNote) {
          this.recallNote = false;
          spilled = `${RECALL_RESUME_NOTE}\n\n${spilled}`;
        }
        msg.meta = { ...msg.meta, injected: measureInjected(`Router of ${chat.title}`, spilled, text) };
        return spilled;
      },
      hooks: () => ({
        beforeEdit: () => {},
        // The deny-everything-else gate, behind `tools: []`: only the Router's own tools run.
        canUseTool: async (name, input) =>
          name.startsWith('mcp__crew_router__')
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: 'The Router has no tools of its own. Dispatch a Worker for anything that needs files, commands or pages.' },
      }),
      onActivity: (state, detail) => this.setState('thinking', state === 'tool' ? detail?.replace(/^mcp__crew_router__/, '') : undefined),
      started: (stream, s) => {
        this.stream = stream;
        this.session = s;
      },
    });
    this.current = null;
    this.stream = null;
    if (!session) this.session = null;
    else void this.measure(session);
    if (msg.status === 'error') {
      const first = (msg.error || 'Unknown error').split('\n')[0].slice(0, 160);
      this.setState('error', first);
      systemMessage(chats.get(this.chatId) || chat, `The Router couldn't finish handling the latest events: ${first}. Send a message to try again.`, { uiOnly: true });
      notify('The Router hit an error', first, { chatId: chat.id, level: 'error' });
    } else this.setState('idle');
  }

  /** Every call re-reads the whole session: past rotateAtTokens, the next turn starts over with a recap. */
  private async measure(session: AgentSession) {
    const usage = await session.contextUsage?.().catch(() => null);
    const limit = settings.get().rotateAtTokens;
    if (usage && limit > 0 && usage.used >= limit) this.rotateAt = usage.used;
  }

  async stop() {
    // Dropped on purpose: after a restart they are not handed over again.
    const seqs = this.queue.clear().flatMap((e) => (e.kind === 'user' || e.kind === 'routine' ? [e.seq] : []));
    const chat = chats.get(this.chatId);
    if (chat) {
      // The whole inbox is dropped, Workers' reports included: a restart must not hand them over again (ADR 105).
      chat.router = { ...chat.router, stoppedAt: Date.now(), ...(seqs.length ? { cursor: Math.max(chat.router?.cursor ?? 0, ...seqs) } : {}) };
      chats.flush();
    }
    const stream = this.stream;
    if (!stream) return;
    stream.stopped = true;
    await this.session?.interrupt();
  }

  /** A new topic: the next turn is a new conversation, with no recap. */
  reset() {
    this.session?.close();
    this.session = null;
    this.rotateAt = null;
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}

const routers = new Map<string, ChatRouter>();

function routerOf(chatId: string): ChatRouter {
  const r = routers.get(chatId) ?? new ChatRouter(chatId);
  routers.set(chatId, r);
  return r;
}

/** A Trigger went straight to the chat's Workers: the Router sees it in its next batch, whenever that comes. */
export function noteDirect(chatId: string, line: DirectLine) {
  if (!chats.get(chatId)) return;
  const r = routerOf(chatId);
  r.observed.push(line);
  if (r.observed.length > OBSERVED_MAX) r.observed.splice(0, r.observed.length - OBSERVED_MAX);
}

/** The chat's counts of events its Router decided on and events that went straight to its Workers (Router decisions avoided). */
export function countRouterEvents(chatId: string, key: 'decided' | 'direct', delta: number) {
  const chat = chats.get(chatId);
  if (!chat || !delta) return;
  chat.router = { ...chat.router, [key]: Math.max(0, (chat.router?.[key] ?? 0) + delta) };
  emitChat(chat);
}

/** Puts an event in the chat's Router inbox; it is handled in the Router's next turn. */
export function routerEvent(chatId: string, ev: RouterEvent) {
  if (!chats.get(chatId)) return;
  routerOf(chatId).queue.push(ev);
}

export function routerInfos(): RouterInfo[] {
  return [...routers.values()].map((r) => r.info());
}

export function routerBusy(chatId: string): boolean {
  const r = routers.get(chatId);
  return !!r && (r.busy || r.queue.waiting > 0);
}

/** The user stopped the chat: the Router's turn stops and what waited in its inbox is dropped. */
export async function stopRouter(chatId: string) {
  await routers.get(chatId)?.stop();
}

/** "Start new topic": the Router forgets this chat's conversation. */
export function resetRouter(chatId: string) {
  routers.get(chatId)?.reset();
  const chat = chats.get(chatId);
  if (chat?.router?.sessionId) {
    chat.router = { ...chat.router, sessionId: undefined };
    chats.save();
  }
}

export function forgetRouter(chatId: string) {
  routers.get(chatId)?.close();
  routers.delete(chatId);
  messages.deleteChat(routerLogId(chatId));
}

/** The Router's settings changed: sessions restart (resumed) with them at their next turn. */
export function invalidateRouters() {
  for (const r of routers.values()) if (!r.busy) r.close();
}

export function closeRouterSessions() {
  for (const r of routers.values()) r.close();
}

/**
 * On start, for chats in two-layer mode: give the Router again the user's messages it had not been
 * handed yet, and tell it about the Workers a restart cut off.
 */
export function resumeRouters({ interrupted, undelivered }: Pick<ReturnType<typeof recoverWorkers>, 'interrupted' | 'undelivered'>) {
  for (const chat of chats.all()) {
    if (!routerMode(chat)) continue;
    const cursor = chat.router?.cursor;
    const asEvent = (m: ChatMessage, resumed?: 'cut-off'): RouterEvent =>
      m.trigger?.type === 'routine'
        ? { kind: 'routine', id: m.id, at: m.ts, seq: m.seq, text: m.prompt || m.text, routine: 'routine', resumed }
        : { kind: 'user', id: m.id, at: m.ts, seq: m.seq, text: m.prompt || m.text, attachments: m.attachments?.length, resumed };
    // What a cut-off Router turn took without dispatching, and Workers' reports it never finished reading (ADR 105).
    const chatWorkers = workers.all().filter((w) => w.chatId === chat.id);
    const redo = routerRedo({
      turns: messages.sorted(routerLogId(chat.id)),
      workers: chatWorkers,
      cutOff: new Set(interrupted.map((w) => w.id)),
      stoppedAt: chat.router?.stoppedAt,
      now: Date.now(),
    });
    for (const id of redo.messages) {
      const m = messages.get(chat.id, id);
      if (m && m.role === 'user' && !m.uiOnly) routerEvent(chat.id, asEvent(m, 'cut-off'));
    }
    if (cursor !== undefined) {
      // Routine runs that went straight to a Worker are not the Router's (those a restart cut off come below).
      const direct = directRuns(chat.id);
      for (const m of messages.sorted(chat.id)) {
        if (m.seq <= cursor || m.role !== 'user' || m.uiOnly || direct.has(m.id)) continue;
        routerEvent(chat.id, asEvent(m));
      }
    }
    for (const r of redo.reports) {
      const w = chatWorkers.find((x) => x.id === r.id);
      if (!w?.report) continue;
      const report = w.report;
      routerEvent(chat.id, {
        kind: 'worker',
        id: w.id,
        at: report.at,
        bot: bots.get(w.botId)?.name || 'deleted bot',
        title: w.title,
        status: report.status,
        report: report.text,
        landing: landingText(w),
        resumed: r.resumed,
      });
    }
    for (const w of interrupted.filter((x) => x.chatId === chat.id)) {
      routerEvent(chat.id, { kind: 'worker', id: w.id, at: Date.now(), bot: bots.get(w.botId)?.name || 'deleted bot', title: w.title, status: 'stopped', report: w.report?.text || '' });
    }
    // Routine runs that waited in a Worker's inbox when Crew stopped: the Router takes them now.
    for (const u of undelivered.filter((x) => x.worker.chatId === chat.id)) handBackTrigger(u.worker, u.threadId, u.triggerId, 'Crew restarted before it took this run');
  }
  log.debug(`${routers.size} routers resumed`);
}
