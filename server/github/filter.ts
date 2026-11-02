// The GitHub channel's own fast-path rules (ADR 102): deterministic, per project, in code. Each
// event gets a screen result that the Trigger bus's fast path applies beside its shared rules, so
// every drop is recorded with its rule. Pure.

import type { GithubChannel } from '../../shared/types';
import { checkPassed, type GhEvent } from './events';

/**
 * Why an event is dropped. `subscribers: true` means only for the Workers subscribed to its thread:
 * they still get it, nobody else does (and the cheap model never sees it).
 */
export interface Screen {
  rule: string;
  reason: string;
  subscribers?: boolean;
}

export interface ScreenContext {
  /** URLs approved drafts printed: what Crew posted for the user. */
  ownUrls: ReadonlySet<string>;
}

const isBot = (e: GhEvent) => /\[bot\]$/i.test(e.author || '') || e.authorType === 'Bot';

/** Null: the event passes this project's rules and goes on to the shared ones. */
export function screenGithub(e: GhEvent, conf: GithubChannel, ctx: ScreenContext): Screen | null {
  if (e.url && ctx.ownUrls.has(e.url)) return { rule: 'own-draft', reason: 'Crew posted this for you (an approved draft); it is not news' };
  if (e.kind !== 'check') {
    const listed = !!e.author && conf.authors.some((a) => a.toLowerCase() === e.author?.toLowerCase());
    if (isBot(e) && !listed) return { rule: 'bot-author', reason: `Written by a bot (${e.author || 'unknown'}); list it under authors to hear from it` };
    if (conf.authors.length && !listed) return { rule: 'author-not-allowed', reason: `${e.author || 'The author'} is not on this project's GitHub author list` };
  }
  if (checkPassed(e)) return { rule: 'check-passed', reason: 'The check did not fail; only Workers on this pull request hear about it', subscribers: true };
  if (!conf.candidates) return { rule: 'subscribers-only', reason: "This project's GitHub events go only to the Workers subscribed to their issue or pull request", subscribers: true };
  return null;
}
