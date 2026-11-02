// Spend windows (ADR 009): rolling limits on what a role or one bot may spend. Pure: the caller
// hands in the usage log.

import type { GatewayCall, SpendWindow } from '../../shared/types';
import type { Scope } from './config';
import { totalTokens } from './pricing';

export function covers(w: SpendWindow, scope: Scope): boolean {
  return (w.role === '*' || w.role === scope.role) && (!w.botId || w.botId === scope.botId);
}

const counted = (c: GatewayCall) => c.outcome !== 'limited';

export interface WindowState {
  id: string;
  usedUsd: number;
  usedTokens: number;
  spent: boolean;
  /** Seconds until enough of the window's oldest calls leave it for the next call to go through. */
  retryAfterSec?: number;
}

/** What a window has used at `now`, from calls oldest first. */
export function windowState(w: SpendWindow, calls: GatewayCall[], now = Date.now()): WindowState {
  const span = w.hours * 3_600_000;
  const inside = calls.filter((c) => counted(c) && c.at > now - span && covers(w, { role: c.role, botId: c.botId }));
  let usd = 0;
  let tokens = 0;
  for (const c of inside) {
    usd += c.costUsd;
    tokens += totalTokens(c.tokens);
  }
  const over = (u: number, t: number) => (w.maxUsd > 0 && u >= w.maxUsd) || (w.maxTokens > 0 && t >= w.maxTokens);
  const state: WindowState = { id: w.id, usedUsd: Math.round(usd * 1e6) / 1e6, usedTokens: tokens, spent: over(usd, tokens) };
  if (!state.spent) return state;
  // The window reopens once the oldest calls that put it over have aged out.
  let u = usd;
  let t = tokens;
  for (const c of inside) {
    u -= c.costUsd;
    t -= totalTokens(c.tokens);
    if (!over(u, t)) {
      state.retryAfterSec = Math.max(1, Math.ceil((c.at + span - now) / 1000));
      return state;
    }
  }
  state.retryAfterSec = Math.max(1, Math.ceil(span / 1000));
  return state;
}

/** The first window covering this scope that is used up, if any. */
export function spentWindow(windows: SpendWindow[], scope: Scope, calls: GatewayCall[], now = Date.now()): { window: SpendWindow; state: WindowState } | undefined {
  for (const w of windows) {
    if (!covers(w, scope)) continue;
    const state = windowState(w, calls, now);
    if (state.spent) return { window: w, state };
  }
  return undefined;
}

export function describeWindow(w: SpendWindow): string {
  const limits = [w.maxUsd > 0 ? `$${w.maxUsd}` : '', w.maxTokens > 0 ? `${w.maxTokens.toLocaleString('en-US')} tokens` : ''].filter(Boolean).join(' / ');
  const who = w.role === '*' ? 'all calls' : w.botId ? `${w.role} ${w.botId}` : w.role;
  return `${limits || 'no limit'} per ${w.hours} h for ${who}`;
}
