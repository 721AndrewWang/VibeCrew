// Two-layer mode's settings (settings.superAgent.router): defaults, and cleaning up what is stored.
// Pure, so the trigger settings can normalise it without pulling in the Router.

import type { RouterSettings } from '../../shared/types';

export const DEFAULT_ROUTER: RouterSettings = {
  enabled: false,
  // Routing, batching events and short replies: a lighter model is enough.
  model: 'claude-sonnet-5',
  // Empty: the chat's model switch, else the default model, which is Claude Code's strongest unless changed.
  workerModel: '',
  maxWorkers: 3,
};

export const MAX_WORKERS_LIMIT = 8;

const model = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim().slice(0, 200) : fallback);

/** Fills in what a stored (or older, or partial) value lacks. */
export function normalizeRouter(raw: unknown): RouterSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RouterSettings>;
  const max = Number(r.maxWorkers);
  return {
    enabled: r.enabled === true,
    model: model(r.model, DEFAULT_ROUTER.model),
    workerModel: model(r.workerModel, DEFAULT_ROUTER.workerModel),
    maxWorkers: Number.isFinite(max) ? Math.max(1, Math.min(MAX_WORKERS_LIMIT, Math.round(max))) : DEFAULT_ROUTER.maxWorkers,
  };
}
