// Inline & Spill context and the chain of recall (ADR 005). Behind superAgent.recall.enabled, which
// counts only while superAgent.enabled is on; with it off, recallBudget() is undefined and every
// caller takes its old path.

import type { RecallResult } from '../../shared/types';
import { logger } from '../log';
import { settings } from '../store';
import { type RecallScope, resolve } from './graph';
import { type Budget, budgetOf, estimateTokens, renderNode } from './spill';

export { type Budget, RECALL_RESUME_NOTE, RECALL_TOOL } from './spill';

const log = logger('recall');

export function recallOn(): boolean {
  const sa = settings.get().superAgent;
  return sa.enabled && sa.recall.enabled;
}

/** The budgets prompts are built with, or undefined while recall is off. */
export function recallBudget(): Budget | undefined {
  return recallOn() ? budgetOf(settings.get().superAgent.recall.inlineWords) : undefined;
}

export function recallText(id: string, scope: RecallScope, from = 0): RecallResult | { error: string } {
  const budget = recallBudget() ?? budgetOf(settings.get().superAgent.recall.inlineWords);
  const r = resolve(id, scope);
  if ('error' in r) return r;
  const text = renderNode(r.node, budget, Math.max(0, Math.floor(from)));
  return { id: r.node.id, text, node: r.node, tokens: estimateTokens(text) };
}

/** A turn's injected prompt, with and without Inline & Spill: logged, and kept on the turn. */
export function measureInjected(what: string, withRecall: string, without: string): { tokens: number; without: number } {
  const m = { tokens: estimateTokens(withRecall), without: estimateTokens(without) };
  log.info(`${what}: injected ~${m.tokens} tokens (~${m.without} without Inline & Spill)`);
  return m;
}
