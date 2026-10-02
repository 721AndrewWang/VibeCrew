// Which tool calls a bot may make: the deny list, the bot's and project's rules, and the user's
// answers to approval requests shown in the chat.

import type { ApprovalPart, Bot, Chat, Project } from '../../shared/types';
import { decide, describeAction, matchingRule, suggestRules } from '../agents/permissions';
import type { TurnStream } from '../agents/stream';
import { bus, notify } from '../bus';
import { logger } from '../log';
import { configOf } from '../projects';
import { bots, chats, settings, uid } from '../store';
import { setStatus } from './botStatus';
import { effectiveBot } from './turnContext';

interface PendingApproval {
  chatId: string;
  botId: string;
  part: ApprovalPart;
  stream: TurnStream;
  resolve: (d: { allow: boolean; always?: boolean; message?: string; expired?: boolean }) => void;
}

const log = logger('permission');

const approvals = new Map<string, PendingApproval>();

/** Why the action is refused outright (Settings → 默认值 → 禁止的操作), or null. Read fresh on every call. */
export function deniedReason(toolName: string, input: unknown, cwd: string): string | null {
  const rule = matchingRule(settings.get().denyRules || [], toolName, input, cwd);
  if (!rule) return null;
  return `这个操作被禁止了（设置 → 默认值 → 禁止的操作：${rule}）。不要换一种写法绕过它；需要的话请用户自己来做。`;
}

/** The canUseTool hook for one turn of a bot in a chat. */
export function permissionGate(turn: { chat: Chat; bot: Bot; project: Project | null; cwd: string; stream: TurnStream }) {
  const { chat, bot, project, cwd, stream } = turn;
  return async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; matchedAskRule?: unknown; decisionReason?: string; title?: string }) => {
    const current = bots.get(bot.id) || bot;
    const desc = describeAction(toolName, input, cwd);
    const refused = deniedReason(toolName, input, cwd);
    if (refused) {
      log.warn(`${bot.name} in ${chat.id}: deny ${desc.title} — ${refused}`);
      return { behavior: 'deny' as const, message: refused };
    }
    // The project's own "must ask" rules apply to every bot working there.
    const projectRules = project ? configOf(project).askRules || [] : [];
    // The chat's mode switch is read each time: switching to 自动 applies to the running turn too.
    const level = effectiveBot(chats.get(chat.id) || chat, current).permission;
    const d = decide(current, level, toolName, input, cwd, { ...opts, projectRules });
    log[d.behavior === 'allow' ? 'debug' : 'info'](`${bot.name} in ${chat.id}: ${d.behavior} ${desc.title} — ${d.because}`);
    if (d.behavior === 'allow') return { behavior: 'allow' as const, updatedInput: input };
    if (d.behavior === 'deny') return { behavior: 'deny' as const, message: d.message };
    const part: ApprovalPart = {
      type: 'approval',
      id: uid('a_'),
      toolName,
      input: slimInput(input),
      title: desc.title,
      detail: desc.detail,
      status: 'pending',
      rule: undefined,
      rules: suggestRules(toolName, input, cwd),
      reason: opts.decisionReason,
      because: d.because,
    };
    part.rule = part.rules?.[0];
    stream.addPart(part);
    setStatus(bot.id, { state: 'waiting', detail: desc.title, chatId: chat.id });
    notify(`${bot.name} 需要你的确认`, desc.title, { chatId: chat.id, level: 'warn' });
    const decision = await new Promise<{ allow: boolean; always?: boolean; message?: string; expired?: boolean }>((resolve) => {
      approvals.set(part.id, { chatId: chat.id, botId: bot.id, part, stream, resolve });
      opts.signal?.addEventListener('abort', () => resolve({ allow: false, expired: true }), { once: true });
    });
    approvals.delete(part.id);
    part.status = decision.allow ? 'allowed' : decision.expired ? 'expired' : 'denied';
    stream.updatePart(part);
    setStatus(bot.id, { state: 'tool', detail: toolName, chatId: chat.id });
    const newRules = (part.rules || []).filter(Boolean);
    if (decision.allow && decision.always && newRules.length) {
      const b = bots.get(bot.id);
      if (b && newRules.some((r) => !b.allowRules.includes(r))) {
        b.allowRules = [...new Set([...b.allowRules, ...newRules])];
        b.updatedAt = Date.now();
        bots.set(b);
        bus.emit({ t: 'bot', bot: b });
      }
    }
    if (decision.allow) return { behavior: 'allow' as const, updatedInput: input };
    return {
      behavior: 'deny' as const,
      message: decision.message ? `用户拒绝了这个操作，并说：${decision.message}` : '用户拒绝了这个操作。请换一种做法，或者先问问用户。',
    };
  };
}

function slimInput(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 20_000 ? v.slice(0, 20_000) + '…' : v;
  return out;
}

export function resolveApproval(id: string, decision: { allow: boolean; always?: boolean; message?: string }) {
  const a = approvals.get(id);
  if (!a) return false;
  a.resolve(decision);
  return true;
}

/** The turn ended: requests it left open expire. */
export function expireApprovals(stream: TurnStream) {
  for (const [id, a] of approvals) {
    if (a.stream === stream) {
      a.resolve({ allow: false, expired: true });
      approvals.delete(id);
    }
  }
}

/** The user stopped the chat: its open requests are denied with this message. */
export function denyApprovals(chatId: string, message: string) {
  for (const [id, a] of approvals) {
    if (a.chatId === chatId) {
      a.resolve({ allow: false, message });
      approvals.delete(id);
    }
  }
}
