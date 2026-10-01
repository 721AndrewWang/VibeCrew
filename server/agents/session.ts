import fs from 'node:fs';
import path from 'node:path';
import {
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PreToolUseHookInput,
  type Query,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsage, Effort } from '../../shared/types';
import { APP_VERSION, findClaudeExecutable } from '../config';
import { logger } from '../log';

const log = logger('session');

type UserContent = SDKUserMessage['message']['content'];

/** A push-based async iterable feeding user messages into a long-lived query. */
class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }

  end() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export interface TurnHooks {
  onMessage(m: SDKMessage): void;
  canUseTool: CanUseTool;
  beforeEdit(filePath: string | undefined): void;
}

export interface SessionConfig {
  cwd: string;
  model?: string;
  effort?: Effort;
  systemAppend: string;
  resume?: string;
  permissionMode: Options['permissionMode'];
  allowRules: string[];
  askRules: string[];
  /** Refused outright, in every permission mode (checked by a hook too, so auto mode cannot approve them). */
  denyRules?: string[];
  deniedReason?(toolName: string, input: unknown): string | null;
  /** Hide Claude Code's attribution (Co-Authored-By trailers, PR footers) in commits and PRs. */
  attributionOff?: boolean;
  /** Claude Code's command sandbox (see server/sandbox.ts); undefined runs commands unconfined. */
  sandbox?: Options['sandbox'];
  mcpServers: Record<string, McpServerConfig>;
  settingSources: NonNullable<Options['settingSources']>;
  env: Record<string, string>;
}

export interface AgentSession {
  readonly closed: boolean;
  readonly busy: boolean;
  /** Switches Claude Code's permission mode for the turn under way (and after). */
  setPermissionMode?(mode: NonNullable<Options['permissionMode']>): void;
  /** How full the context window is now (null when it cannot tell). */
  contextUsage?(): Promise<Omit<ContextUsage, 'at'> | null>;
  sessionId?: string;
  lastUsed: number;
  run(content: UserContent, hooks: TurnHooks): Promise<SDKResultMessage>;
  interrupt(): Promise<void>;
  close(): void;
}

/**
 * One bot in one chat: a long-lived Claude Code process fed through streaming input.
 * Each run() pushes a user message and resolves on that turn's result.
 */
export class BotSession implements AgentSession {
  private input = new InputQueue<SDKUserMessage>();
  private q: Query;

  setPermissionMode(mode: NonNullable<Options['permissionMode']>) {
    if (!this.closed) void this.q.setPermissionMode(mode).catch(() => {});
  }

  /** The main loop's last API usage and context window, for when Claude Code cannot report /context. */
  private lastUsage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null = null;
  private lastWindow = 0;
  /** The model this session runs on, from Claude Code's init message. */
  private model?: string;

  async contextUsage(): Promise<Omit<ContextUsage, 'at'> | null> {
    if (this.closed) return null;
    try {
      // 'summary' answers from the last response's usage, without extra token-count calls.
      const r = await Promise.race([this.q.getContextUsage({ detail: 'summary' }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
      const max = r.rawMaxTokens || r.maxTokens;
      if (max > 0) return { model: r.model || this.model, used: r.totalTokens, max, percentage: Math.round(r.percentage ?? (r.totalTokens / max) * 100) };
    } catch {
      /* an older Claude Code: estimate below */
    }
    const u = this.lastUsage;
    if (!u || !this.lastWindow) return null;
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    return { model: this.model, used, max: this.lastWindow, percentage: Math.round((used / this.lastWindow) * 100) };
  }
  private active: { hooks: TurnHooks; resolve: (r: SDKResultMessage) => void; reject: (e: Error) => void } | null = null;
  private stderrTail = '';
  sessionId?: string;
  closed = false;
  lastUsed = Date.now();

  get busy() {
    return !!this.active;
  }

  constructor(
    cfg: SessionConfig,
    private onSessionId: (id: string) => void,
  ) {
    const claude = findClaudeExecutable();
    const options: Options = {
      cwd: cfg.cwd,
      model: cfg.model || undefined,
      effort: cfg.effort || undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: cfg.systemAppend },
      resume: cfg.resume,
      includePartialMessages: true,
      permissionMode: cfg.permissionMode,
      canUseTool: async (name, input, opts): Promise<PermissionResult> => {
        if (!this.active) return { behavior: 'deny', message: '当前没有进行中的任务' };
        return this.active.hooks.canUseTool(name, input, opts) as Promise<PermissionResult>;
      },
      hooks: {
        PreToolUse: [
          {
            // The deny list, before permission rules and auto mode's classifier see the call.
            hooks: [
              async (input) => {
                const pre = input as PreToolUseHookInput;
                const reason = cfg.deniedReason?.(pre.tool_name, pre.tool_input);
                return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } } : {};
              },
            ],
          },
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit',
            hooks: [
              async (input) => {
                const ti = (input as PreToolUseHookInput).tool_input as Record<string, unknown> | undefined;
                const fp = (ti?.file_path || ti?.notebook_path) as string | undefined;
                try {
                  this.active?.hooks.beforeEdit(fp ? path.resolve(cfg.cwd, fp) : undefined);
                } catch (e) {
                  log.error('beforeEdit', e);
                }
                return {};
              },
            ],
          },
        ],
      },
      mcpServers: cfg.mcpServers,
      settingSources: cfg.settingSources,
      settings: {
        permissions: { allow: cfg.allowRules, ask: cfg.askRules, deny: cfg.denyRules || [] },
        // The object form: older Claude Code versions reject `attribution: false`.
        ...(cfg.attributionOff ? { attribution: { commit: '', pr: '', sessionUrl: false }, includeCoAuthoredBy: false } : {}),
      },
      sandbox: cfg.sandbox,
      disallowedTools: ['AskUserQuestion'],
      pathToClaudeCodeExecutable: claude ?? undefined,
      env: { ...cfg.env, CLAUDE_AGENT_SDK_CLIENT_APP: `crew/${APP_VERSION}` },
      stderr: (d) => {
        this.stderrTail = (this.stderrTail + d).slice(-4000);
      },
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  private async pump() {
    try {
      for await (const m of this.q) {
        this.lastUsed = Date.now();
        const sid = (m as { session_id?: string }).session_id;
        if (sid && sid !== this.sessionId) {
          this.sessionId = sid;
          this.onSessionId(sid);
        }
        if (m.type === 'system' && m.subtype === 'init' && m.model) this.model = m.model;
        // Subagents have their own context; the main loop's last call tells how full this one is.
        if (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.usage) this.lastUsage = m.message.usage;
        if (m.type === 'result' && m.modelUsage) {
          const windows = Object.values(m.modelUsage).map((x) => x.contextWindow || 0);
          if (windows.length) this.lastWindow = Math.max(...windows);
        }
        const a = this.active;
        if (!a) continue;
        try {
          a.hooks.onMessage(m);
        } catch (e) {
          log.error('onMessage', e);
        }
        if (m.type === 'result') {
          this.active = null;
          a.resolve(m);
        }
      }
      this.fail(new Error(this.explain('Claude Code 进程已退出')));
    } catch (e) {
      this.fail(new Error(this.explain((e as Error)?.message || String(e))));
    }
  }

  private explain(msg: string): string {
    const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n');
    return tail && !msg.includes(tail) ? `${msg}\n${tail}` : msg;
  }

  private fail(e: Error) {
    this.closed = true;
    const a = this.active;
    this.active = null;
    a?.reject(e);
  }

  run(content: UserContent, hooks: TurnHooks): Promise<SDKResultMessage> {
    if (this.closed) return Promise.reject(new Error('会话已关闭'));
    if (this.active) return Promise.reject(new Error('会话正忙'));
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.active = { hooks, resolve, reject };
      this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    });
  }

  async interrupt() {
    try {
      await this.q.interrupt();
    } catch {
      /* already idle */
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    try {
      this.q.close();
    } catch {
      /* ignore */
    }
    const a = this.active;
    this.active = null;
    a?.reject(new Error('已停止'));
  }
}

// ---------------------------------------------------------------------------
// A scripted stand-in used when CREW_FAKE_AGENT=1, for developing the UI
// without spending model usage. It speaks the same SDK message shapes.
// ---------------------------------------------------------------------------

let fakeCounter = 0;

export class FakeSession implements AgentSession {
  closed = false;
  busy = false;
  sessionId = `fake-${Date.now()}`;
  lastUsed = Date.now();
  private stopped = false;

  constructor(
    private cfg: SessionConfig,
    private botName: string,
    private mentionables: string[],
    onSessionId: (id: string) => void,
  ) {
    setTimeout(() => onSessionId(this.sessionId), 0);
  }

  private base() {
    return { session_id: this.sessionId, uuid: crypto.randomUUID(), parent_tool_use_id: null };
  }

  private turns = 0;

  async contextUsage(): Promise<Omit<ContextUsage, 'at'> | null> {
    const used = 14_000 + this.turns * 5_500;
    return { model: this.cfg.model || 'claude-opus-5-5', used, max: 200_000, percentage: Math.round((used / 200_000) * 100) };
  }

  async run(content: UserContent, hooks: TurnHooks): Promise<SDKResultMessage> {
    this.busy = true;
    this.stopped = false;
    this.turns++;
    const prompt = typeof content === 'string' ? content : content.map((c) => ('text' in c ? c.text : '')).join('\n');
    const emit = (m: unknown) => hooks.onMessage(m as SDKMessage);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    const streamText = async (text: string) => {
      const msgId = `msg_fake_${++fakeCounter}`;
      emit({ type: 'stream_event', ...this.base(), event: { type: 'message_start', message: { id: msgId, content: [] } } });
      emit({ type: 'stream_event', ...this.base(), event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      for (const chunk of text.match(/.{1,6}/gsu) || []) {
        if (this.stopped) break;
        emit({ type: 'stream_event', ...this.base(), event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
        await sleep(25);
      }
      emit({ type: 'stream_event', ...this.base(), event: { type: 'content_block_stop', index: 0 } });
      emit({ type: 'assistant', ...this.base(), message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] } });
    };
    const runTool = async (name: string, input: Record<string, unknown>, run: () => string | Promise<string>) => {
      const msgId = `msg_fake_${++fakeCounter}`;
      const id = `toolu_fake_${fakeCounter}`;
      emit({ type: 'stream_event', ...this.base(), event: { type: 'message_start', message: { id: msgId, content: [] } } });
      emit({ type: 'stream_event', ...this.base(), event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } });
      emit({ type: 'stream_event', ...this.base(), event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } });
      emit({ type: 'stream_event', ...this.base(), event: { type: 'content_block_stop', index: 0 } });
      emit({ type: 'assistant', ...this.base(), message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
      await sleep(300);
      let result: string;
      let isError = false;
      const perm = await hooks.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: id } as never);
      if (perm && perm.behavior === 'deny') {
        result = `权限被拒绝：${perm.message}`;
        isError = true;
      } else {
        try {
          result = await run();
        } catch (e) {
          result = String(e);
          isError = true;
        }
      }
      emit({ type: 'user', ...this.base(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } });
      await sleep(200);
    };

    try {
      await streamText(`收到！我是 ${this.botName}（演示模式，没有调用模型）。我先看看项目结构。`);
      await runTool('Glob', { pattern: '**/*.{html,css,js,ts,tsx}' }, () => {
        try {
          return fs.readdirSync(this.cfg.cwd).join('\n');
        } catch {
          return '(空)';
        }
      });
      if (/改|写|做|创建|add|create|make|build/i.test(prompt) && !this.stopped) {
        const file = path.join(this.cfg.cwd, 'crew-demo.md');
        await runTool('Bash', { command: 'ls -la', description: '列出项目文件' }, () => 'total 8\n(演示输出)');
        await runTool('Write', { file_path: file, content: `# 演示\n\n由 ${this.botName} 在 ${new Date().toLocaleString()} 写入。\n\n需求：${prompt.slice(0, 200)}\n` }, () => {
          hooks.beforeEdit(file);
          fs.writeFileSync(file, `# 演示\n\n由 ${this.botName} 在 ${new Date().toLocaleString()} 写入。\n\n需求：${prompt.slice(0, 200)}\n`);
          return `File created successfully at: ${file}`;
        });
      }
      const others = this.mentionables.filter((n) => n !== this.botName);
      const shouldHandoff = others.length > 0 && /交给|分派|拆分|handoff/i.test(prompt) && !/【@/.test(prompt);
      await streamText(shouldHandoff ? `我把任务拆一下：@${others[0]} 请你先实现页面结构，完成后告诉我。` : '完成了。**演示模式**下我只创建了 `crew-demo.md`，用来演示改动追踪和撤销。');
      const result = {
        type: 'result',
        subtype: 'success',
        ...this.base(),
        duration_ms: Date.now() - started,
        duration_api_ms: 0,
        is_error: false,
        num_turns: 3,
        result: 'ok',
        stop_reason: 'end_turn',
        // A demo turn costs a cent, so budgets and spend are visible in the UI and testable.
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: { [this.cfg.model || 'claude-opus-5-5']: { outputTokens: 120 } },
        permission_denials: [],
      } as unknown as SDKResultMessage;
      emit(result);
      return result;
    } finally {
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  async interrupt() {
    this.stopped = true;
  }

  close() {
    this.closed = true;
    this.stopped = true;
  }
}
