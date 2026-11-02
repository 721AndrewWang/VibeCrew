// The chain of recall (ADR 005): every object Crew injects has an id, and recall resolves an id to
// the object with its neighbours and the ids of the next hops, so the model walks the graph
// (Trigger -> Thread -> Worker -> another Thread) one call at a time. Resolution happens inside a
// scope: the caller's chat and its project; a blind reviewer sees only the user's messages.

import type { Chat, ChatMessage, RecallLink, RecallNode, Thread, Trigger, Worker } from '../../shared/types';
import { answered, renderUserMessage } from '../agents/prompts';
import { contextLines } from '../orchestrator/turnContext';
import { chatProjectId } from '../projects';
import { bots, chats, messages, projects, threads, triggerLog, workers } from '../store';
import { detailText } from '../triggers';
import { MAX_LINKS } from './spill';

export interface RecallScope {
  chatId: string;
  /** A blind reviewer: the user's messages and outside-edit notes only. */
  blind?: boolean;
}

export type Resolved = { node: RecallNode } | { error: string };

/** Resolves ids with a prefix: how later milestones add kinds (background jobs). */
export type RecallResolver = (id: string, scope: RecallScope) => Resolved | null;

const extra = new Map<string, RecallResolver>();

export function registerRecall(prefix: string, resolver: RecallResolver) {
  extra.set(prefix, resolver);
}

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};

const fail = (error: string): Resolved => ({ error });

/** A project's root: a workspace (a chat's or a Worker's) counts as the project it came from. */
function rootOf(projectId: string | null | undefined): string | null {
  let p = projects.get(projectId);
  for (let i = 0; p?.workspace && i < 4; i++) {
    const parent = projects.get(p.workspace.parentId);
    if (!parent) break;
    p = parent;
  }
  return p?.id ?? projectId ?? null;
}

// ---------------------------------------------------------------- messages

/** What a message shows the caller: never UI-only notes or a turn still streaming. */
function visible(m: ChatMessage, scope: RecallScope): boolean {
  if (m.uiOnly || m.status === 'streaming') return false;
  return !scope.blind || m.role === 'user' || m.notice === 'outside-edit';
}

export const whoOf = (m: ChatMessage) => (m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : `@${bots.get(m.botId || '')?.name || 'teammate'}`);

const messageText = (m: ChatMessage) => (m.role === 'user' ? renderUserMessage(m) : (m.prompt || m.text).trim());

function messageLink(m: ChatMessage, rel: string): RecallLink {
  return { id: `#${m.seq}`, rel, summary: `${whoOf(m)}: ${messageText(m) || '(no text)'}` };
}

function triggersOf(messageId: string): Trigger[] {
  return triggerLog.recent(4, (t) => t.ref.kind !== 'payload' && t.ref.messageId === messageId);
}

function triggerLink(t: Trigger, rel: string): RecallLink {
  return { id: t.id, rel, summary: `${t.source}, ${ago(t.at)}: ${t.summary}` };
}

function workerLink(w: Worker, rel = 'worker'): RecallLink {
  return { id: w.id, rel, summary: `${bots.get(w.botId)?.name || 'deleted bot'}, ${w.status}: ${w.title}` };
}

function threadLink(th: Thread, rel = 'thread'): RecallLink {
  return { id: th.id, rel, summary: `${th.title} (${th.count} trigger${th.count === 1 ? '' : 's'}${th.closedAt ? ', closed' : ''})` };
}

function messageNode(m: ChatMessage, chat: Chat, scope: RecallScope): RecallNode {
  const list = messages.sorted(chat.id).filter((x) => visible(x, scope));
  const i = list.findIndex((x) => x.id === m.id);
  const around: RecallLink[] = [];
  if (i > 0) around.push(messageLink(list[i - 1], 'previous'));
  if (i >= 0 && i < list.length - 1) around.push(messageLink(list[i + 1], 'next'));
  const answers = scope.blind ? undefined : answered(m, list);
  if (answers && answers.seq !== list[i - 1]?.seq) around.push(messageLink(answers, 'answers'));
  const links: RecallLink[] = [];
  if (!scope.blind) {
    for (const t of triggersOf(m.id)) {
      links.push(triggerLink(t, 'trigger'));
      const th = threads.get(t.threadId);
      if (th && !links.some((l) => l.id === th.id)) links.push(threadLink(th));
    }
    for (const w of workers.all().filter((x) => x.chatId === chat.id && x.related.includes(m.id))) links.push(workerLink(w, 'led to'));
  }
  const attrs: [string, string][] = [['when', ago(m.ts)]];
  if (m.status && m.status !== 'done') attrs.push(['status', m.status]);
  if (m.error) attrs.push(['error', m.error]);
  if (m.changes?.files.length) attrs.push(['changed', m.changes.files.slice(0, 5).join(', ') + (m.changes.files.length > 5 ? ` (+${m.changes.files.length - 5})` : '')]);
  return { id: `#${m.seq}`, kind: 'message', title: `${whoOf(m)} · #${m.seq}`, attrs, body: messageText(m) || '(no text)', around, links };
}

function chatNode(chat: Chat, scope: RecallScope): RecallNode {
  const list = messages.sorted(chat.id).filter((x) => visible(x, scope));
  const links: RecallLink[] = list
    .slice(-MAX_LINKS)
    .reverse()
    .map((m) => messageLink(m, 'message'));
  if (!scope.blind) {
    const th = threads.all().find((x) => x.key === `chat:${chat.id}` && !x.closedAt);
    if (th) links.push(threadLink(th));
    for (const w of workers.all().filter((x) => x.chatId === chat.id && !x.dismissedAt)) links.push(workerLink(w));
  }
  const members = bots
    .all()
    .filter((b) => chat.botIds.includes(b.id))
    .map((b) => b.name);
  return {
    id: 'chat',
    kind: 'chat',
    title: chat.title,
    attrs: [
      ['kind', chat.kind === 'group' ? 'group chat' : 'direct chat'],
      ['members', members.join(', ')],
      ['messages', String(list.length)],
    ],
    body: '',
    around: [],
    links,
  };
}

// ---------------------------------------------------------------- triggers, threads, workers

function triggerInScope(t: { chatId: string | null; projectId: string | null }, chat: Chat): boolean {
  if (t.chatId === chat.id) return true;
  const root = rootOf(chatProjectId(chat));
  return !!root && rootOf(t.projectId) === root;
}

/** One line about any id in scope, for links: unknown or out-of-scope ids are left out. */
function linkFor(id: string, rel: string, chat: Chat): RecallLink | null {
  if (id.startsWith('tg_')) {
    const t = triggerLog.get(id);
    return t && triggerInScope(t, chat) ? triggerLink(t, rel) : null;
  }
  if (id.startsWith('wk_')) {
    const w = workers.get(id);
    return w && w.chatId === chat.id ? workerLink(w, rel) : null;
  }
  const m = messages.get(chat.id, id);
  return m && !m.uiOnly ? messageLink(m, rel) : null;
}

function triggerNode(t: Trigger, chat: Chat): RecallNode {
  const links: RecallLink[] = [];
  const th = threads.get(t.threadId);
  if (th) links.push(threadLink(th));
  if (t.ref.kind !== 'payload' && t.ref.chatId === chat.id) {
    const m = messages.get(chat.id, t.ref.messageId);
    if (m) links.push(messageLink(m, 'records'));
  }
  for (const r of t.related) {
    const l = linkFor(r, 'related', chat);
    if (l) links.push(l);
  }
  const prev = triggerLog.recent(1, (x) => x.threadId === t.threadId && x.at < t.at)[0];
  if (prev) links.push(triggerLink(prev, 'previous'));
  for (const w of workers.all().filter((x) => x.chatId === chat.id && x.related.includes(t.id))) links.push(workerLink(w, 'led to'));
  const f = t.filter;
  // Delivered straight to subscribed Workers (ADR 003), without a Router decision.
  for (const id of f.direct || []) {
    const w = workers.get(id);
    if (w && w.chatId === chat.id && !links.some((l) => l.id === w.id)) links.push(workerLink(w, 'delivered to'));
  }
  const attrs: [string, string][] = [
    ['source', t.source],
    ['when', ago(t.at)],
    ['verdict', `${f.verdict} (${f.stage}: ${f.rule})`],
  ];
  if (f.reason) attrs.push(['why', f.reason]);
  if (t.action) attrs.push(['action', t.action]);
  if (f.handedBack) attrs.push(['handed back', `by ${f.handedBack.by}, ${ago(f.handedBack.at)}`]);
  return { id: t.id, kind: 'trigger', title: t.summary, attrs, body: detailText(t), untrusted: !t.explicit, around: [], links };
}

/**
 * Workers on a thread: a chat thread's are the chat's; a workspace thread's, the Worker whose
 * worktree it is; and on any thread, the Workers that subscribe to it (ADR 003).
 */
function threadWorkers(th: Thread, chat: Chat): RecallLink[] {
  const own = workers.all().filter((w) => w.chatId === chat.id && !w.dismissedAt);
  const on = th.kind === 'chat' ? (th.chatId === chat.id ? own : []) : th.kind === 'workspace' ? own.filter((w) => w.projectId && w.projectId === th.projectId) : [];
  const links = on.map((w) => workerLink(w));
  for (const w of own) if (w.threads?.includes(th.id) && !on.includes(w)) links.push(workerLink(w, 'subscriber'));
  return links;
}

function threadNode(th: Thread, chat: Chat): RecallNode {
  const recent = triggerLog.recent(MAX_LINKS - 1, (t) => t.threadId === th.id);
  const links: RecallLink[] = recent.map((t) => triggerLink(t, 'trigger'));
  if (th.chatId === chat.id) links.push({ id: 'chat', rel: 'chat', summary: chat.title });
  links.push(...threadWorkers(th, chat));
  const attrs: [string, string][] = [
    ['kind', th.kind],
    ['triggers', String(th.count)],
    ['started', ago(th.createdAt)],
    ['last', ago(th.lastAt)],
  ];
  if (th.closedAt) attrs.push(['closed', ago(th.closedAt)]);
  return { id: th.id, kind: 'thread', title: th.title, attrs, body: '', around: [], links };
}

function workerNode(w: Worker, chat: Chat): RecallNode {
  const links: RecallLink[] = [];
  const chatThread = threads.all().find((x) => x.key === `chat:${chat.id}` && !x.closedAt);
  if (chatThread) links.push(threadLink(chatThread, 'chat thread'));
  for (const r of w.related) {
    const l = linkFor(r, 'dispatched by', chat);
    if (l) links.push(l);
  }
  const own = w.projectId ? threads.all().find((x) => x.key === `workspace:${w.projectId}` && !x.closedAt) : undefined;
  if (own) links.push(threadLink(own, 'workspace thread'));
  // The threads whose events come straight to it (ADR 003).
  for (const id of w.threads || []) {
    const th = threads.get(id);
    if (th && !links.some((l) => l.id === th.id)) links.push(threadLink(th, 'subscribes'));
  }
  const ws = projects.get(w.projectId)?.workspace;
  const attrs: [string, string][] = [
    ['member', bots.get(w.botId)?.name || 'deleted bot'],
    ['status', w.status + (w.detail ? ` (${w.detail})` : '')],
    ['started', ago(w.createdAt)],
    ['turns', String(w.turns)],
    ['workspace', ws ? `branch ${ws.branch}, merged into ${ws.baseBranch}` : w.shared || "the chat's folder"],
  ];
  if (w.landing) attrs.push(['landing', w.landing.error || (w.landing.conflicts?.length ? `conflicts in ${w.landing.conflicts.join(', ')}` : `${w.landing.files.length} files merged`)]);
  const report = w.report ? `\n\nLast report (${w.report.status}, ${ago(w.report.at)}):\n${w.report.text || '(no text)'}` : '\n\nNo report yet.';
  return { id: w.id, kind: 'worker', title: w.title, attrs, body: `Task: ${w.task}${report}`, around: [], links };
}

function envNode(chat: Chat): RecallNode {
  const lines = contextLines(projects.get(chatProjectId(chat)) ?? null);
  return { id: 'env', kind: 'env', title: 'The environment, as a new session gets it', attrs: [], body: lines.join('\n'), around: [], links: [] };
}

// ---------------------------------------------------------------- resolving

/** The object an id names, as the caller in this scope may see it. */
export function resolve(rawId: string, scope: RecallScope): Resolved {
  const id = rawId.trim().replace(/^recall\s+id=/, '');
  const chat = chats.get(scope.chatId);
  if (!chat) return fail('This conversation no longer exists.');
  if (id === 'chat') return { node: chatNode(chat, scope) };
  const seq = /^#?(\d+)$/.exec(id);
  if (seq || id.startsWith('m_')) {
    const m = seq ? messages.sorted(chat.id).find((x) => x.seq === Number(seq[1])) : messages.get(chat.id, id);
    if (!m || !visible(m, scope)) return fail(`No message ${id} in this conversation${scope.blind ? ' that you may read' : ''}.`);
    return { node: messageNode(m, chat, scope) };
  }
  if (id === 'env') return { node: envNode(chat) };
  if (scope.blind) return fail("A blind reviewer only recalls the user's messages (#number, or chat for the latest).");
  if (id.startsWith('tg_')) {
    const t = triggerLog.get(id);
    if (!t || !triggerInScope(t, chat)) return fail(`No trigger ${id} in this conversation's project (it may have aged out of the log).`);
    return { node: triggerNode(t, chat) };
  }
  if (id.startsWith('th_')) {
    const th = threads.get(id);
    if (!th || !triggerInScope(th, chat)) return fail(`No thread ${id} in this conversation's project.`);
    return { node: threadNode(th, chat) };
  }
  if (id.startsWith('wk_')) {
    const w = workers.get(id);
    if (!w || w.chatId !== chat.id) return fail(`No Worker ${id} in this chat.`);
    return { node: workerNode(w, chat) };
  }
  for (const [prefix, r] of extra) {
    if (!id.startsWith(prefix)) continue;
    const got = r(id, scope);
    if (got) return got;
  }
  return fail(`Unknown id "${id}". Ids look like #12 (a message here), chat, env, tg_… (a trigger), th_… (a thread) or wk_… (a Worker).`);
}
