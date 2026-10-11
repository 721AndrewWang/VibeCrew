import crypto from 'node:crypto';
import type http from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { isTailscaleIp, lanAddress } from './config';
import { settings } from './store';

const COOKIE = 'vc_token';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isLoopback(req: http.IncomingMessage) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function hostname(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}

function isLocalHostname(h: string) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Rejects Host headers other than this machine (guards against DNS rebinding). */
export function hostAllowed(host: string | undefined): boolean {
  const h = hostname(host);
  if (isLocalHostname(h)) return true;
  if (!settings.get().lanEnabled) return false;
  // Tailscale: the tailnet address, or its MagicDNS name (also what `tailscale serve` forwards).
  return h === lanAddress() || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(\.\d+)?$/.test(h) || h.endsWith('.local') || isTailscaleIp(h) || h.endsWith('.ts.net');
}

function tokenOf(req: http.IncomingMessage): string | null {
  const header = req.headers['x-crew-token'];
  if (typeof header === 'string' && header) return header;
  const c = parseCookies(req.headers.cookie)[COOKIE];
  if (c) return c;
  try {
    const t = new URL(req.url || '/', 'http://x').searchParams.get('token');
    if (t) return t;
  } catch {
    /* ignore */
  }
  return null;
}

export function validToken(req: http.IncomingMessage): boolean {
  const t = tokenOf(req);
  return !!t && safeEqual(t, settings.get().token);
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function setCookie(res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(settings.get().token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
}

/** A browser tab (or tool) on this machine talking to its own origin. */
function trustedLocal(req: http.IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return isLoopback(req) && isLocalHostname(hostname(req.headers.host)) && (!site || site === 'same-origin' || site === 'none');
}

/**
 * Requests from this machine to Crew's own origin are trusted; everything else
 * (other devices on the LAN) needs the access token, handed out once via a ?token= link.
 */
export function guard(req: Request, res: Response, next: NextFunction) {
  if (!hostAllowed(req.headers.host)) {
    res.status(403).send('Forbidden host');
    return;
  }
  const isApi = req.path.startsWith('/api/');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    res.status(403).json({ error: 'Cross-site request rejected' });
    return;
  }
  const local = isLoopback(req) && isLocalHostname(hostname(req.headers.host));
  if (validToken(req) || (isApi ? trustedLocal(req) : local)) {
    if (!isApi && req.query.token) {
      setCookie(res);
      const url = new URL(req.originalUrl, 'http://x');
      url.searchParams.delete('token');
      res.redirect(url.pathname + url.search);
      return;
    }
    if (!isApi && local) setCookie(res);
    return next();
  }
  if (isApi) {
    res.status(401).json({ error: 'Access token required' });
    return;
  }
  res
    .status(401)
    .type('html')
    .send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Crew</title><body style="font-family:system-ui;padding:40px;text-align:center"><h2>Access link required</h2><p>On your computer, open Crew\'s Settings → Phone access and scan the QR code or use the link there.</p></body>',
    );
}

export function wsAllowed(req: http.IncomingMessage): boolean {
  return hostAllowed(req.headers.host) && sameOrigin(req) && (validToken(req) || trustedLocal(req));
}
