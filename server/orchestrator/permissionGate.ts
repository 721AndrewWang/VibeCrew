// Which tool calls a bot may make: the deny list, the bot's and project's rules, and the user's
// answers to approval requests shown in the chat.

import type { ApprovalPart, Bot, BotStatus, Chat, Project } from '../../shared/types';
import { decide, describeAction, EDIT_TOOLS, harmless, matchingRule, splitCommand, suggestRules } from '../agents/permissions';
import type { TurnStream } from '../agents/stream';
import { bus, notify } from '../bus';
import { recordFriction, SLOW_APPROVAL_MS } from '../friction';
import { logger } from '../log';
import { configOf } from '../projects';
import { remindLater } from '../push';
import { type Actor, guardRefusal, guardVerdict } from '../safety';
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

/** What a refusal needs to know beyond the call: the project (its allow-list), who asked, and a read-only family. */
export interface DenyScope {
  project?: Project | null;
  actor?: Actor;
  /** A Worker on a read-only skill family (ADR 007): it may not edit files. */
  readOnly?: string;
}

/**
 * Why the action is refused outright, or null: Settings → Defaults → Blocked actions, then the
 * command guard's hard rules (ADR 007). Read fresh on every call; the PreToolUse hook calls this
 * in every permission mode, so Full auto and the AI reviewer cannot approve what it refuses.
 */
export function deniedReason(toolName: string, input: unknown, cwd: string, scope: DenyScope = {}): string | null {
  const rule = matchingRule(settings.get().denyRules || [], toolName, input, cwd);
  if (rule) return `This action is blocked (Settings → Defaults → Blocked actions: ${rule}). Don't try to get around it with a different command; if it's needed, ask the user to do it themselves.`;
  if (scope.readOnly && EDIT_TOOLS.has(toolName))
    return `This task runs the ${scope.readOnly} skill family, which is read-only: report what you found and what should change instead of editing files.`;
  return guardRefusal(toolName, input, cwd, scope.project ?? null, scope.actor);
}

/**
 * The canUseTool hook for one turn of a bot in a chat. A Worker's turn passes `status` (its own
 * state, not the bot's) and `who` (how the approval request names it).
 */
export function permissionGate(turn: {
  chat: Chat;
  bot: Bot;
  project: Project | null;
  cwd: string;
  stream: TurnStream;
  status?: (s: Omit<BotStatus, 'since'>) => void;
  who?: string;
  /** A Worker's run: who it is (audit log), and its read-only skill family, if any. */
  workerId?: string;
  readOnly?: string;
}) {
  const { chat, bot, project, cwd, stream } = turn;
  const status = turn.status ?? ((s: Omit<BotStatus, 'since'>) => setStatus(bot.id, s));
  const who = turn.who ?? bot.name;
  const actor: Actor = { botId: bot.id, botName: bot.name, chatId: chat.id, workerId: turn.workerId };
  /** Commands the user allowed in this turn: the same one is not asked about again (a state change prompts once). */
  const allowedOnce = new Set<string>();
  return async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; matchedAskRule?: unknown; decisionReason?: string; title?: string }) => {
    const current = bots.get(bot.id) || bot;
    const desc = describeAction(toolName, input, cwd);
    const refused = deniedReason(toolName, input, cwd, { project, actor, readOnly: turn.readOnly });
    if (refused) {
      log.warn(`${bot.name} in ${chat.id}: deny ${desc.title} — ${refused}`);
      return { behavior: 'deny' as const, message: refused };
    }
    // The project's own "must ask" rules apply to every bot working there.
    const projectRules = project ? configOf(project).askRules || [] : [];
    // The chat's mode switch is read each time: switching to Auto applies to the running turn too.
    const level = effectiveBot(chats.get(chat.id) || chat, current).permission;
    // The guard's verdict (ADR 007): a read never prompts; a change prompts once, with what it changes.
    const verdict = toolName === 'Bash' ? guardVerdict(toolName, input, cwd, project) : null;
    const onceKey = verdict ? `${toolName}\n${String(input.command || '')}` : '';
    let d = decide(current, level, toolName, input, cwd, { ...opts, projectRules, readOnlyCommand: verdict?.kind === 'read' });
    // A read-only family: a command that changes something asks, whatever the level.
    if (turn.readOnly && d.behavior === 'allow' && verdict?.kind === 'change') d = { behavior: 'ask', because: `the ${turn.readOnly} skill family is read-only, and this command changes something` };
    if (d.behavior === 'ask' && onceKey && allowedOnce.has(onceKey)) d = { behavior: 'allow', because: 'you allowed this same command earlier in this turn' };
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
      effects: verdict?.kind === 'change' && verdict.effects.length ? verdict.effects : undefined,
    };
    part.rule = part.rules?.[0];
    stream.addPart(part);
    status({ state: 'waiting', detail: desc.title, chatId: chat.id });
    notify(`${who} needs your approval`, desc.title, { chatId: chat.id, level: 'warn' });
    // Still open after a few minutes: a push to the phone (Bark), if one is set up.
    const cancelPush = remindLater(who, chat.title || bot.name, desc.title);
    const askedAt = Date.now();
    const decision = await new Promise<{ allow: boolean; always?: boolean; message?: string; expired?: boolean }>((resolve) => {
      approvals.set(part.id, { chatId: chat.id, botId: bot.id, part, stream, resolve });
      opts.signal?.addEventListener('abort', () => resolve({ allow: false, expired: true }), { once: true });
    });
    cancelPush();
    approvals.delete(part.id);
    part.status = decision.allow ? 'allowed' : decision.expired ? 'expired' : 'denied';
    stream.updatePart(part);
    noteApprovalFriction({ bot, chat, toolName, input, title: desc.title, because: d.because, decision, waitedMs: Date.now() - askedAt });
    status({ state: 'tool', detail: toolName, chatId: chat.id });
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
    if (decision.allow && onceKey) allowedOnce.add(onceKey);
    if (decision.allow) return { behavior: 'allow' as const, updatedInput: input };
    return {
      behavior: 'deny' as const,
      message: decision.message ? `The user denied this action and said: ${decision.message}` : 'The user denied this action. Try a different approach, or ask the user first.',
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

/** A Worker was stopped: the requests its turn left open are denied with this message. */
export function denyStreamApprovals(stream: TurnStream, message: string) {
  for (const [id, a] of approvals) {
    if (a.stream === stream) {
      a.resolve({ allow: false, message });
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

/**
 * What an answered approval says about Crew's friction: denied, slow to answer, or a read-only
 * command that a rule should not have stopped.
 */
function noteApprovalFriction(a: {
  bot: Bot;
  chat: Chat;
  toolName: string;
  input: Record<string, unknown>;
  title: string;
  because: string;
  decision: { allow: boolean; expired?: boolean; message?: string };
  waitedMs: number;
}) {
  const base = { chatId: a.chat.id, chatTitle: a.chat.title, botName: a.bot.name };
  const command = a.toolName === 'Bash' ? String(a.input?.command || '') : '';
  if (!a.decision.allow && !a.decision.expired) {
    recordFriction({
      ...base,
      kind: 'approval-denied',
      key: a.because,
      detail: `${a.bot.name}: ${a.title}${command ? ` — ${command}` : ''}${a.decision.message ? ` (you said: ${a.decision.message})` : ''}`,
    });
  }
  // In "ask every step" mode the user chose to see read-only commands too.
  if (a.decision.allow && command && (a.chat.permission || a.bot.permission) !== 'ask') {
    const segs = splitCommand(command).filter((s) => s.trim());
    if (segs.length && segs.every(harmless)) recordFriction({ ...base, kind: 'approval-readonly', key: a.because, detail: `${a.bot.name}: ${command}` });
  }
  if (!a.decision.expired && a.waitedMs >= SLOW_APPROVAL_MS) {
    recordFriction({ ...base, kind: 'approval-slow', key: a.because, detail: `${a.bot.name} waited ${Math.round(a.waitedMs / 60_000)} min: ${a.title}` });
  }
}
