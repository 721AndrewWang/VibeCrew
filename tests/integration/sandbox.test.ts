// The sandbox is the boundary the deny list cannot be: a command inside it reaches only the
// allowed hosts, whatever it is called, and the bot cannot step outside it. Needs the real
// Claude Code CLI plus bubblewrap and socat; skipped where they are missing.
//
// Inside, everything goes through Claude Code's proxy, which holds the allow list, except that
// the sandbox's own no_proxy sends loopback and private addresses direct, where nothing answers.
// So this machine and the LAN are reached with `env -u no_proxy -u NO_PROXY`, as the bots are told.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProvider, startMockProvider } from '../helpers/mockProvider';
import { type CrewServer, claudeCli, startServer, waitTurn } from '../helpers/server';

const TOKEN = 'mock-secret-token';
/** What a bot prefixes to reach this machine or the LAN from inside the sandbox. */
const LOCAL = 'env -u no_proxy -u NO_PROXY';

/** This machine's first non-loopback IPv4: a host the sandbox treats as "elsewhere". */
function lanIp(): string | null {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

const ip = lanIp();

describe.skipIf(!claudeCli() || !ip)('the sandbox', () => {
  let mock: MockProvider;
  let crew: CrewServer;
  let target: http.Server;
  let targetUrl: string;
  let chatId: string;
  let projectId: string;
  const hits: string[] = [];
  let script: { id: string; name: string; input: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    // Something to reach: a tiny server on every interface, addressed by the LAN IP.
    target = http.createServer((req, res) => {
      hits.push(req.url || '');
      res.end('pong');
    });
    await new Promise<void>((r) => target.listen(0, '0.0.0.0', r));
    targetUrl = `http://${ip}:${(target.address() as AddressInfo).port}`;
    mock = await startMockProvider({
      token: TOKEN,
      // The model runs the scripted tool calls one by one, then stops.
      // Earlier turns' tool results come back with every request (the session resumes), so only
      // the current script's markers count.
      reply: (r) => {
        const next = script[done().length];
        return r.tools.includes('Bash') && next ? { tool: next } : { text: 'OK, that is it.' };
      },
    });
    crew = await startServer({ fakeAgent: false });
    await crew.api('PATCH', '/settings', {
      authMode: 'provider',
      provider: { preset: 'custom', baseUrl: mock.url, model: 'mock-model', fastModel: 'mock-fast' },
      providerToken: TOKEN,
      sandbox: { enabled: true, allowedDomains: [] },
    });
    const b = await crew.api('GET', '/bootstrap');
    const chief = b.bots.find((x: any) => x.name === 'Chief');
    chatId = b.chats.find((c: any) => c.kind === 'dm' && c.botIds[0] === chief.id).id;
    projectId = b.projects[0].id;
    await crew.api('PATCH', `/chats/${chatId}`, { permission: 'auto' });
  });
  afterAll(async () => {
    await crew?.stop();
    await mock?.close();
    target?.close();
  });

  /** Results of the current script's steps, in order, matched by tool call id: a step refused before
   *  it runs (Crew's command guard) never prints its marker, and must still count as done. */
  const done = () => script.map((st) => mock.toolResultsById.get(st.id)).filter((t): t is string => !!t);

  const run = async (steps: typeof script, text: string) => {
    script = steps;
    hits.length = 0;
    const sent = await crew.api('POST', `/chats/${chatId}/messages`, { text });
    const reply = await waitTurn(crew.api, chatId, sent.seq, 180_000);
    expect(reply.status).toBe('done');
    return done();
  };

  it('reports whether it can run here', async () => {
    const s = await crew.api('GET', '/sandbox');
    expect(typeof s.available).toBe('boolean');
    if (!s.available) console.warn(`sandbox unavailable here: ${s.hint}`);
  });

  it('blocks a host that is not allowed, even when the bot tries to leave the sandbox', async ({ skip }) => {
    if (!(await crew.api('GET', '/sandbox')).available) skip();
    const results = await run(
      [
        { id: 'toolu_sb1', name: 'Bash', input: { command: `echo sb-1; ${LOCAL} curl -sS -m 8 ${targetUrl}/one || echo blocked`, description: 'Reach the server' } },
        { id: 'toolu_sb2', name: 'Bash', input: { command: `echo sb-2; ${LOCAL} curl -sS -m 8 ${targetUrl}/two || echo blocked`, description: 'Try again outside', dangerouslyDisableSandbox: true } },
      ],
      'Go check that server',
    );
    expect(results).toHaveLength(2);
    expect(hits).toEqual([]);
    // Crew's command guard refuses the host before the command runs (ADR 104); were it to let one
    // through, the sandbox's own allow list must still refuse it.
    for (const r of results) {
      expect(r).not.toContain('pong');
      expect(r).toMatch(/Blocked by Crew's command guard: .*not on the allow-list|deny network-outbound .*host is not on the allow list/);
    }
  });

  it('reaches a host once the project allows it', async ({ skip }) => {
    if (!(await crew.api('GET', '/sandbox')).available) skip();
    expect((await crew.api('PATCH', `/projects/${projectId}`, { allowedDomains: [`${ip}`, 'nonsense host'] })).allowedDomains).toEqual([ip]);
    const results = await run([{ id: 'toolu_sb3', name: 'Bash', input: { command: `echo sb-3; ${LOCAL} curl -sS -m 8 ${targetUrl}/three`, description: 'Reach the server' } }], 'Look again');
    // Crew's part: the guard lets an allowed host through, and the restarted session hands it to the sandbox.
    expect(results[0]).toContain('sb-3');
    expect(results[0]).not.toContain("Blocked by Crew's command guard");
    // Whether the sandbox then routes a private address is Claude Code's part, and newer versions
    // refuse private addresses even when listed. Report that instead of failing on it.
    if (!results[0].includes('pong') && /Network is unreachable|Couldn't connect|Failed to connect|deny network-outbound|blocked by network allowlist/i.test(results[0])) {
      console.warn(`this Claude Code's sandbox does not route an allowed private address: ${results[0].split('\n').slice(-2).join(' ')}`);
      expect(hits).toEqual([]);
      skip();
    }
    expect(results[0]).toContain('pong');
    expect(hits).toEqual(['/three']);
  });

  it('still lets the bot talk to this machine', async ({ skip }) => {
    if (!(await crew.api('GET', '/sandbox').then((s) => s.available))) skip();
    // Not Crew's own API: the command guard refuses that to agents on purpose (ADR 104).
    const local = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const results = await run([{ id: 'toolu_sb4', name: 'Bash', input: { command: `echo sb-4; ${LOCAL} curl -sS -m 8 ${local}/four`, description: 'Ask the local server' } }], 'And this machine?');
    expect(results[0]).toContain('sb-4');
    expect(results[0]).not.toContain("Blocked by Crew's command guard");
    if (!results[0].includes('pong') && /Network is unreachable|Couldn't connect|Failed to connect|deny network-outbound|blocked by network allowlist/i.test(results[0])) {
      console.warn(`this Claude Code's sandbox does not reach this machine: ${results[0].split('\n').slice(-2).join(' ')}`);
      expect(hits).toEqual([]);
      skip();
    }
    expect(results[0]).toContain('pong');
    expect(hits).toEqual(['/four']);
  });
});
