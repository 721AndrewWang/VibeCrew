import fs from 'node:fs';
import path from 'node:path';
import {
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PostToolUseHookInput,
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
import { fetchedNote } from '../untrusted';
import { wrapUpNote } from './wrapUp';

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
  /** Context size (tokens) past which a turn is asked to wrap up; read at each tool call, 0 = never. */
  wrapUpAt?(): number;
  /** A Worker's events delivered while a turn runs (ADR 003): taken at each tool call of the main loop and added to its context. */
  deliveries?(): string | null;
  /**
   * Full duplex (ADR 004): input that arrived while the turn runs (user messages, job results), handed
   * to the model after each tool call of the main loop. Draining: returns each item once.
   */
  midTurnNote?(): string | null;
  /** Hide Claude Code's attribution (Co-Authored-By trailers, PR footers) in commits and PRs. */
  attributionOff?: boolean;
  /** Claude Code's command sandbox (see server/sandbox.ts); undefined runs commands unconfined. */
  sandbox?: Options['sandbox'];
  mcpServers: Record<string, McpServerConfig>;
  settingSources: NonNullable<Options['settingSources']>;
  env: Record<string, string>;
  /** Built-in tools on offer; [] = none (MCP tools only). Unset: all of Claude Code's. */
  tools?: string[];
  /** Replaces Claude Code's own system prompt (systemAppend is then unused): for sessions with no built-in tools. */
  systemPrompt?: string;
  /** For the demo agent: a Router or the Watchdog calls its tools, a Worker reports instead of handing off. */
  role?: 'router' | 'worker' | 'watchdog';
  /** The demo agent's way to call MCP tools by name, without an MCP client. */
  fakeTools?: Record<string, (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>>;
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
  /** The context size at this turn's last wrap-up reminder. */
  private remindedAt: number | null = null;

  /** Tokens the main loop's last call read: what the next call will re-read, and then some. */
  private contextSize(): number {
    const u = this.lastUsage;
    return u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) : 0;
  }
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
    const used = this.contextSize();
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
      systemPrompt: cfg.systemPrompt ?? { type: 'preset', preset: 'claude_code', append: cfg.systemAppend },
      tools: cfg.tools,
      resume: cfg.resume,
      includePartialMessages: true,
      permissionMode: cfg.permissionMode,
      canUseTool: async (name, input, opts): Promise<PermissionResult> => {
        if (!this.active) return { behavior: 'deny', message: 'There is no task in progress' };
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
        PostToolUse: [
          {
            // A fetched page or search result is outside content: labelled as data (ADR 007).
            matcher: 'WebFetch|WebSearch',
            hooks: [
              async (input) => {
                const post = input as PostToolUseHookInput;
                const note = fetchedNote(post.tool_name, post.tool_input);
                return note ? { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: note } } : {};
              },
            ],
          },
          {
            // A turn grown past the limit is asked to finish the step in hand and hand back; a
            // full-duplex turn is also given what arrived while it worked (ADR 004), and a Worker
            // the events that arrived on its threads meanwhile (ADR 003).
            hooks: [
              async (input) => {
                if ((input as PostToolUseHookInput).agent_id || !this.active) return {};
                const wrap = wrapUpNote(this.contextSize(), cfg.wrapUpAt?.() ?? 0, this.remindedAt);
                if (wrap) this.remindedAt = this.contextSize();
                const note = [cfg.midTurnNote?.(), cfg.deliveries?.(), wrap].filter(Boolean).join('\n\n');
                if (!note) return {};
                return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: note } };
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
      this.fail(new Error(this.explain('The Claude Code process exited')));
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
    if (this.closed) return Promise.reject(new Error('The session is closed'));
    if (this.active) return Promise.reject(new Error('The session is busy'));
    this.lastUsed = Date.now();
    this.remindedAt = null;
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
    a?.reject(new Error('Stopped'));
  }
}

// ---------------------------------------------------------------------------
// A scripted stand-in used when CREW_FAKE_AGENT=1, for developing the UI
// without spending model usage. It speaks the same SDK message shapes.
// ---------------------------------------------------------------------------

let fakeCounter = 0;
/** "flaky" Worker tasks that already failed once in this process: the retry succeeds. */
const flaked = new Set<string>();

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

  /** Cache reads over the session so far: each turn re-reads what came before it. */
  private readSoFar() {
    let sum = 0;
    for (let t = 1; t <= this.turns; t++) sum += 12_000 + t * 5_500;
    return sum;
  }

  async contextUsage(): Promise<Omit<ContextUsage, 'at'> | null> {
    const used = 14_000 + this.turns * 5_500;
    return { model: this.cfg.model || 'claude-opus-5-5', used, max: 200_000, percentage: Math.round((used / 200_000) * 100) };
  }

  async run(content: UserContent, hooks: TurnHooks): Promise<SDKResultMessage> {
    this.busy = true;
    this.stopped = false;
    this.turns++;
    const prompt = typeof content === 'string' ? content : content.map((c) => ('text' in c ? c.text : '')).join('\n');
    // The keywords below are matched on the conversation only: the <context> block carries Crew's own wording.
    const ask = prompt.replace(/<context>[\s\S]*?<\/context>/g, '');
    const emit = (m: unknown) => hooks.onMessage(m as SDKMessage);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    // A demo Worker's delivered events (ADR 003): the ones in its prompt, and the ones it gets between steps.
    const seen: string[] = [];
    const handBack: { thread: string; event: string }[] = [];
    const take = (text: string | null | undefined) => {
      for (const m of (text || '').matchAll(/<event id="(tg_[^"]+)" thread="(th_[^"]+)"[^>]*>\n([\s\S]*?)\n<\/event>/g)) {
        if (seen.includes(m[1])) continue;
        seen.push(m[1]);
        if (/not my task/i.test(m[3])) handBack.push({ thread: m[2], event: m[1] });
      }
      return !!text;
    };
    if (this.cfg.role === 'worker') take(prompt);
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
    const runTool = async (name: string, input: Record<string, unknown>, run: () => string | Promise<string>): Promise<string> => {
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
      // As in Claude Code: the PreToolUse deny hook (blocked actions, the command guard) runs first, in every mode.
      const refused = this.cfg.deniedReason?.(name, input);
      const perm = refused ? { behavior: 'deny' as const, message: refused } : await hooks.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: id } as never);
      if (perm && perm.behavior === 'deny') {
        result = `Permission denied: ${perm.message}`;
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
      // Like the PostToolUse hook: what arrived meanwhile is read after this step.
      take(this.cfg.deliveries?.());
      const note = this.cfg.midTurnNote?.();
      if (note) heard.push(note);
      await sleep(200);
      return result;
    };
    const heard: string[] = [];

    try {
      if (this.cfg.role === 'router') {
        const tools = this.cfg.fakeTools || {};
        await fakeRouter(prompt, streamText, (name, args) =>
          runTool(`mcp__crew_router__${name}`, args, async () => {
            const r = await (tools[name]?.(args) ?? Promise.resolve({ text: `No such tool: ${name}`, isError: true }));
            if (r.isError) throw new Error(r.text);
            return r.text;
          }),
        );
      } else if (this.cfg.role === 'watchdog') {
        const tools = this.cfg.fakeTools || {};
        await fakeWatchdog(prompt, streamText, (name, args) =>
          runTool(`mcp__crew_watchdog__${name}`, args, async () => {
            const r = await (tools[name]?.(args) ?? Promise.resolve({ text: `No such tool: ${name}`, isError: true }));
            if (r.isError) throw new Error(r.text);
            return r.text;
          }),
        );
      } else if (this.cfg.role === 'worker' && /\bflaky\b/i.test(ask) && !flaked.has(this.cfg.cwd)) {
        // A demo Worker on a "flaky" task fails once with an error that reads as transient.
        flaked.add(this.cfg.cwd);
        throw new Error('API Error: 529 Overloaded (demo mode)');
      } else if (this.cfg.fakeTools?.start && (/Background job job_\w+/.test(ask) || /\b(background|slow|sub-?task)\b/i.test(ask))) {
        await fakeFullDuplex(
          ask,
          streamText,
          heard,
          () => this.stopped,
          (name, args) =>
            runTool(`mcp__crew__${name}`, args, async () => {
              const r = await (this.cfg.fakeTools?.[name]?.(args) ?? Promise.resolve({ text: `No such tool: ${name}`, isError: true }));
              if (r.isError) throw new Error(r.text);
              return r.text;
            }),
        );
      } else if (prompt.includes('## Changes to review')) {
        // A blind review: a table and the verdict line. REFUTE_ME in the change makes it refute one claim.
        const refute = prompt.includes('REFUTE_ME');
        await streamText(
          [
            '## Refutation results',
            '| # | Claim | How I tried to refute it | Result |',
            '| --- | --- | --- | --- |',
            `| 1 | The change does what the user asked | Read the change (demo mode) | ${refute ? 'Refuted (the change still contains REFUTE_ME)' : 'Not refuted'} |`,
            '',
            refute ? 'Verdict: refuted 1' : 'Verdict: not refuted',
          ].join('\n'),
        );
      } else {
        await streamText(`Got it! I'm ${this.botName} (demo mode, no model called). Let me look at the project structure first.`);
        await runTool('Glob', { pattern: '**/*.{html,css,js,ts,tsx}' }, () => {
          try {
            return fs.readdirSync(this.cfg.cwd).join('\n');
          } catch {
            return '(empty)';
          }
        });
        if (/complex/i.test(ask)) {
          // A complex request: a few more looks around, enough to count as real work.
          for (const pattern of ['*.html', '*.css', '*.js', '*.md']) await runTool('Glob', { pattern }, () => '(demo)');
        }
        // "push": the direct way is refused by the command guard, so the demo drafts it for the user (ADR 007).
        const draft = this.cfg.fakeTools?.draft_external_action;
        if (/\bpush\b/i.test(ask) && draft && !this.stopped) {
          // "twice": it tries again after the refusal, as an agent steered by what it read might (the Watchdog sees it in the audit log).
          for (let i = /\btwice\b/i.test(ask) ? 2 : 1; i > 0; i--) await runTool('Bash', { command: 'git push origin HEAD', description: 'Push the branch' }, () => '(demo: pushed)');
          const args = { kind: 'git-push', why: 'You asked for the branch to be pushed.' };
          await runTool('mcp__crew__draft_external_action', args, async () => {
            const r = await draft(args);
            if (r.isError) throw new Error(r.text);
            return r.text;
          });
        }
        // A demo Worker on a "slow" task keeps working until it is stopped, an event comes in on its threads, or 30 s pass.
        if (this.cfg.role === 'worker' && /\bslow\b/i.test(ask))
          for (let i = 0; i < 300 && !this.stopped && !seen.length; i++) {
            take(this.cfg.deliveries?.());
            await sleep(100);
          }
        if (/add|create|make|build/i.test(ask) && !this.stopped) {
          // Parallel demo Workers write files of their own, unless the task asks for a conflict.
          const name = this.cfg.role === 'worker' && !/conflict/i.test(ask) ? `crew-demo-${(++fakeCounter).toString(36)}.md` : 'crew-demo.md';
          const file = path.join(this.cfg.cwd, name);
          await runTool('Bash', { command: 'ls -la', description: 'List project files' }, () => 'total 8\n(demo output)');
          await runTool('Write', { file_path: file, content: `# Demo\n\nWritten by ${this.botName} at ${new Date().toLocaleString('en-US')}.\n\nRequest: ${prompt.slice(0, 200)}\n` }, () => {
            hooks.beforeEdit(file);
            fs.writeFileSync(file, `# Demo\n\nWritten by ${this.botName} at ${new Date().toLocaleString('en-US')}.\n\nRequest: ${prompt.slice(0, 200)}\n`);
            return `File created successfully at: ${file}`;
          });
        }
        // An event that says "not my task" goes back to the Router through the Worker's tool.
        for (const h of handBack) {
          await runTool('mcp__crew__hand_back', { thread: h.thread, event: h.event, note: 'Not part of my task.' }, async () => {
            const r = await (this.cfg.fakeTools?.hand_back?.(h) ?? Promise.resolve({ text: 'No hand_back tool', isError: true }));
            if (r.isError) throw new Error(r.text);
            return r.text;
          });
        }
        const others = this.mentionables.filter((n) => n !== this.botName);
        const shouldHandoff = others.length > 0 && /hand off|handoff|assign|split/i.test(ask) && !/\[@/.test(prompt);
        // "two steps": the first turn asks for another with the continue line; the second one finishes.
        const twoSteps = /two steps/i.test(ask) && !/another round/.test(ask);
        await streamText(
          shouldHandoff
            ? `Let me split this up: @${others[0]} please build the page structure first and tell me when it's done.`
            : twoSteps
              ? "Step one is done; I'll take the next step myself.\n[continue]"
              : this.cfg.role === 'worker'
                ? `${this.stopped ? 'Stopped' : 'Done'}. In demo mode I only looked around${/add|create|make|build/i.test(ask) ? ' and wrote a demo file' : ''}; no model was called.${seen.length ? ` Read ${seen.length} event${seen.length === 1 ? '' : 's'} sent to me directly: ${seen.join(', ')}.` : ''}${handBack.length ? ` Handed ${handBack.map((h) => h.event).join(', ')} back to the Router.` : ''}`
                : 'Done. In **demo mode** I only created `crew-demo.md`, to show change tracking and undo.',
        );
      }
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
        // A demo turn costs a cent, so budgets and spend are visible in the UI and testable. Like
        // Claude Code, cost and tokens are running totals for the session.
        total_cost_usd: 0.01 * this.turns,
        usage: {},
        modelUsage: {
          [this.cfg.model || 'claude-opus-5-5']: {
            inputTokens: 50 * this.turns,
            cacheReadInputTokens: this.readSoFar(),
            cacheCreationInputTokens: 2_000 * this.turns,
            outputTokens: 120 * this.turns,
          },
        },
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

/**
 * The demo full-duplex bot (ADR 004). "background" starts a command (the one in backticks, else a
 * short demo build) and ends the turn, "sub-task" starts a background session of itself; a job's result gets a one-line answer; "slow" keeps working
 * step by step and answers what the user wrote meanwhile.
 */
async function fakeFullDuplex(ask: string, say: (text: string) => Promise<void>, heard: string[], stopped: () => boolean, call: (tool: string, args: Record<string, unknown>) => Promise<string>) {
  const result = ask.match(/Background job (job_\w+)[^\n]*/);
  if (result) {
    await say(`The background job is over: ${result[0].replace(/^Background job /, '').slice(0, 160)}`);
    return;
  }
  if (/\bsub-?task\b/i.test(ask)) {
    // The sub-task's own words in backticks, if any (so a test can have it try something the guard refuses).
    const task = ask.match(/`([^`]+)`/)?.[1] || 'Look around the project and report what is there.';
    const started = await call('start', { task, title: 'Demo check' });
    await say(started.startsWith('Started ') ? `${started.split(':')[0]}; I'll pass on its report.` : `Couldn't start it: ${started.replace(/^Error: /, '')}`);
    return;
  }
  if (/\bbackground\b/i.test(ask)) {
    const command = ask.match(/`([^`]+)`/)?.[1] || 'sleep 1; echo demo build ok';
    // A refused call comes back as the tool's error text, as Claude Code would show it.
    const started = await call('start', { command, title: 'Demo build' });
    if (!started.startsWith('Started ')) {
      await say(`Couldn't start it: ${started.replace(/^Error: /, '')}`);
      return;
    }
    await say(`${started.split(' in the background')[0]} in the background; I'll report when it's done.`);
    return;
  }
  for (let i = 0; i < 40 && !heard.length && !stopped(); i++) await call('status', {}).catch(() => '');
  const said = heard
    .join('\n')
    .match(/\[User[^\]]*\] ([^\n]+)/)?.[1]
    ?.trim();
  await say(said ? `Heard you while working: "${said}". Done with the slow check too.` : 'Done with the slow check.');
}

/**
 * The demo Router: reads the batch's events (layers/prompts.ts renders them), dispatches a Worker
 * for anything that asks for work, and answers with a short reply. "split" asks for two Workers.
 */
async function fakeRouter(prompt: string, say: (text: string) => Promise<void>, call: (tool: string, args: Record<string, unknown>) => Promise<string>) {
  const replies: string[] = [];
  for (const m of prompt.matchAll(/<event ([^>]*)>\n([\s\S]*?)\n<\/event>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const body = m[2].trim();
    const short = (body.split('\n').find((l) => l.trim()) || '').slice(0, 60);
    // "draft a comment on owner/repo#12" (or "a reply to owner/repo#7 comment 555"): a GitHub draft (ADR 102).
    const draft = a.kind === 'environment' ? null : body.match(/\bdraft (?:a )?(comment|reply) (?:on|to) ([\w.-]+\/[\w.-]+)#(\d+)(?: comment (\d+))?/i);
    if (a.kind === 'worker') replies.push(`${a.bot} ${a.status === 'done' ? 'finished' : `ended (${a.status})`}: "${a.title}".`);
    else if (a.kind === 'environment') replies.push(`Crew noticed: ${short}`);
    else if (draft) {
      const r = await call('draft_github', {
        kind: draft[1].toLowerCase() === 'reply' ? 'review-reply' : 'issue-comment',
        repo: draft[2],
        number: Number(draft[3]),
        ...(draft[4] ? { comment: Number(draft[4]) } : {}),
        background: `Asked for in the chat: ${short}`,
        change: 'Demo mode: no change was made.',
        verification: 'Demo mode: nothing was run.',
      });
      replies.push(r.startsWith('Draft ') ? `${r.split(':')[0]}; it waits for your approval.` : `Couldn't draft it: ${r}`);
    } else if (/\b(add|create|make|build|fix|change|write|slow|split)\b/i.test(body)) {
      const parts = /\bsplit\b/i.test(body) ? 2 : 1;
      const started: string[] = [];
      for (let i = 0; i < parts; i++) {
        // "family:triage" in the demo picks a lifecycle skill family (ADR 007).
        const family = body.match(/\bfamily:([a-z-]+)/)?.[1];
        // "issue owner/repo#12" (or "PR #7"): the Worker subscribes to that issue's thread (ADR 102).
        const github = body.match(/\b(?:issue|PR|pull request) ((?:[\w.-]+\/[\w.-]+)?#\d+)/i)?.[1];
        const r = await call('dispatch_worker', {
          title: parts > 1 ? `${short} (part ${i + 1})` : short,
          task: body,
          ...(a.to || a.bot ? { bot: a.to || a.bot } : {}),
          ...(family ? { family } : {}),
          ...(github ? { github } : {}),
        });
        started.push(r.replace(/ It works in the background.*$/s, ''));
      }
      replies.push(`On it. ${started.join(' ')}`);
    } else replies.push(`(Demo Router) Noted: "${short}". Nothing to dispatch for that.`);
  }
  const text = replies.join(' ').split(/\s+/).slice(0, 90).join(' ');
  if (text) await call('reply', { text });
  await say('Handled this batch (demo mode, no model called).');
}

/**
 * The demo Watchdog: reads the snapshot (watchdog/snapshot.ts renders it). A Worker that is flagged
 * stuck or looping, or whose task mentions "drift", is stopped and redirected; one that failed on
 * something transient is restarted. A maintainer who asks to "propose" gets a policy proposal.
 */
async function fakeWatchdog(prompt: string, say: (text: string) => Promise<void>, call: (tool: string, args: Record<string, unknown>) => Promise<string>) {
  const done: string[] = [];
  const maintainer = prompt.includes('A maintainer writes to you');
  for (const m of prompt.matchAll(/<worker ([^>]*)>\n([\s\S]*?)\n<\/worker>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const flags = (a.flags || '').split(',');
    const task = m[2];
    const running = ['running', 'starting', 'waiting'].includes(a.status);
    const result = async (p: Promise<string>) => p.catch((e) => `refused: ${(e as Error).message}`);
    if (!maintainer && running && (flags.includes('stuck') || flags.includes('looping') || /\bdrift\b/i.test(task)))
      done.push(`${a.id}: ${await result(call('stop_worker', { id: a.id, why: 'It is not making progress on its task.', redirect: 'Refocus on your task and report what is done.' }))}`);
    else if (!maintainer && a.status === 'error' && flags.includes('failed-transient'))
      done.push(`${a.id}: ${await result(call('restart_worker', { id: a.id, note: 'The failure looked transient; try again.' }))}`);
  }
  // The guard refusing one agent again and again (the audit log, ADR 007): its chat is told.
  for (const m of maintainer ? [] : prompt.matchAll(/<audit ([^>]*)>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (a.event !== 'blocked' || Number(a.count) < 2 || !a.chat) continue;
    const text = `The command guard refused ${a.worker || a.who} ${a.count} times (rule: ${a.rule}). It should draft that action for you instead.`;
    done.push(`${a.chat}: ${await call('notify', { chat: a.chat, text }).catch((e) => `refused: ${(e as Error).message}`)}`);
  }
  if (maintainer) {
    const failed = [...prompt.matchAll(/<worker id="([^"]+)"[^>]*status="error"/g)].map((x) => x[1]);
    const asked = (prompt.split('A maintainer writes to you (their words, not data):')[1] || '').split('The current snapshot')[0];
    if (/propose|policy|policies/i.test(asked))
      done.push(
        await call('propose_change', {
          target: 'policies',
          after: '- Failed bot turns: act when the error repeats within an hour.\n- When unsure, stay quiet.',
          why: 'Demo proposal from the Watchdog.',
        }).catch((e) => `refused: ${(e as Error).message}`),
      );
    await say(`Demo Watchdog (no model called): ${failed.length ? `${failed.join(', ')} failed; see its report.` : 'nothing has failed lately.'} ${done.join(' ')}`.trim());
    return;
  }
  await say(done.length ? `Acted: ${done.join(' ')}` : 'Looked at the snapshot; nothing needs me (demo mode, no model called).');
}
