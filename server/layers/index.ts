// Two-layer mode (ADR 002): a resident Router per group chat and isolated Workers. Behind
// settings.superAgent.enabled and superAgent.router.enabled; with either off, group chats route to
// the lead exactly as before.

import { logger } from '../log';
import { closeRouterSessions, forgetRouter, resetRouter, resumeRouters, routerBusy, stopRouter } from './router';
import { activeWorkers, closeIdleWorkerSessions, closeWorkerSessions, dismissFinished, forgetWorkers, recoverWorkers, stopChatWorkers, sweepWorkers } from './workers';

export type { RouterEvent } from './prompts';
export { invalidateRouters, leadOf, routerEvent, routerInfos, routerMode } from './router';
export { activeWorkers, dismissWorker, listWorkers, refreshWorkerSessions, sharedWorkerActive, stopWorker, workerWorkingIn } from './workers';

const log = logger('layers');

/** The Router is thinking or has events waiting, or a Worker of the chat is active. */
export function layersBusy(chatId: string): boolean {
  return routerBusy(chatId) || activeWorkers(chatId).length > 0;
}

/** The user stopped the chat: the Router's turn and every Worker stop; the Router is not told. */
export async function stopLayers(chatId: string) {
  await stopRouter(chatId);
  await stopChatWorkers(chatId);
}

/** "Start new topic": the Router forgets, finished Workers go, running ones carry on. */
export function resetLayers(chatId: string) {
  resetRouter(chatId);
  void dismissFinished(chatId).catch((e) => log.warn('dismiss workers:', e));
}

/** The chat is deleted. */
export function forgetLayers(chatId: string) {
  forgetRouter(chatId);
  void forgetWorkers(chatId).catch((e) => log.warn('forget workers:', e));
}

export function closeLayerSessions() {
  closeRouterSessions();
  closeWorkerSessions();
}

/** Before the workspaces are reconciled: settles Workers a restart cut off; returns the ones whose workspaces stay. */
export function recoverLayers() {
  const r = recoverWorkers();
  setInterval(() => sweepWorkers(), 3600_000).unref();
  setInterval(() => closeIdleWorkerSessions(), 60_000).unref();
  return r;
}

export { resumeRouters };
