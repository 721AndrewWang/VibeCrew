// One simulated agent session (ADR 101): a conversation, a ReAct loop over a ModelClient, and the
// bookkeeping the bench reports. Every model call costs virtual time by the latency model; every
// text put into the context is counted once as injected, and the whole context again as read on
// every call (the cached-read analogue).

import { estimateTokens } from '../recall/spill';
import type { VirtualClock } from './clock';
import { type Block, callLatency, type LatencyModel, type Message, type ModelClient, type Reply, type Role, replyTokens } from './model';

export interface RoleStats {
  sessions: number;
  turns: number;
  calls: number;
  /** New text put into contexts: system prompts, prompts, tool results, deliveries. */
  injected: number;
  /** Context length summed over every call. */
  contextRead: number;
  output: number;
  /** Virtual time spent waiting for model calls, by the latency model. */
  modelMs: number;
}

export const ROLES: Role[] = ['router', 'worker', 'lead', 'subtask', 'filter', 'speculative'];

export function emptyStats(): Record<Role, RoleStats> {
  return Object.fromEntries(ROLES.map((r) => [r, { sessions: 0, turns: 0, calls: 0, injected: 0, contextRead: 0, output: 0, modelMs: 0 }])) as Record<Role, RoleStats>;
}

export interface SessionEnv {
  clock: VirtualClock;
  client: ModelClient;
  latency: LatencyModel;
  stats: Record<Role, RoleStats>;
}

/** What a tool returns: its text, or an error the model reads (a gate's refusal). */
export type ToolResult = string | { error: string };
export type ToolHandler = (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

export interface SessionOptions {
  role: Role;
  model: string;
  system: string;
  /** Tokens the harness adds beside the system prompt (Claude Code's own prompt and tool schemas). */
  overheadTokens?: number;
  handlers: Record<string, ToolHandler>;
  /** After each tool result: text to add beside it (a PostToolUse hook's additionalContext). */
  afterTool?: () => string | null;
  /** Every model answer, once its latency has passed. */
  onReply?: (reply: Reply) => void;
}

export interface TurnResult {
  text: string;
  stopped: boolean;
}

export class SimSession {
  readonly messages: Message[] = [];
  /** Tokens in the context now, system prompt included. */
  tokens: number;
  private fresh: number;
  private stopped = false;
  private wake: (() => void)[] = [];

  constructor(
    private env: SessionEnv,
    readonly o: SessionOptions,
  ) {
    const sys = estimateTokens(o.system) + (o.overheadTokens ?? 0);
    this.tokens = sys;
    this.fresh = sys;
    const s = env.stats[o.role];
    s.sessions++;
    s.injected += sys;
  }

  get role() {
    return this.o.role;
  }

  get isStopped() {
    return this.stopped;
  }

  /** Resolves when the session is stopped: tools that take time race it. */
  stopSignal(): Promise<void> {
    return this.stopped ? Promise.resolve() : new Promise((resolve) => this.wake.push(resolve));
  }

  /** Interrupts the running turn: the current model call or tool ends at once. */
  stop() {
    this.stopped = true;
    for (const f of this.wake.splice(0)) f();
  }

  private add(m: Message, injected: boolean) {
    this.messages.push(m);
    const text = typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'tool_use' ? `${b.name} ${JSON.stringify(b.input)}` : b.type === 'text' ? b.text : b.content)).join('\n');
    const n = estimateTokens(text);
    this.tokens += n;
    if (injected) {
      this.fresh += n;
      this.env.stats[this.o.role].injected += n;
    }
  }

  async turn(prompt: string): Promise<TurnResult> {
    const { clock, client, latency, stats } = this.env;
    const s = stats[this.o.role];
    s.turns++;
    this.add({ role: 'user', content: prompt }, true);
    for (;;) {
      if (this.stopped) return { text: '', stopped: true };
      const read = this.tokens - this.fresh;
      const reply = await clock.track(client.call({ model: this.o.model, system: this.o.system, messages: this.messages, tools: Object.keys(this.o.handlers) }));
      const out = replyTokens(reply);
      s.calls++;
      s.contextRead += this.tokens;
      s.output += out;
      const ms = callLatency(latency, this.o.role, { read, fresh: this.fresh, out });
      s.modelMs += ms;
      await Promise.race([clock.sleep(ms), this.stopSignal()]);
      if (this.stopped) return { text: '', stopped: true };
      this.fresh = 0;
      if ('text' in reply) {
        this.add({ role: 'assistant', content: [{ type: 'text', text: reply.text }] }, false);
        this.o.onReply?.(reply);
        return { text: reply.text, stopped: false };
      }
      this.add({ role: 'assistant', content: [{ type: 'tool_use', id: reply.tool.id, name: reply.tool.name, input: reply.tool.input }] }, false);
      this.o.onReply?.(reply);
      const handler = this.o.handlers[reply.tool.name];
      const result: ToolResult = handler ? await handler(reply.tool.input) : { error: `No such tool: ${reply.tool.name}` };
      if (this.stopped) return { text: '', stopped: true };
      const blocks: Block[] = [
        typeof result === 'string' ? { type: 'tool_result', tool_use_id: reply.tool.id, content: result } : { type: 'tool_result', tool_use_id: reply.tool.id, content: result.error, is_error: true },
      ];
      const note = this.o.afterTool?.();
      if (note) blocks.push({ type: 'text', text: note });
      this.add({ role: 'user', content: blocks }, true);
    }
  }
}
