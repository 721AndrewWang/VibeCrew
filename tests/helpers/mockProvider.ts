// A stand-in for an Anthropic-compatible model endpoint, for tests that drive the real Claude Code
// CLI: it records what Claude Code sends and answers with text or a scripted tool call.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  url: string;
  model?: string;
  auth: string;
  xApiKey: string;
  stream: boolean;
  /** Names of the tools offered (the main loop offers Bash, Read…; side calls offer none). */
  tools: string[];
  body: any;
}

export type Reply = { text: string } | { tool: { id: string; name: string; input: Record<string, unknown> } };

export interface MockProvider {
  url: string;
  requests: MockRequest[];
  /** Contents of the tool results Claude Code sent back, in order. */
  toolResults: string[];
  close(): Promise<void>;
}

export async function startMockProvider(opts: { token: string; reply?: (req: MockRequest) => Reply }): Promise<MockProvider> {
  const requests: MockRequest[] = [];
  let n = 0;
  const toolResults: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* not JSON */
      }
      const r: MockRequest = {
        url: req.url || '',
        model: body.model,
        auth: String(req.headers.authorization || ''),
        xApiKey: String(req.headers['x-api-key'] || ''),
        stream: !!body.stream,
        tools: (body.tools || []).map((t: { name: string }) => t.name),
        body,
      };
      requests.push(r);
      // Like the real API: every response has its own message id and request id.
      n += 1;
      const msgId = `msg_mock_${n}`;
      const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_mock_${n}` }).end(JSON.stringify(data));
      if (!r.url.startsWith('/v1/messages')) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'nope' } });
      if (r.auth !== `Bearer ${opts.token}`) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid api key (mock)' } });
      if (r.url.startsWith('/v1/messages/count_tokens')) return json(200, { input_tokens: 10 });

      // Claude Code may put a system message after a tool result: look through the whole conversation.
      for (const m of body.messages || []) {
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c.type !== 'tool_result') continue;
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          if (!toolResults.includes(text)) toolResults.push(text);
        }
      }
      const reply = opts.reply?.(r) ?? { text: '连接成功' };
      const block =
        'text' in reply
          ? { start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: reply.text }, final: { type: 'text', text: reply.text } }
          : {
              start: { type: 'tool_use', id: reply.tool.id, name: reply.tool.name, input: {} },
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) },
              final: { type: 'tool_use', ...reply.tool },
            };
      const stop = 'text' in reply ? 'end_turn' : 'tool_use';
      const usage = { input_tokens: 10, output_tokens: 4 };
      if (!r.stream) {
        return json(200, { id: msgId, type: 'message', role: 'assistant', model: body.model, content: [block.final], stop_reason: stop, stop_sequence: null, usage });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_mock_${n}` });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', {
        message: { id: msgId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
      });
      ev('content_block_start', { index: 0, content_block: block.start });
      ev('content_block_delta', { index: 0, delta: block.delta });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 4 } });
      ev('message_stop', {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, toolResults, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
