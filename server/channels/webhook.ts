// The webhook channel (ADR 103): a project can register one outgoing webhook (a Slack incoming
// webhook or a Feishu custom bot) for Router notifications. Off by default; it sends only Router
// replies of the kinds the user approved, as the reply's text filtered once more (never code,
// tool output, reports or file contents), and Crew posts it itself, not an agent.

import type { Chat, ChatMessage, Project, ReplyKind, WebhookDelivery, WebhookFormat, WebhookInfo } from '../../shared/types';
import { logger } from '../log';
import { HttpError } from '../projects';
import { bots, projects, settings } from '../store';
import { KIND_LABEL, webhookText } from './profiles';
import { DEFAULT_WEBHOOK_KINDS, isWebhookFormat, maskUrl, normalizeWebhook, type WebhookConfig, webhookUrlProblem } from './webhookConfig';

const log = logger('webhook');

const TIMEOUT_MS = 5000;
const KEEP_DELIVERIES = 20;

/** The last deliveries per project, newest first. In memory: a log of what left, not a queue. */
const deliveries = new Map<string, WebhookDelivery[]>();

/** A workspace (a chat's or a Worker's) uses the webhook of the project it was branched from. */
export function rootProject(id: string | null | undefined): Project | undefined {
  let p = projects.get(id);
  for (let i = 0; p?.workspace && i < 5; i++) p = projects.get(p.workspace.parentId) ?? p;
  return p;
}

function configOf(projectId: string): WebhookConfig | undefined {
  return settings.get().webhooks?.[projectId];
}

export function webhookInfo(projectId: string): WebhookInfo {
  const c = configOf(projectId);
  const { host, masked } = c ? maskUrl(c.url) : { host: '', masked: '' };
  return {
    projectId,
    configured: !!c,
    host,
    masked,
    format: c?.format ?? 'slack',
    enabled: !!c?.enabled,
    kinds: c?.kinds ?? [...DEFAULT_WEBHOOK_KINDS],
    ...(c?.approvedAt ? { approvedAt: c.approvedAt } : {}),
    deliveries: deliveries.get(projectId) ?? [],
  };
}

export interface WebhookPatch {
  url?: string;
  format?: WebhookFormat;
  enabled?: boolean;
  kinds?: ReplyKind[];
}

/**
 * The user's change to a project's webhook. Saving a URL never turns it on; a new URL or format
 * turns it off unless the same change turns it on, which is the user approving that target.
 */
export function saveWebhook(projectId: string, patch: WebhookPatch): WebhookInfo {
  const p = projects.get(projectId);
  if (!p) throw new HttpError(404, 'No such project');
  if (p.workspace) throw new HttpError(400, "A workspace uses its project's webhook; set it on the project");
  const cur = configOf(projectId);
  const url = patch.url !== undefined ? patch.url.trim() : cur?.url;
  if (!url) throw new HttpError(400, 'Enter the webhook URL first');
  const problem = webhookUrlProblem(url);
  if (problem) throw new HttpError(400, problem);
  if (patch.format !== undefined && !isWebhookFormat(patch.format)) throw new HttpError(400, 'The format is slack or feishu');
  const format = patch.format ?? cur?.format ?? 'slack';
  const retargeted = !cur || url !== cur.url || format !== cur.format;
  const enabled = patch.enabled ?? (retargeted ? false : cur.enabled);
  const next = normalizeWebhook({
    url,
    format,
    enabled,
    kinds: patch.kinds ?? cur?.kinds ?? DEFAULT_WEBHOOK_KINDS,
    approvedAt: enabled && (patch.enabled === true || retargeted) ? Date.now() : cur?.approvedAt,
  });
  if (!next) throw new HttpError(400, 'That webhook could not be saved');
  settings.update({ webhooks: { ...settings.get().webhooks, [projectId]: next } });
  log.info(`webhook for ${projectId}: ${maskUrl(url).host}, ${format}, ${enabled ? `on (${next.kinds.join(', ') || 'no kinds'})` : 'off'}`);
  return webhookInfo(projectId);
}

export function deleteWebhook(projectId: string): WebhookInfo {
  const { [projectId]: _gone, ...rest } = settings.get().webhooks || {};
  settings.update({ webhooks: rest });
  deliveries.delete(projectId);
  return webhookInfo(projectId);
}

/** The line a notification carries. */
export function notificationText(m: { project: string; chat: string; speaker: string; kind: ReplyKind | 'test'; text: string }): string {
  const label = m.kind === 'test' ? 'Test' : KIND_LABEL[m.kind];
  return `${label} · ${m.speaker} in "${m.chat}" (${m.project}):\n${m.text}`;
}

/** The JSON body each service expects for a plain text message. */
export function webhookPayload(format: WebhookFormat, text: string): unknown {
  return format === 'feishu' ? { msg_type: 'text', content: { text } } : { text };
}

function record(projectId: string, d: WebhookDelivery) {
  deliveries.set(projectId, [d, ...(deliveries.get(projectId) ?? [])].slice(0, KEEP_DELIVERIES));
}

async function post(c: WebhookConfig, text: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(c.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(webhookPayload(c.format, text)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    // Feishu answers 200 with a non-zero code when it refuses a message.
    let refused: string | undefined;
    if (res.ok && c.format === 'feishu') {
      const j = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
      if (j && typeof j.code === 'number' && j.code !== 0) refused = `Feishu refused it (code ${j.code}${j.msg ? `: ${j.msg}` : ''})`;
    }
    if (!res.ok || refused) return { ok: false, status: res.status, error: refused || `The webhook answered ${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'The webhook did not answer in 5 s' : (e as Error).message };
  }
}

/** The user's "Send test": a fixed line, whether or not the webhook is on. */
export async function testWebhook(projectId: string): Promise<WebhookDelivery> {
  const c = configOf(projectId);
  const p = projects.get(projectId);
  if (!c || !p) throw new HttpError(400, 'No webhook is set for this project');
  const text = notificationText({ project: p.name, chat: 'Crew', speaker: 'Crew', kind: 'test', text: "This project's Router notifications will arrive here." });
  const r = await post(c, text);
  const d: WebhookDelivery = { at: Date.now(), kind: 'test', ok: r.ok, status: r.status, error: r.error, text };
  record(projectId, d);
  return d;
}

/** What a Router reply would send, or null when it would send nothing (off, kind not approved, nothing left). */
export function plannedNotification(chat: Chat, msg: ChatMessage): { projectId: string; config: WebhookConfig; text: string } | null {
  const kind = msg.channel?.kind;
  if (!msg.router || !kind) return null;
  const project = rootProject(chat.projectId);
  const config = project && configOf(project.id);
  if (!project || !config?.enabled || !config.kinds.includes(kind)) return null;
  // Only the reply's own words, filtered again; never its details (Worker reports) or anything else.
  const body = webhookText(msg.text);
  if (!body) return null;
  const speaker = bots.get(msg.botId)?.name || 'Crew';
  return { projectId: project.id, config, text: notificationText({ project: project.name, chat: chat.title, speaker, kind, text: body }) };
}

/** A Router reply was posted: sends it when the chat's project has an enabled webhook for its kind. Never throws. */
export async function notifyRouterReply(chat: Chat, msg: ChatMessage): Promise<void> {
  const plan = plannedNotification(chat, msg);
  if (!plan) return;
  const r = await post(plan.config, plan.text);
  record(plan.projectId, { at: Date.now(), kind: msg.channel?.kind ?? 'decision', chatId: chat.id, messageId: msg.id, ok: r.ok, status: r.status, error: r.error, text: plan.text });
  if (!r.ok) log.warn(`webhook for ${plan.projectId} failed: ${r.error}`);
}
