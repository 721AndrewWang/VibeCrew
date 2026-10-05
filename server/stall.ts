// A group's chain of turns can stop with work unfinished: a teammate reports back without handing
// on to anyone, and nobody picks it up until the user notices. When that happens the lead is told
// and gets a turn to check the batch and carry on, a few times per user request at most.

import type { Bot, Chat, ChatMessage } from '../shared/types';

/**
 * Lead turns started this way between two user messages. A batch that goes write → review →
 * refute → fix → recheck uses several; the chat's hop limit still bounds a runaway chain.
 */
export const MAX_STALL_NUDGES = 8;

/**
 * The lead ends a reply with this line when its next step is its own (commit now, dispatch next):
 * it gets another turn straight away instead of waiting for the user.
 */
export const CONTINUE_MARK = '【继续】';

export function stallNote(teammate: string, lead: string): string {
  return `${teammate} 交回了结果，但没有交给下一个人，接力停在这里了。@${lead} 请看一下这一批是不是都完成了：没完成就继续派活，完成了就给用户汇总；需要用户决定的事，列出来问用户。`;
}

export function continueNote(lead: string): string {
  return `${lead} 说下一步还要自己接着做，接着给它一轮。`;
}

/** Nudges (stall or continue) already used since the latest user message. */
function nudgesSinceUser(history: ChatMessage[]): number {
  const lastUser = history.filter((m) => m.role === 'user').at(-1);
  const since = lastUser ? history.filter((m) => m.seq > lastUser.seq) : history;
  return since.filter((m) => m.role === 'system' && m.notice === 'stall').length;
}

/** The lead asked for another turn with the continue line, handed on to no one, and has budget left. */
export function leadContinues(opts: { chat: Chat; bot: Bot; msg: ChatMessage; mentioned: Bot[]; history: ChatMessage[] }): boolean {
  const { chat, bot, msg, mentioned, history } = opts;
  if (chat.kind !== 'group' || chat.leadBotId !== bot.id || msg.status !== 'done' || mentioned.length) return false;
  if (!msg.text.split('\n').some((l) => l.trim() === CONTINUE_MARK)) return false;
  return nudgesSinceUser(history) < MAX_STALL_NUDGES;
}

/**
 * The lead to wake when `msg` ended a chain without handing on, or null.
 * `msg` must be the bot's finished turn, `mentioned` who it handed on to, and `history` the chat's
 * messages in order (including `msg`). Only called once the chat's queue is empty.
 */
export function stalledLead(opts: { chat: Chat; bot: Bot; msg: ChatMessage; mentioned: Bot[]; history: ChatMessage[]; trigger?: ChatMessage['trigger']; members: Bot[] }): Bot | null {
  const { chat, bot, msg, mentioned, history, trigger, members } = opts;
  if (chat.kind !== 'group' || msg.status !== 'done' || mentioned.length) return null;
  const lead = members.find((b) => b.id === chat.leadBotId);
  if (!lead || lead.id === bot.id) return null;
  const lastUser = history.filter((m) => m.role === 'user').at(-1);
  // A teammate the user addressed directly answers the user; unless the user also asked the lead
  // to follow up, its reply is where the user wants the chain to stop.
  if (trigger?.type === 'user' && !(lastUser && lastUser.text.includes(`@${lead.name}`))) return null;
  // An automatic review that refuted nothing settles the chain; one that refuted something needs
  // the lead to get it fixed.
  if (trigger?.type === 'system' && msg.meta?.verdict && msg.meta.verdict.refuted === 0) return null;
  if (nudgesSinceUser(history) >= MAX_STALL_NUDGES) return null;
  return lead;
}
