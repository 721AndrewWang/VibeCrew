// The Watchdog's state in the chain of recall (ADR 005 × 006, see ADR 010). The Watchdog acts on a
// chat from outside it: a notice reaches a Router as an environment event whose id is the action's
// (wa_…), a nudge reaches a Worker with the action's id, and a watch keeps re-checking a failed
// Worker. These resolvers let an agent in that chat walk from what it was told to why: the action,
// the tick that took it (with the flags Crew's rules raised), the watch, and the Watchdog itself.
//
// Scope: only what concerns the caller's chat (the chat itself, or one of its Workers). The rest of
// the ledger, other chats' flags and the maintainer's proposals stay out of it.

import type { Chat, RecallLink, RecallNode, WatchdogAction, WatchdogActionKind, WatchdogInfo, WatchdogTick, WatchdogWatch } from '../../shared/types';
import { linkFor, type Resolved, registerRecall } from '../recall/graph';
import { chats, watchdogActions, watchdogTicks, watchdogWatches, workers } from '../store';
import { agoLong as ago } from '../time';

const DONE: Record<WatchdogActionKind, string> = {
  nudge: 'nudged',
  stop: 'stopped',
  restart: 'restarted',
  notify: 'told',
  watch: 'started watching',
  resolve: 'resolved',
  propose: 'proposed a change to',
};

/** An id that concerns the chat: the chat, one of its Workers, or a watch on one of them. */
export function concerns(id: string | undefined, chat: Chat, depth = 0): boolean {
  if (!id) return false;
  if (id === chat.id) return true;
  if (workers.get(id)?.chatId === chat.id) return true;
  if (id.startsWith('ww_') && depth < 2) return concerns(watchdogWatches.get(id)?.subject, chat, depth + 1);
  return false;
}

const actionInScope = (a: WatchdogAction, chat: Chat) => a.chatId === chat.id || concerns(a.target, chat);
/** The flags of a tick ("stuck:wk_…", "turn-error:<chat>") that concern the chat. */
const flagsFor = (t: WatchdogTick, chat: Chat) => t.flags.filter((f) => concerns(f.slice(f.indexOf(':') + 1), chat));
const actionsOf = (tickId: string, chat: Chat) => watchdogActions.recent(50, (a) => a.tickId === tickId && actionInScope(a, chat)).reverse();
const tickInScope = (t: WatchdogTick, chat: Chat) => flagsFor(t, chat).length > 0 || actionsOf(t.id, chat).length > 0;

const actionLink = (a: WatchdogAction, rel = 'action'): RecallLink => ({ id: a.id, rel, summary: `${DONE[a.kind]} ${a.target}, ${ago(a.at)}${a.refused ? ' (refused)' : ''}: ${a.text}` });
const tickLink = (t: WatchdogTick, rel = 'tick'): RecallLink => ({ id: t.id, rel, summary: `${t.kind} ${t.outcome}, ${ago(t.at)}: ${t.reason}` });
const watchLink = (w: WatchdogWatch, rel = 'watch'): RecallLink => ({ id: w.id, rel, summary: `${w.resolvedAt ? `resolved: ${w.resolution || ''}` : `${w.checks} checks so far`}; ${w.note}` });

/** The target as a link: one of the chat's Workers, the chat itself, or a watch. */
function targetLink(target: string, chat: Chat): RecallLink | null {
  if (target === chat.id) return { id: 'chat', rel: 'target', summary: chat.title };
  if (target.startsWith('ww_')) {
    const w = watchdogWatches.get(target);
    return w && concerns(w.subject, chat) ? watchLink(w, 'target') : null;
  }
  return linkFor(target, 'target', chat);
}

function actionNode(a: WatchdogAction, chat: Chat): RecallNode {
  const links: RecallLink[] = [];
  const tick = watchdogTicks.get(a.tickId);
  if (tick) links.push(tickLink(tick));
  const target = targetLink(a.target, chat);
  if (target) links.push(target);
  for (const w of watchdogWatches.all().filter((x) => x.subject === a.target)) links.push(watchLink(w));
  const attrs: [string, string][] = [
    ['kind', a.kind],
    ['when', ago(a.at)],
  ];
  if (a.refused) attrs.push(['refused', a.refused]);
  // Its words come from what it read (Workers' reports, errors, pages): data, like any environment event.
  return { id: a.id, kind: 'watchdog action', title: `The Watchdog ${DONE[a.kind]} ${a.target}`, attrs, body: a.text, untrusted: true, around: [], links };
}

function tickNode(t: WatchdogTick, chat: Chat): RecallNode {
  const flags = flagsFor(t, chat);
  const others = t.flags.length - flags.length;
  const attrs: [string, string][] = [
    ['kind', t.kind],
    ['outcome', t.outcome],
    ['when', ago(t.at)],
    ['actions', String(t.actions)],
  ];
  const body = [
    `Why: ${t.reason}`,
    flags.length ? `Flags from Crew's rules about this chat: ${flags.join(', ')}` : 'No flag from Crew’s rules was about this chat.',
    others > 0 ? `(${others} other flag${others === 1 ? '' : 's'} concerned other chats.)` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: t.id,
    kind: 'watchdog tick',
    title: `A Watchdog ${t.kind === 'maintainer' ? 'turn a maintainer asked for' : 'tick'}`,
    attrs,
    body,
    around: [],
    links: actionsOf(t.id, chat).map((a) => actionLink(a)),
  };
}

function watchNode(w: WatchdogWatch, chat: Chat): RecallNode {
  const links: RecallLink[] = [];
  const subject = linkFor(w.subject, 'subject', chat);
  if (subject) links.push(subject);
  for (const a of watchdogActions.recent(5, (x) => (x.target === w.subject || x.target === w.id) && !x.refused)) links.push(actionLink(a));
  const attrs: [string, string][] = [
    ['subject', w.subject],
    ['opened by', w.by === 'code' ? "Crew's rules (a transient failure)" : 'the Watchdog'],
    ['opened', ago(w.createdAt)],
    ['checks', String(w.checks)],
    w.resolvedAt
      ? ['resolved', `${ago(w.resolvedAt)}: ${w.resolution || ''}`]
      : ['next check', w.nextAt <= Date.now() ? 'due now' : `in ${Math.max(1, Math.round((w.nextAt - Date.now()) / 60_000))} min`],
  ];
  return { id: w.id, kind: 'watchdog watch', title: `The Watchdog watches ${w.subject}`, attrs, body: w.note, around: [], links };
}

function watchdogNode(info: WatchdogInfo, chat: Chat): RecallNode {
  const links: RecallLink[] = [];
  for (const w of watchdogWatches.all().filter((x) => !x.resolvedAt && concerns(x.subject, chat))) links.push(watchLink(w));
  for (const a of watchdogActions.recent(5, (x) => actionInScope(x, chat))) links.push(actionLink(a));
  const last = watchdogTicks.recent(1, (t) => tickInScope(t, chat))[0];
  if (last) links.push(tickLink(last, 'last tick about this chat'));
  const attrs: [string, string][] = [['state', info.enabled ? info.state + (info.detail ? ` (${info.detail})` : '') : 'off']];
  if (info.enabled && info.nextTickAt) attrs.push(['next tick', `in ${Math.max(0, Math.round((info.nextTickAt - Date.now()) / 60_000))} min`]);
  if (info.enabled) attrs.push(['ticks this hour', String(info.ticksLastHour)], ['actions today', String(info.actionsToday)]);
  const body = info.enabled
    ? "Crew's Watchdog: a supervisor outside the chats that looks for stuck, looping or failed Workers on a timer. It can nudge, stop or restart a Worker and tell a chat; it never adds to a task."
    : 'The Watchdog is off (Settings → Super-agent → Watchdog).';
  return { id: 'watchdog', kind: 'watchdog', title: "Crew's Watchdog", attrs, body, around: [], links };
}

/** Registers the Watchdog's ids with recall; `info` reads its live state. */
export function registerWatchdogRecall(info: () => WatchdogInfo) {
  const inChat = (scope: { chatId: string }, then: (chat: Chat) => Resolved): Resolved => {
    const chat = chats.get(scope.chatId);
    return chat ? then(chat) : { error: 'This conversation no longer exists.' };
  };
  registerRecall('wa_', (id, scope) =>
    inChat(scope, (chat) => {
      const a = watchdogActions.get(id);
      return a && actionInScope(a, chat) ? { node: actionNode(a, chat) } : { error: `No Watchdog action ${id} about this chat (it may have aged out of the ledger).` };
    }),
  );
  registerRecall('wt_', (id, scope) =>
    inChat(scope, (chat) => {
      const t = watchdogTicks.get(id);
      return t && tickInScope(t, chat) ? { node: tickNode(t, chat) } : { error: `No Watchdog tick ${id} about this chat.` };
    }),
  );
  registerRecall('ww_', (id, scope) =>
    inChat(scope, (chat) => {
      const w = watchdogWatches.get(id);
      return w && concerns(w.subject, chat) ? { node: watchNode(w, chat) } : { error: `No Watchdog watch ${id} on this chat's Workers.` };
    }),
  );
  registerRecall('watchdog', (id, scope) => (id === 'watchdog' ? inChat(scope, (chat) => ({ node: watchdogNode(info(), chat) })) : null));
}
