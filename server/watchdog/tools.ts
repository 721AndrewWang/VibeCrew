// The Watchdog's only tools (MCP server `crew_watchdog`): nudge, stop or restart a Worker, tell a
// chat, watch a failure, propose a change, and inspect any id. The gates in gates.ts run here, in
// code, whatever the model wanted; every action, done or refused, goes into the ledger. The same
// handlers drive the demo agent (FakeSession), which calls them without an MCP client.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { WatchdogActionKind, Worker } from '../../shared/types';
import { jobLine, jobSource } from '../jobs/spill';
import { firstWords } from '../layers/prompts';
import { auditLog, bots, chats, jobs, messages, projects, settings, triggerLog, watchdogActions, watchdogProposals, watchdogTicks, watchdogWatches, workers } from '../store';
import { triggerDetail } from '../triggers';
import { untrusted } from '../untrusted';
import { actionRefusal, noteRefusal, notifyRefusal, nudgeRefusal, proposeRefusal, restartRefusal, stopRefusal, watchRefusal } from './gates';
import { restartRecap, watchdogNote } from './prompts';
import { callSignature, nextCheck } from './signals';

/** What the Watchdog's current turn is; tools read it while that turn runs. */
export interface WatchdogTurn {
  tickId: string;
  /** A maintainer asked: proposals are allowed. */
  maintainer: boolean;
  /** Actions taken (or refused) so far in this turn. */
  used: number;
}

/** What the tools do to the rest of Crew; index.ts wires them to the layers, so this file stays testable. */
export interface WatchdogEffects {
  nudge(w: Worker, note: string): void;
  stop(w: Worker, why: string): Promise<boolean>;
  restart(w: Worker, recap: string): void;
  notify(chatId: string, text: string, actionId: string): void;
  record(a: { kind: WatchdogActionKind; target: string; chatId?: string; text: string; refused?: string }): string;
  /** Today's (not refused) actions of a kind on a target. */
  countToday(kind: WatchdogActionKind | WatchdogActionKind[], target: string): number;
  /** Opens a watch; returns its id. */
  watch(subject: string, note: string, minutes: number): string;
  resolveWatch(id: string, why: string): boolean;
  propose(p: { target: 'policies' | 'bot'; botId?: string; botName?: string; before: string; after: string; rationale: string }): string;
}

type Result = { text: string; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const ok = (text: string): Result => ({ text });
const fail = (text: string): Result => ({ text, isError: true });
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

const workerState = (w: Worker | undefined) => (w ? { status: w.status, dismissed: !!w.dismissedAt } : null);

export function watchdogTools(ctx: () => WatchdogTurn | null, fx: WatchdogEffects): Record<string, Handler> {
  /** Runs an action through the per-turn limit, its own gate, and the ledger. */
  const act = async (kind: WatchdogActionKind, target: string, text: string, gate: () => string | null, run: (actionId: string) => Promise<string> | string, chatId?: string): Promise<Result> => {
    const t = ctx();
    if (!t) return fail('No turn is in progress.');
    const max = settings.get().superAgent.watchdog.maxActionsPerTick;
    const refused = actionRefusal({ used: t.used, max }) ?? gate();
    if (refused) {
      fx.record({ kind, target, chatId, text, refused });
      return fail(refused);
    }
    t.used++;
    const id = fx.record({ kind, target, chatId, text });
    return ok(await run(id));
  };
  const worker = (id: unknown) => workers.get(str(id).trim());

  return {
    async nudge_worker(args) {
      const w = worker(args.id);
      const text = str(args.text).trim();
      return act(
        'nudge',
        str(args.id),
        text,
        () => noteRefusal(text) ?? nudgeRefusal(workerState(w), w ? fx.countToday(['nudge', 'stop'], w.id) : 0),
        (actionId) => {
          fx.nudge(w!, watchdogNote(text, actionId));
          return `Queued for ${w!.id}; it reads the note when its current turn ends.`;
        },
        w?.chatId,
      );
    },

    async stop_worker(args) {
      const w = worker(args.id);
      const why = str(args.why).trim() || 'Stopped by the Watchdog';
      const then = str(args.redirect).trim();
      return act(
        'stop',
        str(args.id),
        then ? `${why} Then: ${then}` : why,
        () => stopRefusal(workerState(w)) ?? (then ? (noteRefusal(then) ?? nudgeRefusal(workerState(w), fx.countToday(['nudge', 'stop'], w!.id))) : noteRefusal(why)),
        async (actionId) => {
          await fx.stop(w!, why);
          if (!then) return `Stopping ${w!.id}; the Router is told it was stopped.`;
          fx.nudge(w!, watchdogNote(then, actionId));
          return `Stopping ${w!.id}; it resumes with your note right after.`;
        },
        w?.chatId,
      );
    },

    async restart_worker(args) {
      const w = worker(args.id);
      const note = str(args.note).trim();
      return act(
        'restart',
        str(args.id),
        note,
        () => restartRefusal(workerState(w), w ? fx.countToday('restart', w.id) : 0) ?? (note ? noteRefusal(note) : null),
        (actionId) => {
          const branch = projects.get(w!.projectId)?.workspace?.branch;
          fx.restart(w!, watchdogNote(restartRecap({ status: w!.status, report: w!.report?.text || w!.detail || '', branch, note }), actionId));
          return `Restarting ${w!.id} in a new session from a recap.`;
        },
        w?.chatId,
      );
    },

    async notify(args) {
      const chatId = str(args.chat).trim();
      const text = str(args.text).trim();
      const chat = chats.get(chatId);
      return act(
        'notify',
        chatId,
        text,
        () => noteRefusal(text) ?? notifyRefusal(!!chat, chat ? fx.countToday('notify', chat.id) : 0),
        (actionId) => {
          fx.notify(chatId, text, actionId);
          return `Told "${chat!.title}".`;
        },
        chat?.id,
      );
    },

    async watch(args) {
      const subject = str(args.subject).trim().slice(0, 200);
      const note = str(args.note).trim().slice(0, 500);
      const minutes = Math.max(1, Math.min(120, Math.round(Number(args.minutes) || 10)));
      return act(
        'watch',
        subject,
        note,
        () => (!subject ? 'Name what to watch (a Worker id, or a short key).' : watchRefusal(watchdogWatches.all().filter((x) => !x.resolvedAt).length)),
        () => `Watching ${subject} as ${fx.watch(subject, note, minutes)}; first check ${new Date(nextCheck(Date.now(), minutes, 0)).toLocaleTimeString('en-US')}.`,
      );
    },

    async resolve_watch(args) {
      const id = str(args.id).trim();
      const why = str(args.why).trim() || 'Resolved by the Watchdog';
      const open = watchdogWatches.get(id);
      return act(
        'resolve',
        id,
        why,
        () => (!open ? 'No such watch.' : open.resolvedAt ? 'That watch is already resolved.' : null),
        () => (fx.resolveWatch(id, why) ? `Resolved ${id}.` : `${id} was already resolved.`),
      );
    },

    async propose_change(args) {
      const t = ctx();
      const target = str(args.target) === 'bot' ? 'bot' : 'policies';
      const after = str(args.after).trim();
      const why = str(args.why).trim().slice(0, 1000);
      const bot = target === 'bot' ? bots.all().find((b) => b.name.toLowerCase() === str(args.bot).trim().replace(/^@/, '').toLowerCase()) : undefined;
      const before = target === 'bot' ? (bot?.description ?? '') : settings.get().superAgent.policies;
      return act(
        'propose',
        target === 'bot' ? bot?.id || str(args.bot) : 'policies',
        `${target === 'bot' ? `${bot?.name || str(args.bot)}'s role description` : 'Trigger policies'}: ${why}`,
        () => {
          if (target === 'bot' && !bot) return 'No bot by that name.';
          if (!after) return 'The proposed text is empty.';
          if (after.length > 10_000) return 'The proposed text is too long (at most 10,000 characters).';
          return proposeRefusal({ maintainer: !!t?.maintainer, pending: watchdogProposals.all().filter((p) => p.status === 'pending').length, changed: after !== before.trim() });
        },
        () =>
          `Proposed as ${fx.propose({ target, botId: bot?.id, botName: bot?.name, before, after, rationale: why })}. A maintainer accepts or rejects it on the Watchdog page; nothing changes until then.`,
      );
    },

    async inspect(args) {
      if (!ctx()) return fail('No turn is in progress.');
      const id = str(args.id).trim();
      const w = workers.get(id);
      if (w) {
        const turns = messages.sorted(w.id);
        const last = turns.at(-1);
        const calls = (last?.parts || []).flatMap((p) => (p.type === 'tool' ? [`${callSignature(p)}${p.status === 'error' ? ' (error)' : ''}`] : []));
        return ok(
          [
            `${w.id} · ${bots.get(w.botId)?.name || 'deleted bot'} · ${w.status}${w.detail ? ` (${w.detail})` : ''} · chat ${w.chatId} · started ${ago(w.createdAt)} · ${w.turns} turns · $${w.costUsd.toFixed(3)}`,
            `Title: ${w.title}`,
            `Task: ${untrusted('worker task', w.task.slice(0, 3000))}`,
            `Latest turn: ${last ? `${last.status}, ${calls.length} tool calls` : 'none yet'}`,
            ...(calls.length ? [`Calls, oldest first: ${untrusted('tool calls', calls.slice(-30).join(' · '))}`] : []),
            ...(last?.error ? [`Error: ${untrusted('turn error', last.error.slice(0, 1000))}`] : []),
            ...(last?.text ? [`Its latest text: ${untrusted('worker text', last.text.slice(-2000))}`] : []),
            ...(w.report ? [`Last report (${w.report.status}): ${untrusted('worker report', w.report.text.slice(0, 2000))}`] : []),
            ...(w.pending?.length ? [`Follow-ups waiting: ${w.pending.length}`] : []),
          ].join('\n'),
        );
      }
      if (id.startsWith('tg_')) {
        const d = triggerDetail(id);
        if (!d) return fail('No such trigger (it may have aged out).');
        return ok(
          [
            `${d.trigger.id} · ${d.trigger.source} · ${d.trigger.filter.verdict} (${d.trigger.filter.reason})`,
            `Summary: ${untrusted(d.trigger.source, d.trigger.summary)}`,
            `Content: ${untrusted(d.trigger.source, d.detail.slice(0, 3000))}`,
          ].join('\n'),
        );
      }
      if (id.startsWith('ww_')) {
        const x = watchdogWatches.get(id);
        if (!x) return fail('No such watch.');
        return ok(
          `${x.id} · ${x.subject} · opened by ${x.by} ${ago(x.createdAt)} · ${x.checks} checks · ${x.resolvedAt ? `resolved ${ago(x.resolvedAt)}: ${x.resolution || ''}` : `next check ${x.nextAt <= Date.now() ? 'due now' : `at ${new Date(x.nextAt).toLocaleTimeString('en-US')}`}`}\nNote: ${x.note}`,
        );
      }
      // The lifecycle audit log (ADR 007): a guard refusal or a draft's run.
      if (id.startsWith('au_')) {
        const e = auditLog.get(id);
        if (!e) return fail('No such audit entry (it may have aged out).');
        const who = [e.actor.botName || (e.actor.user ? 'the user' : 'an agent'), e.actor.workerId, e.actor.jobId, e.actor.chatId && `chat ${e.actor.chatId}`].filter(Boolean).join(' · ');
        return ok(
          [
            `${e.id} · ${e.event}${e.rule ? ` (rule ${e.rule})` : ''}${e.kind ? ` (${e.kind})` : ''} · ${ago(e.at)} · ${who}`,
            ...(e.command ? [`Command: ${untrusted('audit log', e.command.slice(0, 2000))}`] : []),
            ...(e.detail ? [`Detail: ${untrusted('audit log', e.detail.slice(0, 2000))}`] : []),
            ...(e.cwd ? [`Folder: ${e.cwd}`] : []),
          ].join('\n'),
        );
      }
      // A background job (ADR 004), named by an audit entry or a trigger.
      if (id.startsWith('job_')) {
        const j = jobs.get(id);
        if (!j) return fail('No such background job (it may have aged out).');
        return ok(
          `${jobLine(j)}\nChat ${j.chatId} · bot ${bots.get(j.botId)?.name || 'deleted bot'}\n${untrusted(jobSource(j), (j.kind === 'command' ? `$ ${j.command || ''}` : `Task: ${j.task || ''}`).slice(0, 2000))}`,
        );
      }
      if (id.startsWith('wt_')) {
        const tick = watchdogTicks.get(id);
        if (!tick) return fail('No such tick.');
        const acts = watchdogActions.recent(20, (a) => a.tickId === id).reverse();
        return ok(
          [`${tick.id} · ${tick.kind} · ${tick.outcome} · ${ago(tick.at)} · ${tick.reason}`, ...acts.map((a) => `${a.kind} ${a.target}: ${a.text}${a.refused ? ` (refused: ${a.refused})` : ''}`)].join(
            '\n',
          ),
        );
      }
      const chat = chats.get(id);
      if (chat) {
        const list = messages
          .sorted(chat.id)
          .filter((m) => !m.uiOnly || m.notice === 'watchdog')
          .slice(-8);
        return ok(
          [
            `Chat "${chat.title}" (${chat.kind}) · ${chat.botIds.length} members`,
            ...list.map(
              (m) =>
                `#${m.seq} ${m.role === 'bot' ? bots.get(m.botId)?.name || 'bot' : m.role} · ${m.status || ''}${m.error ? ` · error: ${m.error.split('\n')[0].slice(0, 160)}` : ''} · ${firstWords(m.text.replace(/\s+/g, ' '), 30).text}`,
            ),
          ].join('\n'),
        );
      }
      const tr = triggerLog.get(id);
      if (tr) return ok(`${tr.id} · ${tr.summary}`);
      return fail('Unknown id. Use ids from the snapshot: wk_…, tg_…, wt_…, ww_…, au_…, job_…, or a chat id.');
    },
  };
}

/** The handlers as Claude Code sees them. */
export function watchdogMcpServer(h: Record<string, Handler>) {
  const wrap = (name: string) => async (args: Record<string, unknown>) => {
    const r = await h[name](args);
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError || undefined };
  };
  return createSdkMcpServer({
    name: 'crew_watchdog',
    version: '1.0.0',
    // Crew's own tools are few and its prompts name them: never deferred behind Claude Code's tool search.
    alwaysLoad: true,
    tools: [
      tool(
        'nudge_worker',
        'Queue a short note for an active Worker (it reads it when its current turn ends): refocus on its task, stop repeating something, or report. Never new work.',
        { id: z.string().describe('The Worker id, wk_…'), text: z.string().describe('The note, at most 100 words') },
        wrap('nudge_worker'),
      ),
      tool(
        'stop_worker',
        "Stop a Worker's current turn. With `redirect`, it resumes at once with that note (a redirect for a Worker looping inside one long turn); without, it stays stopped and its Router is told.",
        {
          id: z.string().describe('The Worker id, wk_…'),
          why: z.string().describe('Why, in a sentence'),
          redirect: z.string().optional().describe('A note to resume with at once, at most 100 words'),
        },
        wrap('stop_worker'),
      ),
      tool(
        'restart_worker',
        'Start a failed or stopped Worker over in a new session, from a recap of its task, its last report and where its work is.',
        { id: z.string().describe('The Worker id, wk_…'), note: z.string().optional().describe('What to do differently, at most 100 words') },
        wrap('restart_worker'),
      ),
      tool(
        'notify',
        'Tell a chat something it must know or decide: its Router gets it as an environment event (it cannot start work from it); a chat without a Router gets a note only the user sees.',
        { chat: z.string().describe('The chat id'), text: z.string().describe('At most 100 words') },
        wrap('notify'),
      ),
      tool(
        'watch',
        'Keep re-checking something (a transient failure) until it is healthy: it appears in the snapshot when due, with growing intervals.',
        {
          subject: z.string().describe('A Worker id, or a short key'),
          note: z.string().describe('What to check for'),
          minutes: z.number().optional().describe('First check after this many minutes (default 10)'),
        },
        wrap('watch'),
      ),
      tool(
        'resolve_watch',
        'Close a watch: the subject is healthy again, or there is nothing more to do.',
        { id: z.string().describe('The watch id, ww_…'), why: z.string().optional() },
        wrap('resolve_watch'),
      ),
      tool(
        'propose_change',
        "Propose new trigger policies (target policies) or a bot's new role description (target bot, with its name), when a maintainer asks. A maintainer accepts or rejects it; nothing changes until then.",
        {
          target: z.enum(['policies', 'bot']),
          bot: z.string().optional().describe('The bot name, for target bot'),
          after: z.string().describe('The complete new text'),
          why: z.string().describe('What it prevents, pointing at what happened'),
        },
        wrap('propose_change'),
      ),
      tool(
        'inspect',
        'Read more about an id from the snapshot: a Worker (wk_…: full task, tool calls, report), a trigger (tg_…), a tick (wt_…), a watch (ww_…), an audit entry (au_…), a background job (job_…), or a chat id. Free.',
        { id: z.string() },
        wrap('inspect'),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
