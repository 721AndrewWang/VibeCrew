// A group's chain of turns can stop with work unfinished: a teammate reports back without handing
// on to anyone, and nobody picks it up until the user notices. When that happens the lead is told
// and gets a turn to check the batch and carry on, a few times per user request at most.

import type { Bot, Chat, ChatMessage } from '../shared/types';

/** Lead turns started this way between two user messages. */
export const MAX_STALL_NUDGES = 3;

export function stallNote(teammate: string, lead: string): string {
  return `${teammate} 交回了结果，但没有交给下一个人，接力停在这里了。@${lead} 请看一下这一批是不是都完成了：没完成就继续派活，完成了就给用户汇总；需要用户决定的事，列出来问用户。`;
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
  const since = lastUser ? history.filter((m) => m.seq > lastUser.seq) : history;
  if (since.filter((m) => m.role === 'system' && m.notice === 'stall').length >= MAX_STALL_NUDGES) return null;
  return lead;
}
