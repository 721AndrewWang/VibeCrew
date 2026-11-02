// The Router's only tools (MCP server `crew_router`): reply to the user, and dispatch, message,
// stop and list Workers. The gates in gates.ts run here, in code, whatever the model wanted.
// The same handlers drive the demo agent (FakeSession), which calls them without an MCP client.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Bot, ChatMessage } from '../../shared/types';
import { bus, notify } from '../bus';
import { emitChat, preview, setLastMessage } from '../orchestrator/chatLog';
import { bots, chats, messages, projects, settings, uid, workers } from '../store';
import { monthSpend } from '../usage';
import { workspaceOf } from '../workspaces';
import { dispatchRefusal, messageRefusal, replyRefusal } from './gates';
import { firstWords, REPLY_WORDS } from './prompts';
import { subscriptionsOn } from './subscriptions';
import { activeWorkers, chatWorkers, landingText, messageWorker, sharedWorkerActive, startWorker, stopWorker } from './workers';

/** What the Router's current turn is about; tools read it while that turn runs. */
export interface TurnCtx {
  chatId: string;
  lead: Bot;
  /** The batch holds something explicit (the user, a routine, a Worker report), not only environment events. */
  explicit: boolean;
  /** The batch's event ids: messages, triggers, Workers. */
  related: string[];
  /** The user's messages in the batch, which a dispatched Worker gets verbatim. */
  userMessageIds: string[];
  /** The batch's routine threads: a Worker dispatched now subscribes to them (ADR 003). */
  threads: string[];
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

export function routerTools(ctx: () => TurnCtx | null): Record<string, Handler> {
  const turn = () => {
    const c = ctx();
    const chat = c && chats.get(c.chatId);
    return c && chat ? { c, chat } : null;
  };
  const workerOf = (chatId: string, id: unknown) => {
    const w = workers.get(str(id).trim());
    return w && w.chatId === chatId ? w : undefined;
  };

  return {
    async reply(args) {
      const t = turn();
      if (!t) return fail('No turn is in progress.');
      const text = str(args.text).trim();
      const refused = replyRefusal(text);
      if (refused) return fail(refused);
      const { c, chat } = t;
      const msg: ChatMessage = {
        id: uid('m_'),
        chatId: chat.id,
        seq: ++chat.seq,
        ts: Date.now(),
        role: 'bot',
        botId: c.lead.id,
        text,
        parts: [{ type: 'text', text }],
        status: 'done',
        router: true,
        trigger: { type: 'system' },
      };
      messages.put(msg);
      bus.emit({ t: 'msg', msg });
      setLastMessage(chat, msg);
      chat.unread = (chat.unread || 0) + 1;
      emitChat(chat);
      notify(c.lead.name, preview(text).slice(0, 100), { chatId: chat.id, level: 'success' });
      return ok('Sent to the user.');
    },

    async dispatch_worker(args) {
      const t = turn();
      if (!t) return fail('No turn is in progress.');
      const { c, chat } = t;
      const task = str(args.task).trim();
      const title = str(args.title).trim() || firstWords(task, 8).text;
      if (!task) return fail('The task is empty: write what the Worker should do and what counts as done.');
      const asked = str(args.bot).trim().replace(/^@/, '');
      const members = bots.all().filter((b) => chat.botIds.includes(b.id));
      const member = asked ? (members.find((b) => b.name.toLowerCase() === asked.toLowerCase()) ?? null) : c.lead;
      const shared = !workspaceOf(chat) ? sharedWorkerActive(chat.id) : undefined;
      const lastUser = messages
        .sorted(chat.id)
        .filter((m) => m.role === 'user')
        .at(-1);
      const sinceUser = chatWorkers(chat.id, { all: true }).filter((w) => w.createdAt > (lastUser?.ts ?? 0)).length;
      const refused = dispatchRefusal({
        explicit: c.explicit,
        asked: asked || undefined,
        member: member && { name: member.name, monthlyBudgetUsd: member.monthlyBudgetUsd, blindReview: member.blindReview },
        spent: member?.monthlyBudgetUsd ? monthSpend(member.id) : 0,
        active: activeWorkers(chat.id).length,
        max: settings.get().superAgent.router.maxWorkers,
        sharedBusy: shared ? { id: shared.id, reason: shared.shared || '' } : null,
        sinceUser,
        maxHops: Math.max(1, chat.maxHops),
      });
      if (refused || !member) return fail(refused || 'No member to run it as.');
      const subscribe = subscriptionsOn(settings.get().superAgent) && args.subscribe !== false;
      const w = startWorker(chat, member, { title, task, related: c.related, userMessageIds: c.userMessageIds, subscribe, threads: c.threads });
      return ok(`Started ${w.id} as ${member.name}: "${w.title}". It works in the background and its report will arrive as an event; don't wait for it.`);
    },

    async message_worker(args) {
      const t = turn();
      if (!t) return fail('No turn is in progress.');
      const w = workerOf(t.chat.id, args.id);
      const text = str(args.text).trim();
      const refused = messageRefusal({ explicit: t.c.explicit, found: !!w, dismissed: !!w?.dismissedAt });
      if (refused || !w) return fail(refused || 'No such Worker.');
      if (!text) return fail('The message is empty.');
      return ok(messageWorker(w, text) === 'queued' ? `${w.id} is busy; it gets this when its current turn ends.` : `${w.id} is working on it; its report will arrive as an event.`);
    },

    async stop_worker(args) {
      const t = turn();
      if (!t) return fail('No turn is in progress.');
      const w = workerOf(t.chat.id, args.id);
      if (!w) return fail('No such Worker in this chat.');
      return (await stopWorker(w.id, { why: `${t.c.lead.name} stopped the task` })) ? ok(`Stopping ${w.id}; its report will say how far it got.`) : ok(`${w.id} is not running (${w.status}).`);
    },

    async list_workers(args) {
      const t = turn();
      if (!t) return fail('No turn is in progress.');
      const name = (botId: string) => bots.get(botId)?.name || 'deleted bot';
      if (str(args.id)) {
        const w = workerOf(t.chat.id, args.id);
        if (!w) return fail('No such Worker in this chat.');
        const ws = projects.get(w.projectId)?.workspace;
        return ok(
          [
            `${w.id} · ${name(w.botId)} · ${w.status}${w.detail ? ` (${w.detail})` : ''} · started ${ago(w.createdAt)} · ${w.turns} turn${w.turns === 1 ? '' : 's'}`,
            `Title: ${w.title}`,
            `Task: ${w.task}`,
            ws ? `Workspace: branch ${ws.branch}, merged into ${ws.baseBranch}` : `Workspace: the chat's folder (${w.shared || 'none of its own'})`,
            w.pending?.length ? `Follow-ups waiting: ${w.pending.length}` : '',
            w.report ? `Last report (${w.report.status}, ${ago(w.report.at)}):\n${w.report.text || '(no text)'}` : 'No report yet.',
            landingText(w) || '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      const list = chatWorkers(t.chat.id);
      if (!list.length) return ok('No Workers in this chat.');
      return ok(list.map((w) => `${w.id} · ${name(w.botId)} · ${w.status} · "${w.title}" · ${w.report ? `report: ${firstWords(w.report.text, 20).text}` : w.detail || ''}`).join('\n'));
    },
  };
}

/** The handlers as Claude Code sees them. */
export function routerMcpServer(h: Record<string, Handler>, o: { subscriptions?: boolean } = {}) {
  const wrap = (name: string) => async (args: Record<string, unknown>) => {
    const r = await h[name](args);
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError || undefined };
  };
  return createSdkMcpServer({
    name: 'crew_router',
    version: '1.0.0',
    tools: [
      tool(
        'reply',
        `Post a message to the user in the chat, as you. The only way the user hears from you. At most ${REPLY_WORDS} words: what you started, results, a decision or acceptance you need.`,
        { text: z.string().describe('The message, in the language the user writes in') },
        wrap('reply'),
      ),
      tool(
        'dispatch_worker',
        "Start a Worker on one task, in the background. It runs as a member of the chat (default: you), with that member's role and permissions, in its own copy of the project, and sees only your task plus the user's messages from this batch. Returns its id at once; its report arrives later as an event.",
        {
          title: z.string().max(80).describe('A few words naming the task, shown to the user'),
          task: z.string().describe('A self-contained brief: the goal, the files or pages involved, what counts as done'),
          bot: z.string().optional().describe('The member to run it as (a name from the team list); default you'),
          ...(o.subscriptions
            ? {
                subscribe: z
                  .boolean()
                  .optional()
                  .describe("Subscribe it to the chat's workspace and this batch's routines, so their later events go to it directly (default true); false for a one-off task"),
              }
            : {}),
        },
        wrap('dispatch_worker'),
      ),
      tool(
        'message_worker',
        'Send a Worker a follow-up in its own conversation (it keeps its context): it runs now if the Worker is idle, or right after its current turn.',
        { id: z.string().describe('The Worker id, wk_…'), text: z.string().describe('The follow-up') },
        wrap('message_worker'),
      ),
      tool('stop_worker', "Stop a Worker's current turn.", { id: z.string().describe('The Worker id, wk_…') }, wrap('stop_worker')),
      tool(
        'list_workers',
        "List this chat's Workers; with id, one Worker's task, workspace and full last report.",
        { id: z.string().optional().describe('A Worker id, for its full details') },
        wrap('list_workers'),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
