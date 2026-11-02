// The Trigger bus: one stream of the events Crew reacts to. The paths that already handle them
// (user messages, routine runs, turn results, outside edits, the preview console) each publish a
// Trigger as their event happens. A Trigger joins a Thread of related ones, goes through the fast
// path (rules in code) and, if it is a candidate, the slow path (a cheap model applying the user's
// policies), and is kept in a bounded log and shown live in the Triggers view. See
// docs/adr/001-triggers.md.
//
// Behind settings.superAgent.enabled: when it is off, publishTrigger returns at once and nothing
// is recorded. In this milestone "act" on a non-explicit event means a short UI-only notice for the
// user; explicit requests are acted on by the chat exactly as before.

import fs from 'node:fs';
import type { Chat, ConsoleEntry, FilteredSource, Project, Routine, SuperAgentSettings, Thread, Trigger, TriggerDetail, TriggerList, TriggerRef, TriggerSource } from '../../shared/types';
import { bus, notify } from '../bus';
import { DATA, FAKE_AGENT } from '../config';
import { routerEvent, routerMode } from '../layers';
import { logger } from '../log';
import { systemMessage } from '../orchestrator/chatLog';
import { chatProjectId } from '../projects';
import { chats, messages, projects, routines, settings, TRIGGER_LIMITS, threads, triggerLog, triggerPayloadFile, uid } from '../store';
import { type FastInput, FILTERED_SOURCES, fastPath, fingerprintOf, reachedSlowPath } from './fastPath';
import { type Decided, fakeDecide, modelDecide, type SlowItem, SlowQueue } from './slowPath';

const log = logger('triggers');

const HOUR = 3600_000;
const DETAIL_MAX = 20_000;
/** Words a notice may use: chat is a low-interruption channel. */
const NOTICE_WORDS = 100;

export interface ThreadSpec {
  key: string;
  kind: Thread['kind'];
  title: string;
  projectId?: string | null;
  chatId?: string | null;
}

export interface TriggerInput {
  source: TriggerSource;
  summary: string;
  thread: ThreadSpec;
  ref: TriggerRef;
  /** Kept beside the log when ref.kind is 'payload'. */
  payload?: unknown;
  chatId?: string | null;
  projectId?: string | null;
  explicit?: boolean;
  /** What allow-lists match and duplicates are judged by: file paths, error lines. */
  subjects?: string[];
  facts?: FastInput['facts'];
  related?: string[];
  action?: string;
}

export const chatThread = (chat: Chat): ThreadSpec => ({ key: `chat:${chat.id}`, kind: 'chat', title: chat.title, chatId: chat.id, projectId: chatProjectId(chat) });

export const routineThread = (r: Routine, chat: Chat | undefined): ThreadSpec => ({
  key: `routine:${r.id}`,
  kind: 'routine',
  title: `Routine: ${r.name}`,
  chatId: chat?.id ?? null,
  projectId: chatProjectId(chat),
});

export const workspaceThread = (p: Project): ThreadSpec => ({ key: `workspace:${p.id}`, kind: 'workspace', title: p.workspace ? `Workspace: ${p.name}` : p.name, projectId: p.id });

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function superAgentOn(): boolean {
  return settings.get().superAgent.enabled;
}

const isFiltered = (s: TriggerSource): s is FilteredSource => (FILTERED_SOURCES as TriggerSource[]).includes(s);

/**
 * Records an event and runs it through the filter. Returns null when the feature is off or the
 * source is set to be ignored. Never throws: a failure here must not break the path publishing.
 */
export function publishTrigger(input: TriggerInput): Trigger | null {
  const sa = settings.get().superAgent;
  if (!sa.enabled) return null;
  if (isFiltered(input.source) && sa.sources[input.source].mode === 'ignore') return null;
  try {
    return publish(input, sa);
  } catch (e) {
    log.warn('could not publish a trigger:', e);
    return null;
  }
}

function publish(input: TriggerInput, sa: SuperAgentSettings): Trigger {
  const now = Date.now();
  const thread = openThread(input.thread, now);
  const subjects = input.subjects ?? [];
  // A turn result points back at the request that started the chain.
  const related = input.related ?? (input.source === 'turn' ? latestRequest(thread) : []);
  const t: Trigger = {
    id: uid('tg_'),
    at: now,
    source: input.source,
    threadId: thread.id,
    projectId: input.projectId ?? null,
    chatId: input.chatId ?? null,
    summary: oneLine(input.summary, 200),
    ref: input.ref,
    related,
    explicit: !!input.explicit,
    fingerprint: fingerprintOf(input.source, subjects.length ? subjects : [input.summary]),
    filter: { verdict: 'drop', stage: 'fast', rule: '', reason: '' },
    action: input.action,
  };
  t.filter = fastPath(
    { source: t.source, explicit: t.explicit, rootProjectId: rootProject(t.projectId), subjects, fingerprint: t.fingerprint, facts: input.facts ?? {} },
    { settings: sa, thread, recent: triggerLog.recent(50, (r) => r.threadId === thread.id), candidatesLastHour: candidatesSince(now - HOUR), now },
  );
  if (t.ref.kind === 'payload') {
    fs.mkdirSync(DATA.triggerPayloads, { recursive: true });
    fs.writeFileSync(triggerPayloadFile(t.id), JSON.stringify(input.payload ?? null));
  }
  const isNew = !threads.has(thread.id);
  thread.lastAt = now;
  thread.count++;
  thread.lastTriggerId = t.id;
  threads.set(thread);
  // The log line is written at once: so is a new thread it points at (counts can catch up later).
  if (isNew) threads.flush();
  save(t);
  if (t.filter.verdict === 'candidate') slow.push(slowItem(t, thread));
  return t;
}

function save(t: Trigger) {
  triggerLog.append(t);
  const thread = threads.get(t.threadId);
  if (thread) bus.emit({ t: 'trigger', trigger: t, thread });
}

/** The open thread with this key, or a new one (stored by the caller with its first trigger). */
function openThread(spec: ThreadSpec, now: number): Thread {
  const open = threads.all().find((th) => th.key === spec.key && !th.closedAt);
  if (open) {
    if (spec.title) open.title = spec.title;
    return open;
  }
  return { id: uid('th_'), key: spec.key, kind: spec.kind, title: spec.title, projectId: spec.projectId ?? null, chatId: spec.chatId ?? null, createdAt: now, lastAt: now, count: 0 };
}

/** Closes a thread (a chat's new topic, a deleted chat): its next trigger starts a new one. */
export function closeThread(key: string) {
  const open = threads.all().find((th) => th.key === key && !th.closedAt);
  if (!open) return;
  open.closedAt = Date.now();
  threads.set(open);
  threads.flush();
}

function latestRequest(thread: Thread): string[] {
  const req = triggerLog.recent(1, (r) => r.threadId === thread.id && (r.source === 'user' || r.source === 'routine'))[0];
  return req ? [req.id] : [];
}

function rootProject(projectId: string | null): string | null {
  const p = projects.get(projectId);
  return p?.workspace?.parentId ?? p?.id ?? projectId;
}

function candidatesSince(since: number): number {
  return triggerLog.recent(Number.MAX_SAFE_INTEGER, (r) => r.at >= since && reachedSlowPath(r)).length;
}

// ---------------------------------------------------------------- payloads ("read more")

function readPayload(id: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(triggerPayloadFile(id), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The trigger's full content as text: what "read more" shows and what the slow path excerpts. */
export function detailText(t: Trigger): string {
  const ref = t.ref;
  if (ref.kind === 'payload') {
    const p = readPayload(t.id) as { text?: string; page?: string; entries?: ConsoleEntry[] } | undefined;
    if (p === undefined) return '(The payload is no longer stored.)';
    if (Array.isArray(p?.entries)) return [`Page ${p.page || '/'}`, ...p.entries.map((e) => `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ''}`)].join('\n');
    if (typeof p?.text === 'string') return p.text;
    return JSON.stringify(p, null, 1);
  }
  const m = messages.get(ref.chatId, ref.messageId);
  const head = ref.kind === 'routine' ? `Routine: ${routines.get(ref.routineId)?.name ?? '(deleted)'}\n` : '';
  if (!m) return `${head}(The message no longer exists.)`;
  if (m.role === 'bot') return [head + `Status: ${m.status}`, m.error ? `Error: ${m.error}` : '', m.text].filter(Boolean).join('\n');
  const attached = m.attachments?.length ? `\n[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]` : '';
  return head + (m.prompt || m.text) + attached;
}

function slowItem(t: Trigger, thread: Thread): SlowItem {
  return { trigger: t, threadTitle: thread.title, detail: detailText(t), previous: triggerLog.recent(3, (r) => r.threadId === thread.id && r.id !== t.id).slice(0, 2) };
}

// ---------------------------------------------------------------- slow path and acting

const slow = new SlowQueue(
  () => (FAKE_AGENT ? fakeDecide : modelDecide),
  () => settings.get().superAgent.policies,
  decided,
);

function decided(trigger: Trigger, d: Decided) {
  // The trigger may have been pruned meanwhile; its latest snapshot is the one to update.
  const t = triggerLog.get(trigger.id);
  if (!t) return;
  const act = !!d.verdict?.act;
  t.filter = {
    verdict: act ? 'act' : 'drop',
    stage: 'slow',
    rule: d.verdict ? 'policy' : 'invalid',
    reason: d.verdict ? d.verdict.reason || (act ? 'A policy says to act' : 'No policy says to act') : `No usable decision (${d.invalid}); staying quiet`,
    slow: { backend: d.backend, costUsd: d.costUsd, batch: d.batch, decidedAt: d.at, invalid: d.invalid },
  };
  // Switched off while the model was deciding: the decision is kept, nobody is told.
  if (act && superAgentOn()) deliver(t);
  save(t);
}

/** Words for a notice: what Crew noticed, by source. */
const NOTICED: Record<TriggerSource, string> = {
  user: 'a message',
  routine: 'a routine run',
  turn: 'a failed turn',
  'outside-edit': 'an outside edit',
  'preview-console': 'a preview console error',
  job: 'a background job result',
};

export function noticeText(t: Trigger): string {
  const words = `Crew noticed ${NOTICED[t.source]}: ${t.summary} ${t.filter.reason}`.split(/\s+/).filter(Boolean);
  const body = words.length > NOTICE_WORDS ? `${words.slice(0, NOTICE_WORDS).join(' ')}…` : words.join(' ');
  return `${body} (${t.id} in Triggers)`;
}

/** The chat to tell: the trigger's own, else the most recently active chat working in its project. */
function targetChat(t: Trigger): Chat | undefined {
  const own = chats.get(t.chatId);
  if (own) return own;
  if (!t.projectId) return undefined;
  return chats
    .all()
    .filter((c) => chatProjectId(c) === t.projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/**
 * Acting: a short note only the user sees, and a toast; bots never read it. A chat in two-layer
 * mode gets it in its Router's inbox instead, as an environment event that cannot start work.
 */
function deliver(t: Trigger) {
  const chat = targetChat(t);
  if (!chat) {
    t.action = 'Nobody to tell: no chat works in this project';
    return;
  }
  if (routerMode(chat)) {
    routerEvent(chat.id, { kind: 'environment', id: t.id, at: t.at, source: t.source, summary: t.summary, reason: t.filter.reason });
    t.action = `Handed to the Router of "${chat.title}"`;
    const thread = threads.get(t.threadId);
    if (thread) {
      thread.lastNoticeAt = Date.now();
      threads.set(thread);
    }
    return;
  }
  const msg = systemMessage(chat, noticeText(t), { uiOnly: true, notice: 'trigger' });
  t.filter.delivered = { chatId: chat.id, messageId: msg.id };
  t.action = `Notice posted in "${chat.title}"`;
  const thread = threads.get(t.threadId);
  if (thread) {
    thread.lastNoticeAt = Date.now();
    threads.set(thread);
  }
  notify('Crew noticed something', t.summary.slice(0, 140), { chatId: chat.id, level: 'info' });
}

// ---------------------------------------------------------------- sources without a home path

/** Console output the preview reported (BrowserTab forwards errors while the feature is on). */
export function publishConsole(input: { project: Project; chatId?: string | null; page: string; entries: ConsoleEntry[] }): Trigger | null {
  const entries = input.entries.slice(-20).map((e) => ({ level: e.level, text: String(e.text).slice(0, 500), ts: e.ts, source: e.source?.slice(0, 300) }));
  const errors = entries.filter((e) => e.level === 'error');
  const page = input.page || '/';
  const chat = chats.get(input.chatId);
  return publishTrigger({
    source: 'preview-console',
    summary: errors.length ? `${errors.length} console error${errors.length === 1 ? '' : 's'} on ${page}: ${errors[0].text}` : `Console output on ${page}`,
    thread: workspaceThread(input.project),
    ref: { kind: 'payload' },
    payload: { page, entries },
    projectId: input.project.id,
    chatId: chat?.id ?? null,
    subjects: errors.map((e) => e.text),
    facts: { errors: errors.length },
  });
}

// ---------------------------------------------------------------- reading

export function listTriggers(q: { source?: string; verdict?: string; threadId?: string; limit?: number; before?: number } = {}): TriggerList {
  const limit = Math.max(1, Math.min(500, Math.round(q.limit || 200)));
  const list = triggerLog.recent(
    limit,
    (t) => (!q.source || t.source === q.source) && (!q.verdict || t.filter.verdict === q.verdict) && (!q.threadId || t.threadId === q.threadId) && (!q.before || t.at < q.before),
  );
  const byId: Record<string, Thread> = {};
  for (const t of list) {
    const th = threads.get(t.threadId);
    if (th) byId[th.id] = th;
  }
  const all = triggerLog.all();
  const judged = all.filter((t) => t.filter.slow);
  return {
    enabled: superAgentOn(),
    triggers: list,
    threads: byId,
    stats: {
      total: all.length,
      act: all.filter((t) => t.filter.verdict === 'act').length,
      drop: all.filter((t) => t.filter.verdict === 'drop').length,
      candidate: all.filter((t) => t.filter.verdict === 'candidate').length,
      // One model call decides its whole batch at one time.
      slowCalls: new Set(judged.map((t) => t.filter.slow!.decidedAt)).size,
      slowCostUsd: judged.reduce((s, t) => s + (t.filter.slow?.costUsd || 0), 0),
    },
  };
}

export function triggerDetail(id: string): TriggerDetail | null {
  const t = triggerLog.get(id);
  if (!t) return null;
  const detail = detailText(t);
  return {
    trigger: t,
    thread: threads.get(t.threadId) ?? null,
    detail: detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}\n…` : detail,
    related: t.related.map((r) => triggerLog.get(r)).filter((x): x is Trigger => !!x),
    recent: triggerLog.recent(10, (r) => r.threadId === t.threadId),
  };
}

// ---------------------------------------------------------------- retention

/** Drops triggers past the limits, and threads none of the remaining triggers belong to. */
export function pruneTriggers(now = Date.now()) {
  triggerLog.prune(now);
  const live = new Set(triggerLog.all().map((t) => t.threadId));
  for (const th of threads.all()) if (!live.has(th.id) && th.lastAt < now - 60_000) threads.delete(th.id);
}

/**
 * On start: prune; settle candidates a restart cut off from their decision; and bring the threads'
 * counts up to the log (thread updates are saved with a delay, the log at once).
 */
export function startTriggers() {
  pruneTriggers();
  const counts = new Map<string, { count: number; lastAt: number; lastTriggerId: string }>();
  for (const t of triggerLog.all()) {
    counts.set(t.threadId, { count: (counts.get(t.threadId)?.count ?? 0) + 1, lastAt: t.at, lastTriggerId: t.id });
    if (t.filter.verdict !== 'candidate') continue;
    t.filter = { verdict: 'drop', stage: 'slow', rule: 'interrupted', reason: 'Crew restarted before the model decided' };
    triggerLog.append(t);
  }
  for (const th of threads.all()) {
    const c = counts.get(th.id);
    if (c && (c.count !== th.count || c.lastAt !== th.lastAt)) threads.set({ ...th, ...c });
  }
  setInterval(() => pruneTriggers(), HOUR).unref();
  log.debug(`${triggerLog.size} triggers kept (at most ${TRIGGER_LIMITS.max}, ${TRIGGER_LIMITS.maxAgeMs / 86_400_000} days)`);
}
