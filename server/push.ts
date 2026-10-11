// A bot waiting on an approval stops the whole chain until someone answers, and a desktop
// notification does not reach a user who is away from the computer. When a request is still open
// after a few minutes, a push goes to the user's phone through Bark (an iOS push app with a URL
// per device). The push names who is waiting and the short action title, never the command.

import { logger } from './log';
import { settings } from './store';

const log = logger('push');

/** "https://api.day.app/<key>" or a self-hosted Bark server with the same shape. */
export function barkUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length === 1;
  } catch {
    return false;
  }
}

export async function sendBark(url: string, title: string, body: string): Promise<void> {
  if (!barkUrlOk(url)) throw new Error("That Bark URL doesn't look right; it should look like https://api.day.app/your-key");
  const res = await fetch(url.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title, body, group: 'Crew', level: 'timeSensitive' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bark returned ${res.status}`);
}

export function approvalPushText(botName: string, chatTitle: string, action: string, minutes: number) {
  return { title: `${botName} is waiting for your approval`, body: `Waiting ${minutes} min in "${chatTitle}": ${action}` };
}

/**
 * Pushes to the phone if the approval is still open after the configured delay. Returns a
 * function that cancels it; call it once the request is answered or expires.
 */
export function remindLater(botName: string, chatTitle: string, action: string): () => void {
  const { barkUrl, afterMinutes } = settings.get().push || { barkUrl: '', afterMinutes: 0 };
  if (!barkUrl || !afterMinutes) return () => {};
  const timer = setTimeout(() => {
    const { title, body } = approvalPushText(botName, chatTitle, action, afterMinutes);
    sendBark(settings.get().push?.barkUrl || '', title, body).catch((e) => log.warn('bark push failed:', (e as Error).message));
  }, afterMinutes * 60_000);
  timer.unref?.();
  return () => clearTimeout(timer);
}
