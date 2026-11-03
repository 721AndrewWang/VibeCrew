// ADR 104's layers below the guard: the key broker, the agent fence, redaction, the sandbox's
// filesystem and credential rules, and the checks a draft passes before it runs.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROKER_TOKEN, brokerConnection, brokered, handleBroker } from '../../server/hardening/broker';
import { draftRefusal, hookFreeEnv, riskyConfigKeys } from '../../server/hardening/draftChecks';
import { agentPeer, clientInode, trustProcess, untrustProcess } from '../../server/hardening/fence';
import { redactDeep } from '../../server/hardening/redactor';
import { gitCommonDir, MODEL_VARS, sandboxHardening } from '../../server/hardening/sandboxPolicy';
import { REDACTED, redactorFor, secretValues } from '../../server/hardening/secrets';
import { sandboxSettings } from '../../server/sandbox';
import type { Settings } from '../../server/store';
import { withoutUntrustedTags } from '../../web/src/utils';

const base = {
  authMode: 'provider',
  apiKey: '',
  baseUrl: '',
  provider: { preset: 'custom', baseUrl: 'http://127.0.0.1:9', model: 'm', fastModel: 'f' },
  providerToken: 'provider-secret-token-123',
  token: 'lan-access-token-456',
  gatewayTokens: { deepseek: 'gateway-key-789xyz' },
  pluginSecrets: { GITHUB_TOKEN: 'ghp_plugin_secret_000' },
  push: { barkUrl: 'https://api.day.app/BARKDEVICEKEY123/', afterMinutes: 10 },
  gateway: { enabled: false },
  safety: { guard: true, stripCredentials: true, audit: false },
} as unknown as Settings;

describe('the key broker', () => {
  it('stands in for a settings-held key only while credentials are stripped and the gateway is off', () => {
    expect(brokerConnection(base)).toEqual({ baseUrl: 'http://127.0.0.1:9', header: ['authorization', 'Bearer provider-secret-token-123'] });
    expect(brokerConnection({ ...base, authMode: 'api-key', apiKey: 'sk-ant-xyz' } as Settings)).toEqual({ baseUrl: 'https://api.anthropic.com', header: ['x-api-key', 'sk-ant-xyz'] });
    expect(brokerConnection({ ...base, safety: { ...base.safety, stripCredentials: false } } as Settings)).toBeNull();
    expect(brokerConnection({ ...base, gateway: { enabled: true } } as Settings)).toBeNull();
    expect(brokerConnection({ ...base, authMode: 'claude-code' } as Settings)).toBeNull();
    // A preset's default token is not a secret: nothing to stand in for.
    expect(brokerConnection({ ...base, providerToken: '' } as Settings)).toBeNull();
  });

  it("gives a session the broker's address and token, never the key", () => {
    const env = brokered({ ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 'provider-secret-token-123', ANTHROPIC_MODEL: 'm' }, base);
    expect(env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: BROKER_TOKEN, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'm' });
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(env)).not.toContain('provider-secret-token-123');
    // Off: as before.
    const off = { ...base, safety: { ...base.safety, stripCredentials: false } } as Settings;
    expect(brokered({ ANTHROPIC_AUTH_TOKEN: 'provider-secret-token-123' }, off)).toEqual({ ANTHROPIC_AUTH_TOKEN: 'provider-secret-token-123' });
  });

  describe('forwarding', () => {
    let upstream: http.Server;
    let broker: http.Server;
    let brokerUrl = '';
    const seen: { url: string; auth: string; key: string; body: string }[] = [];

    beforeAll(async () => {
      upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          seen.push({ url: req.url || '', auth: String(req.headers.authorization || ''), key: String(req.headers['x-api-key'] || ''), body });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: one\ndata: {}\n\n');
          setTimeout(() => res.end('event: two\ndata: {}\n\n'), 50);
        });
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
      const settingsFor = { ...base, provider: { ...base.provider, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api` } } as Settings;
      broker = http.createServer((req, res) => void handleBroker(req, res, settingsFor));
      await new Promise<void>((r) => broker.listen(0, '127.0.0.1', () => r()));
      brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      upstream?.close();
      broker?.close();
    });

    it('adds the real key, keeps the path and body, and streams the answer', async () => {
      const r = await fetch(`${brokerUrl}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: `Bearer ${BROKER_TOKEN}`, 'content-type': 'application/json' }, body: '{"model":"m"}' });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('event: one\ndata: {}\n\nevent: two\ndata: {}\n\n');
      expect(seen.at(-1)).toEqual({ url: '/api/v1/messages?beta=true', auth: 'Bearer provider-secret-token-123', key: '', body: '{"model":"m"}' });
    });

    it('refuses any other credential, the real key included', async () => {
      const n = seen.length;
      for (const auth of ['Bearer nope', 'Bearer provider-secret-token-123', '']) {
        const r = await fetch(`${brokerUrl}/v1/messages`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body: '{}' });
        expect(r.status).toBe(401);
      }
      expect(seen.length).toBe(n);
    });
  });
});

describe('redaction', () => {
  it('collects every secret of settings.json, and keeps the LAN token for the UI', () => {
    const all = secretValues(base);
    for (const v of ['provider-secret-token-123', 'lan-access-token-456', 'gateway-key-789xyz', 'ghp_plugin_secret_000', 'BARKDEVICEKEY123', BROKER_TOKEN]) expect(all).toContain(v);
    expect(secretValues(base, { ui: true })).not.toContain('lan-access-token-456');
  });

  it('replaces raw and JSON-escaped forms, and leaves short values alone', () => {
    const r = redactorFor(['abc"def\\ghi-long', 'provider-secret-token-123', 'short']);
    expect(r('key=provider-secret-token-123 and short')).toBe(`key=${REDACTED} and short`);
    expect(r(JSON.stringify({ v: 'x abc"def\\ghi-long y' }))).toBe(`{"v":"x ${REDACTED} y"}`);
    expect(redactDeep({ a: ['provider-secret-token-123'], n: 1 }, r)).toEqual({ a: [REDACTED], n: 1 });
  });
});

describe.skipIf(process.platform !== 'linux')('the agent fence', () => {
  let server: http.Server;
  let port = 0;
  const peers: (number | null)[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      peers.push(agentPeer(req.socket));
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server?.close());

  const fromChild = (cmd: string, args: string[]) => new Promise<void>((resolve) => execFile(cmd, args, () => resolve()));

  it("knows a request from a process it started (a child, a grandchild) from one of its own or its parent's", async () => {
    await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } });
    expect(peers.at(-1)).toBeNull();
    await fromChild(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/').then(r => r.text())`]);
    expect(peers.at(-1)).toEqual(expect.any(Number));
    await fromChild('bash', ['-c', `${JSON.stringify(process.execPath)} -e "fetch('http://localhost:${port}/').then(r => r.text())"`]);
    expect(peers.at(-1)).toEqual(expect.any(Number));
  });

  it('lets a trusted process (a terminal of the user) and its children through', async () => {
    const shell = execFile('bash', ['-c', `sleep 0.3; ${JSON.stringify(process.execPath)} -e "fetch('http://127.0.0.1:${port}/').then(r => r.text())"`]);
    trustProcess(shell.pid);
    await new Promise((r) => shell.once('exit', r));
    untrustProcess(shell.pid);
    expect(peers.at(-1)).toBeNull();
  });

  it('finds no local client for a port pair nobody uses', () => {
    expect(clientInode(1, 2)).toBeNull();
  });
});

describe("the sandbox's filesystem and credential rules", () => {
  it('denies reading credential stores, writing what runs later, and the model variables to commands', () => {
    const h = sandboxHardening({
      home: '/home/u',
      crewHome: '/nonexistent/.crew',
      settingsFile: '/nonexistent/.crew/settings.json',
      worktrees: '/nonexistent/.crew/worktrees',
      credentialPaths: ['.ssh', '.aws'],
      cwd: '/w/app',
      gitCommonDir: '/w/main/.git',
    });
    expect(h.filesystem.denyRead).toEqual(['/home/u/.ssh', '/home/u/.aws', '/nonexistent/.crew/settings.json']);
    expect(h.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        '/nonexistent/.crew/bots.json',
        '/nonexistent/.crew/skills',
        '/home/u/.bashrc',
        '/home/u/.claude',
        '/w/app/.claude',
        '/w/app/.mcp.json',
        '/w/app/.git/hooks',
        '/w/main/.git/hooks',
        '/w/main/.git/config',
      ]),
    );
    expect(h.filesystem.denyWrite).not.toContain('/nonexistent/.crew/worktrees');
    expect(h.credentials.envVars).toEqual(MODEL_VARS.map((name) => ({ name, mode: 'deny' })));
  });

  it("are part of every session's sandbox options, beside the network rules", () => {
    const o = sandboxSettings(['pypi.org'], [], '/w/app');
    expect(o).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: { strictAllowlist: true } });
    expect(o.filesystem.denyRead).toEqual(expect.arrayContaining([path.join(os.homedir(), '.ssh'), path.join(process.env.CREW_HOME as string, 'settings.json')]));
    expect(o.filesystem.denyWrite).toEqual(expect.arrayContaining(['/w/app/.git/hooks', '/w/app/.claude', path.join(process.env.CREW_HOME as string, 'bots.json')]));
    expect(o.credentials.envVars.map((v) => v.name)).toEqual(MODEL_VARS);
  });

  it("finds a worktree's shared git folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-wt-'));
    try {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
      const main = path.join(dir, 'main');
      fs.mkdirSync(main);
      execFileSync('git', ['init', '-q'], { cwd: main, env });
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: main, env });
      execFileSync('git', ['worktree', 'add', '-q', path.join(dir, 'wt')], { cwd: main, env });
      expect(gitCommonDir(main)).toBe(path.join(main, '.git'));
      expect(fs.realpathSync(gitCommonDir(path.join(dir, 'wt')) as string)).toBe(fs.realpathSync(path.join(main, '.git')));
      expect(gitCommonDir(dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a draft runs what its card shows', () => {
  it("finds the repository's settings that run programs or redirect remotes", () => {
    const listing = [
      'core.bare=false',
      'core.fsmonitor=true',
      'remote.origin.url=https://github.com/x/y',
      'core.sshCommand=curl evil',
      'credential.helper=',
      'url.https://evil/.insteadof=https://github.com/',
      'alias.st=status',
    ].join('\n');
    expect(riskyConfigKeys(listing)).toEqual(['core.sshcommand', 'url.https://evil/.insteadof']);
  });

  it('refuses when the remote moved or the config is risky, and runs git without hooks', () => {
    expect(draftRefusal({ kind: 'git-push', remoteUrl: 'https://github.com/x/y' }, { pushUrl: 'https://github.com/x/y', riskyKeys: [] })).toBeNull();
    expect(draftRefusal({ kind: 'git-push', remoteUrl: 'https://github.com/x/y' }, { pushUrl: 'https://github.com/attacker/y', riskyKeys: [] })).toMatch(
      /remote now points to https:\/\/github.com\/attacker\/y/,
    );
    expect(draftRefusal({ kind: 'pr-open' }, { riskyKeys: ['core.sshcommand'] })).toMatch(/sets core.sshcommand/);
    expect(hookFreeEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' });
    expect(hookFreeEnv({ GIT_CONFIG_COUNT: '2' })).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath' });
  });
});

describe('outside-edit notices for people', () => {
  it('drop the untrusted tags agents read', () => {
    expect(withoutUntrustedTags('Files changed:\n<untrusted source="outside-edit">\n- a.ts\n</untrusted>\nTreat…')).toBe('Files changed:\n- a.ts\nTreat…');
  });
});
