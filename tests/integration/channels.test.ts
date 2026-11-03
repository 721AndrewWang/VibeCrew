// Channel norms (ADR 103) end to end in demo mode: the Router's replies carry their kind and the
// Worker reports behind them as Details; a project's webhook is off until the user turns it on,
// sends only the approved kinds, never the URL back to the UI and never anything but the reply.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, startServer, waitFor } from '../helpers/server';

interface Received {
  url: string;
  body: any;
}

/** A stand-in for Slack or Feishu: records what is posted to it. */
async function startReceiver(status = 200): Promise<{ url: string; got: Received[]; close(): Promise<void> }> {
  const got: Received[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      got.push({ url: req.url || '', body: JSON.parse(raw || '{}') });
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/services/T000/B000/s3cret-path`, got, close: () => new Promise((r) => server.close(() => r())) };
}

describe('channel norms (demo mode)', () => {
  let crew: CrewServer;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let group: any;
  let projectId: string;

  const replies = async (seq: number, n: number) =>
    waitFor(async () => {
      const list = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.filter((m: any) => m.seq > seq && m.router);
      return list.length >= n ? list : null;
    }, 40_000);

  beforeAll(async () => {
    receiver = await startReceiver();
    crew = await startServer();
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    projectId = group.projectId;
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true } } });
  });
  afterAll(async () => {
    await crew?.stop();
    await receiver?.close();
  });

  it('keeps the webhook off until the user turns it on, and never shows its URL again', async () => {
    expect(await crew.api('GET', `/projects/${projectId}/webhook`)).toMatchObject({ configured: false, enabled: false, kinds: ['question', 'acceptance'], deliveries: [] });
    const saved = await crew.api('PUT', `/projects/${projectId}/webhook`, { url: receiver.url });
    expect(saved).toMatchObject({ configured: true, enabled: false, format: 'slack', host: new URL(receiver.url).host, masked: `http://${new URL(receiver.url).host}/services/…` });
    expect(JSON.stringify(saved)).not.toContain('s3cret-path');
    expect(JSON.stringify(await crew.api('GET', '/bootstrap'))).not.toContain('s3cret-path');
    expect((await crew.api('PUT', `/projects/${projectId}/webhook`, { url: 'ftp://nope' })).status).toBe(400);
    expect((await crew.api('PUT', `/projects/${group.id}/webhook`, { url: receiver.url })).status).toBe(404);

    // A message while it is off: nothing goes out.
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Build a pricing page' });
    await replies(sent.seq, 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(receiver.got).toEqual([]);

    // The test button posts a fixed line, on the user's click.
    const t = await crew.api('POST', `/projects/${projectId}/webhook/test`);
    expect(t.delivery).toMatchObject({ kind: 'test', ok: true, status: 200 });
    expect(receiver.got).toHaveLength(1);
    expect(receiver.got[0].url).toBe('/services/T000/B000/s3cret-path');
    expect(receiver.got[0].body.text).toMatch(/^Test · Crew in "Crew" \(.+\):\nThis project's Router notifications will arrive here\.$/);
  });

  it('gives each Router reply a kind, and attaches the Worker report behind it as Details', async () => {
    const all = (await crew.api('GET', `/chats/${group.id}/messages?limit=200`)).messages.filter((m: any) => m.router);
    const [ack, done] = all;
    expect(ack.channel).toEqual({ kind: 'decision' });
    expect(ack.text).toMatch(/^On it\. Started wk_/);
    expect(done.text).toContain('finished: "Build a pricing page"');
    expect(done.channel.kind).toBe('acceptance');
    const w = (await crew.api('GET', `/workers?chatId=${group.id}`)).items[0];
    expect(done.channel.details).toEqual([
      {
        workerId: w.id,
        title: 'Build a pricing page',
        bot: expect.any(String),
        status: 'done',
        // The report's first sentences, within 30 words.
        gist: expect.stringMatching(/^Got it! I'm \w+ \(demo mode, no model called\)\. Let me look at the project structure first\. Done\.$/),
        report: w.report.text,
        landing: expect.stringMatching(/^Crew merged its changes into /),
        at: w.report.at,
      },
    ]);
    // The Router's own log says the report went under Details.
    const log = (await crew.api('GET', `/chats/${group.id}/router/messages`)).messages;
    expect(JSON.stringify(log.at(-1).parts)).toContain(`${w.id}'s full report under Details`);
  });

  it('sends only the kinds the user approved, as the reply text alone', async () => {
    const on = await crew.api('PUT', `/projects/${projectId}/webhook`, { enabled: true, kinds: ['acceptance'] });
    expect(on).toMatchObject({ enabled: true, kinds: ['acceptance'], approvedAt: expect.any(Number) });
    const before = receiver.got.length;
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Make an about page' });
    const [ack, done] = await replies(sent.seq, 2);
    expect(ack.channel.kind).toBe('decision');
    expect(done.channel.kind).toBe('acceptance');
    await waitFor(() => receiver.got.length > before || null);
    await new Promise((r) => setTimeout(r, 500));
    const posted = receiver.got.slice(before);
    // The decision ("On it") stayed in the chat; the acceptance request went out, without the report.
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toEqual({ text: expect.stringMatching(/^Ready for your OK · \w+ in ".+" \(.+\):\n.*finished: "Make an about page"/) });
    expect(posted[0].body.text).not.toContain('demo mode I only looked around');
    const info = await crew.api('GET', `/projects/${projectId}/webhook`);
    expect(info.deliveries[0]).toMatchObject({ kind: 'acceptance', ok: true, chatId: group.id, messageId: done.id });
  });

  it('turns itself off when the target changes, and speaks Feishu once approved again', async () => {
    const moved = await crew.api('PUT', `/projects/${projectId}/webhook`, { format: 'feishu' });
    expect(moved).toMatchObject({ enabled: false, format: 'feishu' });
    const before = receiver.got.length;
    const sent = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Create a contact page' });
    await replies(sent.seq, 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(receiver.got.length).toBe(before);

    await crew.api('PUT', `/projects/${projectId}/webhook`, { enabled: true, kinds: ['acceptance', 'decision'] });
    const again = await crew.api('POST', `/chats/${group.id}/messages`, { text: 'Create a careers page' });
    await replies(again.seq, 2);
    await waitFor(() => (receiver.got.length >= before + 2 ? true : null));
    const posted = receiver.got.slice(before);
    expect(posted.map((p) => p.body.msg_type)).toEqual(['text', 'text']);
    expect(posted[0].body.content.text).toMatch(/^Update · /);
    expect(posted[1].body.content.text).toMatch(/^Ready for your OK · /);

    expect(await crew.api('DELETE', `/projects/${projectId}/webhook`)).toMatchObject({ configured: false, enabled: false });
  });

  it('dry-runs a profile on a text', async () => {
    expect((await crew.api('POST', '/channels/check', { profile: 'chat', text: 'Done:\n```\nok\n```' })).refusal).toMatch(/a code block/);
    const pr = await crew.api('POST', '/channels/check', { profile: 'pull-request', text: `## Summary\nFix.\n\n\n## Testing\n${'```'}\n${'ok\n'.repeat(20)}${'```'}` });
    expect(pr.refusal).toBeNull();
    expect(pr.shaped).toContain('<details><summary>Output (20 lines)</summary>');
  });
});
