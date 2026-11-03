// Thread subscriptions (ADR 003): which Workers a Trigger goes straight to, and the bound on what
// waits in a Worker's inbox. Pure, so the rules are easy to test.

import type { SuperAgentSettings, Worker, WorkerDelivery } from '../../shared/types';
import { WORKER_ACTIVE } from '../../shared/workers';

/** At most this many delivered Triggers wait in a Worker's inbox; the oldest go first. */
export const INBOX_MAX = 20;

/** Direct routing is on: the Super-agent, its Router and subscriptions are all switched on. */
export function subscriptionsOn(sa: SuperAgentSettings): boolean {
  return sa.enabled && sa.router.enabled && sa.router.subscriptions;
}

export interface ReceiverQuery {
  threadId: string;
  /** A routine run (the user's own request) wakes a finished Worker; environment events reach only working ones. */
  explicit: boolean;
  /** The Worker whose action caused the Trigger (its own landing): it is not told of it. */
  origin?: string;
  /** Its chat is in two-layer mode with subscriptions on. */
  live(w: Worker): boolean;
}

/**
 * A Worker that failed or was stopped keeps its subscriptions but receives nothing, so its Threads'
 * events go to the Router until the Router gets it going again.
 */
export function isReceiver(w: Worker, q: ReceiverQuery): boolean {
  if (w.dismissedAt || w.id === q.origin || !w.threads?.includes(q.threadId) || !q.live(w)) return false;
  return WORKER_ACTIVE.has(w.status) || (q.explicit && w.status === 'done');
}

export function receivers(all: Worker[], q: ReceiverQuery): Worker[] {
  return all.filter((w) => isReceiver(w, q));
}

/** The inbox with one more delivery: no Trigger twice, and the oldest dropped past the bound. */
export function pushInbox(inbox: WorkerDelivery[] | undefined, d: WorkerDelivery): WorkerDelivery[] {
  return [...(inbox || []).filter((x) => x.triggerId !== d.triggerId), d].slice(-INBOX_MAX);
}
