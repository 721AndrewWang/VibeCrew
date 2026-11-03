// Model calls in the bench (ADR 101). Every session keeps an Anthropic-shaped conversation and asks
// a ModelClient for its next step. The answer has the mock provider's shape (tests/helpers/
// mockProvider.ts): text, or one tool call. The scripted policy can be called in process, or put
// behind the mock provider and reached over HTTP, and both must give the same run.

import { estimateTokens } from '../recall/spill';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export type Role = 'router' | 'worker' | 'lead' | 'subtask' | 'filter' | 'speculative';

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  /** Names of the tools on offer. */
  tools: string[];
}

/** Exactly the mock provider's Reply. */
export type Reply = { text: string } | { tool: { id: string; name: string; input: Record<string, unknown> } };

export type Policy = (req: ModelRequest) => Reply;

export interface ModelClient {
  call(req: ModelRequest): Promise<Reply>;
}

export function inProcessClient(policy: Policy): ModelClient {
  return { call: async (req) => policy(req) };
}

/**
 * An Anthropic-compatible endpoint (the mock provider in tests). One call at a time, in the order
 * they were made, so the order their answers come back in never depends on the network.
 */
export function httpClient(url: string, token: string): ModelClient & { calls: number } {
  let chain: Promise<unknown> = Promise.resolve();
  const client = {
    calls: 0,
    call(req: ModelRequest): Promise<Reply> {
      const run = async (): Promise<Reply> => {
        client.calls++;
        const res = await fetch(`${url.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: req.model,
            max_tokens: 1024,
            system: req.system,
            messages: req.messages,
            tools: req.tools.map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
            stream: false,
          }),
        });
        if (!res.ok) throw new Error(`model endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const body = (await res.json()) as { content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] };
        const tool = body.content?.find((c) => c.type === 'tool_use');
        if (tool) return { tool: { id: String(tool.id), name: String(tool.name), input: tool.input || {} } };
        return { text: (body.content || []).map((c) => c.text || '').join('') };
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
  };
  return client;
}

/** What the mock provider records of a request: enough to rebuild the ModelRequest. */
export interface MockLikeRequest {
  model?: string;
  tools: string[];
  body: { system?: unknown; messages?: Message[] };
}

const systemText = (s: unknown): string =>
  typeof s === 'string' ? s : Array.isArray(s) ? s.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '';

/** The policy as a mock provider `reply` function. */
export function mockReply(policy: Policy): (r: MockLikeRequest) => Reply {
  return (r) => policy({ model: r.model || '', system: systemText(r.body.system), messages: r.body.messages || [], tools: r.tools });
}

// ---------------------------------------------------------------- tokens and latency

export function blockText(b: Block): string {
  if (b.type === 'text') return b.text;
  if (b.type === 'tool_result') return b.content;
  return `${b.name} ${JSON.stringify(b.input)}`;
}

export function messageText(m: Message): string {
  return typeof m.content === 'string' ? m.content : m.content.map(blockText).join('\n');
}

export function replyTokens(r: Reply): number {
  return 'text' in r ? estimateTokens(r.text) : estimateTokens(`${r.tool.name} ${JSON.stringify(r.tool.input)}`) + 10;
}

/** How long a model call takes, in virtual milliseconds: a linear model, stated in every result. */
export interface LatencyModel {
  overheadMs: number;
  /** Per token of context the call re-reads (the cached prefix). */
  readMsPerToken: number;
  /** Per token new since the session's last call. */
  newMsPerToken: number;
  /** Per output token. */
  outMsPerToken: number;
  /** Multiplies the whole call per role: the Router and the event filter run on lighter models. */
  roleFactor: Record<Role, number>;
}

export const DEFAULT_LATENCY: LatencyModel = {
  overheadMs: 700,
  readMsPerToken: 0.01,
  newMsPerToken: 0.25,
  outMsPerToken: 25,
  roleFactor: { router: 0.6, worker: 1, lead: 1, subtask: 1, filter: 0.3, speculative: 1 },
};

export function callLatency(m: LatencyModel, role: Role, t: { read: number; fresh: number; out: number }): number {
  return Math.round((m.overheadMs + t.read * m.readMsPerToken + t.fresh * m.newMsPerToken + t.out * m.outMsPerToken) * m.roleFactor[role]);
}
