// The Router's output is probabilistic; these checks are not. Each returns why a tool call is
// refused (the model reads it as the tool's error), or null. Pure, so they are easy to test.

import type { ReplyKind } from '../../shared/types';
import { chatRefusal } from '../channels/profiles';

/** The chat profile (ADR 103): at most 100 words and 6 lines, no tool output, a question asks something. */
export function replyRefusal(text: string, kind: ReplyKind = 'decision'): string | null {
  return chatRefusal(text, kind);
}

export interface DispatchCheck {
  /** The batch holds at least one explicit event (the user, a routine, a Worker report). */
  explicit: boolean;
  /** The member asked for, when one was named. */
  asked?: string;
  /** That member, if it is in the chat. */
  member: { name: string; monthlyBudgetUsd?: number; blindReview?: boolean } | null;
  /** What the member has spent this month. */
  spent: number;
  /** Workers active in the chat now, and the limit. */
  active: number;
  max: number;
  /** A Worker already working in the chat's shared folder, when the new one would have to share it too. */
  sharedBusy?: { id: string; reason: string } | null;
  /** Workers started since the user's last message, and how many the chat allows (its max hops). */
  sinceUser?: number;
  maxHops?: number;
}

export function dispatchRefusal(c: DispatchCheck): string | null {
  if (!c.explicit) return 'This batch holds only environment events, which cannot start work. Tell the user what happened (reply) and let them ask for it.';
  // Report -> dispatch -> report can go round without the user: the chat's relay limit applies.
  if (c.maxHops !== undefined && (c.sinceUser ?? 0) >= c.maxHops)
    return `${c.sinceUser} Workers were started since the user's last message, the chat's limit. Tell the user where things stand and let them decide.`;
  if (!c.member) return c.asked ? `${c.asked} is not a member of this chat. Pick one of the team listed in your instructions.` : 'This chat has no member to run a Worker as.';
  if (c.member.monthlyBudgetUsd && c.spent >= c.member.monthlyBudgetUsd)
    return `${c.member.name} has used up this month's budget ($${c.member.monthlyBudgetUsd.toFixed(2)}), so it can't take tasks. Pick another member, or tell the user.`;
  if (c.active >= c.max) return `${c.active} Workers are already active (the limit is ${c.max}). Wait for a report, or stop one first.`;
  if (c.sharedBusy)
    return `${c.sharedBusy.id} is already working in the chat's folder, and Workers can't get their own workspace here (${c.sharedBusy.reason}). Wait for its report, or send it this task with message_worker.`;
  return null;
}

/** message_worker: follow-ups steer work, so they need an explicit batch too. */
export function messageRefusal(c: { explicit: boolean; found: boolean; dismissed: boolean }): string | null {
  if (!c.explicit) return 'This batch holds only environment events, which cannot steer Workers. Tell the user (reply) and let them ask.';
  if (!c.found) return 'No such Worker in this chat. list_workers shows the ones that exist.';
  if (c.dismissed) return 'That Worker was dismissed. Dispatch a new one.';
  return null;
}
