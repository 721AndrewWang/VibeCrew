// Two-layer mode's settings (settings.superAgent.router): defaults, and cleaning up what is stored.
// Pure, so the trigger settings can normalise it without pulling in the Router.

import { DEFAULT_ROUTER } from '../../shared/defaults';
import type { RouterSettings } from '../../shared/types';
import { bounded, fields, modelName } from '../normalize';

export const MAX_WORKERS_LIMIT = 8;

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeRouter(raw: unknown): RouterSettings {
  const r = fields<RouterSettings>(raw);
  return {
    enabled: r.enabled === true,
    model: modelName(r.model, DEFAULT_ROUTER.model),
    workerModel: modelName(r.workerModel, DEFAULT_ROUTER.workerModel),
    maxWorkers: bounded(r.maxWorkers, 1, MAX_WORKERS_LIMIT, DEFAULT_ROUTER.maxWorkers),
    subscriptions: r.subscriptions === true,
  };
}
