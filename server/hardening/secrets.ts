// The secrets Crew holds (ADR 104), and the redactors that keep them out of every sink: the server
// log, the audit log, Triggers, stored messages, draft output, and what the UI receives.

import type { NextFunction, Request, Response } from 'express';
import { type Settings, settings } from '../store';
import { BROKER_TOKEN } from './broker';
import { setRedactors } from './redactor';

/** Shorter values are too likely to be ordinary words to replace. */
const MIN_LENGTH = 8;
export const REDACTED = '[redacted]';

/** Every secret in settings.json, and the broker's token. `ui`: leave out what the UI must show. */
export function secretValues(s: Settings, opts: { ui?: boolean } = {}): string[] {
  const out = [s.apiKey, s.providerToken, ...Object.values(s.gatewayTokens || {}), ...Object.values(s.pluginSecrets || {}), BROKER_TOKEN];
  // The phone-access link carries the LAN token: Settings → Phone access shows it on purpose.
  if (!opts.ui) out.push(s.token);
  // A Bark URL holds the device key: https://api.day.app/<key>/…
  const bark = s.push?.barkUrl;
  if (bark) {
    out.push(bark);
    try {
      out.push(...new URL(bark).pathname.split('/').filter((p) => p.length >= MIN_LENGTH));
    } catch {
      /* not a URL */
    }
  }
  return [...new Set(out.filter((v): v is string => typeof v === 'string' && v.trim().length >= MIN_LENGTH).map((v) => v.trim()))].sort((a, b) => b.length - a.length);
}

/** A redactor for these values: each one, raw and JSON-escaped, becomes [redacted]. */
export function redactorFor(values: string[]): (text: string) => string {
  const forms = [...new Set(values.filter((v) => v.length >= MIN_LENGTH).flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  return (text: string) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join(REDACTED);
    return out;
  };
}

/** Rebuilt only when the settings object changes (every update replaces it). */
let cache: { for: Settings; all: (t: string) => string; ui: (t: string) => string } | null = null;

function current() {
  const s = settings.get();
  if (cache?.for !== s) cache = { for: s, all: redactorFor(secretValues(s)), ui: redactorFor(secretValues(s, { ui: true })) };
  return cache;
}

/** Installs the redactors for the whole server; called once at start. */
export function installRedaction() {
  setRedactors(
    (t) => current().all(t),
    (t) => current().ui(t),
  );
}

/** Express middleware: every JSON answer of the API goes out without secrets. */
export function redactResponses(_req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body === undefined) return json(body);
    const text = current().ui(JSON.stringify(body));
    if (!res.get('content-type')) res.type('application/json');
    return res.send(text);
  };
  next();
}
