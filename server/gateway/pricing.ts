// A call's estimated cost: tokens × the provider's price, else Anthropic's list price for Claude
// models, else 0. Prices are USD per million tokens; cache reads 0.1× input, cache writes 1.25×.

import type { GatewayProvider, TurnTokens } from '../../shared/types';

/** Anthropic list prices (checked October 2026), matched against the model name, first match wins. */
const CLAUDE_PRICES: [RegExp, number, number][] = [
  [/fable|mythos/i, 10, 50],
  [/opus-5-5/i, 4, 20],
  [/opus/i, 5, 25],
  [/sonnet-5/i, 2, 10],
  [/sonnet/i, 3, 15],
  [/haiku-5/i, 0.1, 0.5],
  [/haiku/i, 1, 5],
];

export function priceOf(provider: Pick<GatewayProvider, 'price'> | undefined, model: string): { input: number; output: number } {
  if (provider?.price) return provider.price;
  if (/claude|opus|sonnet|haiku|fable|mythos/i.test(model)) {
    const hit = CLAUDE_PRICES.find(([re]) => re.test(model));
    if (hit) return { input: hit[1], output: hit[2] };
  }
  return { input: 0, output: 0 };
}

export function estimateCost(tokens: TurnTokens, price: { input: number; output: number }): number {
  const usd = (tokens.input * price.input + tokens.cacheRead * price.input * 0.1 + tokens.cacheWrite * price.input * 1.25 + tokens.output * price.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export const totalTokens = (t: TurnTokens | undefined) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);

/** The Messages API's usage object as TurnTokens. */
export function tokensOf(usage: unknown): TurnTokens | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
}

/** A stream reports usage twice: message_start (input, cache) and message_delta (output, sometimes input again). */
export function mergeTokens(a: TurnTokens | undefined, b: TurnTokens | undefined): TurnTokens | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite) };
}
