// What the Watchdog sees on each tick: a compact snapshot of Workers, approvals, errors, friction
// and watches, the deterministic flags computed from it (the fast path), and the snapshot rendered
// for the model. Pure: the stores are read by index.ts.
//
// Inline & Spill: every object carries its id; text is cut to its first words, and `inspect <id>`
// reads the rest. Text from Workers, pages, errors, friction and the audit log is in the same
// <untrusted> wrapper as everywhere else in Crew (ADR 007), so it reads as data, never instructions.

import type { AuditEntry } from '../../shared/types';
import { defuse } from '../layers/prompts';
import { firstWords } from '../text';
import { untrustedLine } from '../untrusted';
import { LOOP_REPEATS } from './signals';

export interface WorkerSnap {
  id: string;
  chatId: string;
  chatTitle: string;
  bot: string;
  title: string;
  task: string;
  status: string;
  detail?: string;
  createdAt: number;
  /** When it last did something. */
  lastProgressAt: number;
  turns: number;
  costUsd: number;
  recent: string[];
  repeats: number;
  repeated?: string;
  report?: { status: string; text: string; at: number };
  /** Its last error reads as transient (overloaded, rate limit, network). */
  transient: boolean;
  nudgesToday: number;
  restartsToday: number;
  /** A silent speculative run (ADR 008): the Watchdog may stop it, nothing else (ADR 011). */
  speculative?: boolean;
}

export interface ApprovalSnap {
  id: string;
  chatId: string;
  chatTitle: string;
  who: string;
  title: string;
  askedAt: number;
  /** The Worker it belongs to, when it is a Worker's. */
  workerId?: string;
}

export interface EventSnap {
  at: number;
  chatId?: string;
  chatTitle?: string;
  who?: string;
  text: string;
}

export interface FrictionSnap {
  kind: string;
  label: string;
  count: number;
  keys: string[];
}

export interface WatchSnap {
  id: string;
  subject: string;
  note: string;
  checks: number;
  nextAt: number;
  by: string;
}

/** The audit log (ADR 007) since the last look: the guard's refusals per agent and rule, and drafts whose approved run failed. */
export interface AuditSnap {
  /** The latest entry of the group: `inspect au_…` reads it. */
  id: string;
  event: 'blocked' | 'failed';
  at: number;
  who: string;
  workerId?: string;
  jobId?: string;
  chatId?: string;
  chatTitle?: string;
  /** The guard's rule, or the draft's kind. */
  rule?: string;
  draftId?: string;
  count: number;
  /** The latest command, or what the failed run said. */
  text: string;
}

export interface Snapshot {
  at: number;
  /** The previous tick that looked (or the start of the window). */
  since: number;
  stuckMinutes: number;
  actionsLeft: number;
  workers: WorkerSnap[];
  approvals: ApprovalSnap[];
  turnErrors: EventSnap[];
  friction: FrictionSnap[];
  /** A Router in error, preview console errors. */
  interfaceErrors: (EventSnap & { kind: 'router' | 'console'; id: string })[];
  watches: WatchSnap[];
  /** Empty while the audit log is off (Settings → Safety). */
  audit: AuditSnap[];
  /** Speculative runs today, when any project speculates (ADR 011). */
  speculative?: { running: number; spentTodayUsd: number; dailyBudgetUsd: number };
}

/** An approval waiting this long is stuck. */
export const STUCK_APPROVAL_MS = 10 * 60_000;
/** The guard refusing the same agent this often since the last look: it keeps trying to get around a hard rule. */
export const GUARD_REPEATS = 2;
const ACTIVE = new Set(['starting', 'running', 'waiting']);

/** Who an audit entry's agent is, for grouping and flags: a Worker, a background job, else the bot in its chat. */
const auditKey = (e: AuditEntry) => e.actor.workerId || e.actor.jobId || (e.actor.chatId ? `${e.actor.botId || e.actor.botName || 'agent'}@${e.actor.chatId}` : e.actor.botName || 'agent');

/**
 * The audit entries the Watchdog looks at (the guard's refusals, grouped per agent and rule, and
 * failed runs of approved drafts), newest first. Approvals, discards and successful runs are the
 * user's own decisions: not its business.
 */
export function auditSnaps(entries: AuditEntry[], title: (chatId?: string) => string | undefined, max = 10): AuditSnap[] {
  const out = new Map<string, AuditSnap>();
  for (const e of [...entries].sort((a, b) => b.at - a.at)) {
    if (e.event !== 'blocked' && e.event !== 'failed') continue;
    const key = e.event === 'blocked' ? `blocked\n${auditKey(e)}\n${e.rule || ''}` : `failed\n${e.id}`;
    const seen = out.get(key);
    if (seen) {
      seen.count++;
      continue;
    }
    out.set(key, {
      id: e.id,
      event: e.event,
      at: e.at,
      who: e.actor.botName || (e.actor.user ? 'the user' : 'an agent'),
      workerId: e.actor.workerId,
      jobId: e.actor.jobId,
      chatId: e.actor.chatId,
      chatTitle: title(e.actor.chatId),
      rule: e.event === 'blocked' ? e.rule : e.kind,
      draftId: e.draftId,
      count: 1,
      text: e.command || e.detail || '',
    });
  }
  return [...out.values()].slice(0, max);
}

/** The agent an audit line is about, as a flag's id: its Worker, its job, else its chat. */
const auditSubject = (a: AuditSnap) => a.workerId || a.jobId || a.chatId || a.id;

/** The deterministic flags of one Worker. */
export function workerFlags(w: WorkerSnap, s: Pick<Snapshot, 'at' | 'since' | 'stuckMinutes'>): string[] {
  const flags: string[] = [];
  const active = ACTIVE.has(w.status);
  // Waiting for the user is not the Worker's lack of progress; the approval is flagged instead.
  if (active && w.status !== 'waiting' && s.at - w.lastProgressAt >= s.stuckMinutes * 60_000) flags.push('stuck');
  if (active && w.repeats >= LOOP_REPEATS) flags.push('looping');
  // A speculative run that failed is discarded by Crew, quietly: nothing for the Watchdog to restart or tell.
  if (w.status === 'error' && !w.speculative && (w.report?.at ?? 0) >= s.since) flags.push(w.transient ? 'failed-transient' : 'failed');
  return flags;
}

/** Every flag in the snapshot, as "<kind>:<id>". Empty: nothing to look at, so no model call. */
export function snapshotFlags(s: Snapshot): string[] {
  const out: string[] = [];
  for (const w of s.workers) for (const f of workerFlags(w, s)) out.push(`${f}:${w.id}`);
  for (const a of s.approvals) if (s.at - a.askedAt >= STUCK_APPROVAL_MS) out.push(`approval:${a.id}`);
  for (const e of s.turnErrors) out.push(`turn-error:${e.chatId || '?'}`);
  for (const f of s.friction) if (f.kind !== 'turn-error') out.push(`friction:${f.kind}`);
  for (const e of s.interfaceErrors) out.push(`${e.kind}:${e.id}`);
  for (const w of s.watches) if (w.nextAt <= s.at) out.push(`watch:${w.id}`);
  for (const a of s.audit || []) {
    if (a.event === 'blocked' && a.count >= GUARD_REPEATS) out.push(`guard:${auditSubject(a)}`);
    if (a.event === 'failed') out.push(`draft-failed:${a.draftId || a.id}`);
  }
  return [...new Set(out)];
}

/** Nothing at all happens: no Worker exists, nothing failed, nothing is watched. */
export function isQuiet(s: Snapshot): boolean {
  return !s.workers.length && !s.approvals.length && !s.turnErrors.length && !s.friction.length && !s.interfaceErrors.length && !s.watches.length && !s.audit?.length;
}

const attr = (v: string) => v.replace(/["<>\n]/g, ' ').slice(0, 120);
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
};
/** Outside text, cut to its first words, in the <untrusted> wrapper. */
const data = (source: string, text: string, words?: number) => untrustedLine(source, defuseSnap(words ? firstWords(text.trim(), words).text : text.trim()));

/** Defuses the snapshot's own tags inside quoted text. */
export function defuseSnap(s: string): string {
  return defuse(s).replace(/<(\s*\/?\s*)(snapshot|worker|approval|turn_error|friction|interface|watch|limits|audit|speculative)\b/gi, '‹$1$2');
}

export function renderSnapshot(s: Snapshot, opts: { reason: string }): string {
  const now = s.at;
  const out: string[] = [];
  const flags = snapshotFlags(s);
  out.push(`<snapshot at="${new Date(now).toISOString()}" since="${ago(s.since, now)}" why="${attr(opts.reason)}">`);
  out.push(`<limits actions_left="${s.actionsLeft}" />`);
  out.push(`Flags from Crew's rules: ${flags.length ? flags.join(', ') : 'none'}`);
  out.push('');
  if (!s.workers.length) out.push('(No Workers active or ended since the last tick.)');
  for (const w of s.workers) {
    const f = workerFlags(w, s);
    out.push(
      `<worker id="${w.id}" chat="${w.chatId}" chat_title="${attr(w.chatTitle)}" bot="${attr(w.bot)}" status="${w.status}" age="${span(now - w.createdAt)}" last_progress="${ago(w.lastProgressAt, now)}" turns="${w.turns}" cost="$${w.costUsd.toFixed(2)}"${w.speculative ? ' speculative="true"' : ''}${f.length ? ` flags="${f.join(',')}"` : ''} nudges_today="${w.nudgesToday}" restarts_today="${w.restartsToday}">`,
    );
    out.push(`Title: ${defuseSnap(w.title)}`);
    if (w.speculative) out.push('(A silent speculative run: if it is stuck or looping, stop it without a redirect. It takes no notes, is never restarted, and no chat hears of it.)');
    out.push(`Task: ${data('worker task', w.task, 40)}`);
    if (w.detail) out.push(`Now: ${defuseSnap(w.detail)}`);
    if (w.recent.length) out.push(`Latest tool calls: ${data('tool calls', w.recent.join(' · '))}`);
    if (w.repeated && w.repeats > 1) out.push(`Most repeated: ${data('tool calls', w.repeated)} (${w.repeats} of the latest calls)`);
    if (w.report) out.push(`Last report (${w.report.status}, ${ago(w.report.at, now)}): ${w.report.text.trim() ? data('worker report', w.report.text, 40) : '(no text)'}`);
    out.push(`(inspect ${w.id} for the full task, calls and report)`);
    out.push('</worker>');
  }
  if (s.speculative) out.push(`<speculative running="${s.speculative.running}" spent_today="$${s.speculative.spentTodayUsd.toFixed(2)}" daily_budget="$${s.speculative.dailyBudgetUsd.toFixed(2)}" />`);
  for (const a of s.approvals)
    out.push(
      `<approval id="${a.id}" chat="${a.chatId}" chat_title="${attr(a.chatTitle)}" who="${attr(a.who)}"${a.workerId ? ` worker="${a.workerId}"` : ''} waiting="${span(now - a.askedAt)}">${data('approval', a.title)}</approval>`,
    );
  for (const e of s.turnErrors)
    out.push(`<turn_error chat="${e.chatId || ''}" chat_title="${attr(e.chatTitle || '')}" who="${attr(e.who || '')}" when="${ago(e.at, now)}">${data('turn error', e.text, 40)}</turn_error>`);
  for (const f of s.friction) out.push(`<friction kind="${f.kind}" count="${f.count}">${defuseSnap(f.label)}: ${data('friction log', f.keys.join('; '))}</friction>`);
  for (const e of s.interfaceErrors)
    out.push(
      `<interface kind="${e.kind}" id="${e.id}"${e.chatId ? ` chat="${e.chatId}"` : ''} when="${ago(e.at, now)}">${data(e.kind === 'console' ? 'preview console' : 'router error', e.text, 40)}</interface>`,
    );
  for (const w of s.watches)
    out.push(`<watch id="${w.id}" subject="${attr(w.subject)}" by="${w.by}" checks="${w.checks}" ${w.nextAt <= now ? 'due="now"' : `next="in ${span(w.nextAt - now)}"`}>${defuseSnap(w.note)}</watch>`);
  for (const a of s.audit || []) {
    const who = `who="${attr(a.who)}"${a.workerId ? ` worker="${a.workerId}"` : ''}${a.jobId ? ` job="${a.jobId}"` : ''}${a.chatId ? ` chat="${a.chatId}" chat_title="${attr(a.chatTitle || '')}"` : ''}`;
    const what = a.event === 'blocked' ? `rule="${attr(a.rule || '')}" count="${a.count}"` : `kind="${attr(a.rule || '')}"${a.draftId ? ` draft="${a.draftId}"` : ''}`;
    out.push(`<audit id="${a.id}" event="${a.event}" ${who} ${what} when="${ago(a.at, now)}">${data(a.event === 'blocked' ? 'refused command' : 'draft run', a.text, 40)}</audit>`);
  }
  out.push('</snapshot>');
  return out.join('\n');
}
