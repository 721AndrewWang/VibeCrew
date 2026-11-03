// The webhook channel's stored settings (ADR 103): settings.webhooks[projectId], in settings.json,
// which the command guard keeps from every agent (the URL is a credential). Pure, so the settings
// store can normalise it without pulling in the sender.

import type { ReplyKind, WebhookFormat } from '../../shared/types';
import { isReplyKind } from './profiles';

export interface WebhookConfig {
  url: string;
  format: WebhookFormat;
  /** Turned on by the user, never by saving a URL; a new URL or format turns it off again. */
  enabled: boolean;
  /** The kinds of Router reply the user approved for sending. */
  kinds: ReplyKind[];
  /** When the user last turned it on. */
  approvedAt?: number;
}

/** Only what needs the user goes out unless they ask for more. */
export const DEFAULT_WEBHOOK_KINDS: ReplyKind[] = ['question', 'acceptance'];

export const isWebhookFormat = (v: unknown): v is WebhookFormat => v === 'slack' || v === 'feishu';

/** An http(s) URL without credentials in it; returns why not, or null. */
export function webhookUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "That doesn't look like a URL.";
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The webhook URL must start with https:// (or http:// for a local server).';
  if (u.username || u.password) return 'Put no user name or password in the URL.';
  if (url.length > 2000) return 'The URL is too long.';
  return null;
}

export function normalizeWebhook(raw: unknown): WebhookConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebhookConfig>;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url || webhookUrlProblem(url)) return null;
  const kinds = Array.isArray(r.kinds) ? [...new Set(r.kinds.filter(isReplyKind))] : [...DEFAULT_WEBHOOK_KINDS];
  return {
    url,
    format: isWebhookFormat(r.format) ? r.format : 'slack',
    enabled: r.enabled === true,
    kinds,
    ...(typeof r.approvedAt === 'number' ? { approvedAt: r.approvedAt } : {}),
  };
}

export function normalizeWebhooks(raw: unknown): Record<string, WebhookConfig> {
  const out: Record<string, WebhookConfig> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const w = normalizeWebhook(v);
    if (w) out[id] = w;
  }
  return out;
}

/** Host and a path cut to its first segment: enough to recognise it, not enough to post to it. */
export function maskUrl(url: string): { host: string; masked: string } {
  try {
    const u = new URL(url);
    const first = u.pathname.split('/').filter(Boolean)[0];
    return { host: u.host, masked: `${u.protocol}//${u.host}/${first ? `${first}/` : ''}…` };
  } catch {
    return { host: '', masked: '' };
  }
}
