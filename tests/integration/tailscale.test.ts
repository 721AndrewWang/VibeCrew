// Phone access through Tailscale: a request for the tailnet name is let in only with phone access
// on, and then only with the access token.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer } from '../helpers/server';

let crew: CrewServer;
beforeAll(async () => {
  crew = await startServer();
});
afterAll(() => crew?.stop());

/** GET with a chosen Host header, as a request through the tailnet would carry. */
const get = (p: string, host: string, token?: string) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: crew.port, path: p, headers: { host, ...(token ? { 'x-crew-token': token } : {}) } }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.end();
  });
const token = () => JSON.parse(fs.readFileSync(path.join(crew.home, 'settings.json'), 'utf8')).token as string;
const HOST = 'box.tail1234.ts.net';

describe('Tailscale access', () => {
  it('refuses the tailnet name while phone access is off', async () => {
    expect(await get('/api/bootstrap', HOST, token())).toBe(403);
  });

  it('then lets it in with the token only', async () => {
    await crew.api('PATCH', '/settings', { lanEnabled: true });
    expect(await get('/api/bootstrap', HOST)).toBe(401);
    expect(await get('/api/bootstrap', `${HOST}:${crew.port}`, token())).toBe(200);
    expect(await get('/api/bootstrap', '100.104.164.120', token())).toBe(200);
    expect(await get('/api/bootstrap', 'crew.example.com', token())).toBe(403);
  });
});
