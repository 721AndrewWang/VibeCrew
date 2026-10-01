import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatMessage, MessagePart, ToolPart } from '../../shared/types';
import { bus } from '../bus';
import { saveUpload } from '../uploads';

const MAX_RESULT = 6000;

const ERROR_TEXT: Record<string, string> = {
  authentication_failed: 'Claude Code 未登录或登录已过期。请在终端运行 `claude auth login` 登录，或在「设置」里改用 API Key。',
  oauth_org_not_allowed: '当前账号所在的组织不允许这种登录方式，请在「设置」里改用 API Key。',
  billing_error: '账户余额或订阅有问题，请检查你的 Claude 账户。',
  rate_limit: '触发了用量限制，请稍后再试。',
  overloaded: '模型服务繁忙，请稍后重试。',
  model_not_found: '找不到设置的模型，请在机器人设置里换一个模型。',
  invalid_request: '请求无效（可能是模型名或参数不被支持）。',
  max_output_tokens: '回复太长被截断了。',
};

function toolResultText(content: unknown): { text: string; images: { data: string; mime: string }[] } {
  const images: { data: string; mime: string }[] = [];
  if (typeof content === 'string') return { text: content, images };
  if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images };
  const texts: string[] = [];
  for (const c of content) {
    if (c?.type === 'text') texts.push(c.text);
    else if (c?.type === 'image' && c.source?.type === 'base64') images.push({ data: c.source.data, mime: c.source.media_type || 'image/png' });
  }
  return { text: texts.join('\n'), images };
}

/**
 * Turns the SDK's message stream for one bot turn into chat message parts and pushes
 * incremental updates to the browsers.
 */
export class TurnStream {
  private blockToPart = new Map<number, number>();
  private jsonBuf = new Map<number, string>();
  private streamedIds = new Set<string>();
  errorCode: string | null = null;
  stopped = false;

  constructor(
    readonly msg: ChatMessage,
    private onActivity: (state: 'thinking' | 'tool', detail?: string) => void,
    /** Called after every change to the message, so progress can be saved while the turn runs. */
    private onProgress: () => void = () => {},
  ) {
    msg.parts = msg.parts || [];
  }

  get parts(): MessagePart[] {
    return this.msg.parts!;
  }

  addPart(part: MessagePart): number {
    this.parts.push(part);
    const index = this.parts.length - 1;
    bus.emit({ t: 'msg_part', chatId: this.msg.chatId, id: this.msg.id, index, part });
    this.onProgress();
    return index;
  }

  updatePart(part: MessagePart) {
    const index = this.parts.indexOf(part);
    if (index >= 0) bus.emit({ t: 'msg_part', chatId: this.msg.chatId, id: this.msg.id, index, part });
    this.onProgress();
  }

  private appendText(index: number, delta: string) {
    const p = this.parts[index];
    if (!p || (p.type !== 'text' && p.type !== 'thinking')) return;
    p.text += delta;
    bus.emit({ t: 'msg_text', chatId: this.msg.chatId, id: this.msg.id, index, delta });
    this.onProgress();
  }

  private toolPart(id: string): ToolPart | undefined {
    return this.parts.find((p): p is ToolPart => p.type === 'tool' && p.id === id);
  }

  handle(m: SDKMessage) {
    switch (m.type) {
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event as any;
        if (ev.type === 'message_start') {
          this.blockToPart.clear();
          this.jsonBuf.clear();
          if (ev.message?.id) this.streamedIds.add(ev.message.id);
          this.onActivity('thinking');
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'text') this.blockToPart.set(ev.index, this.addPart({ type: 'text', text: b.text || '' }));
          else if (b.type === 'thinking') this.blockToPart.set(ev.index, this.addPart({ type: 'thinking', text: b.thinking || '' }));
          else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            this.blockToPart.set(ev.index, this.addPart({ type: 'tool', id: b.id, name: b.name, input: {}, status: 'running', startedAt: Date.now() }));
            this.jsonBuf.set(ev.index, '');
            this.onActivity('tool', b.name);
          }
        } else if (ev.type === 'content_block_delta') {
          const idx = this.blockToPart.get(ev.index);
          if (idx === undefined) return;
          const d = ev.delta;
          if (d.type === 'text_delta') this.appendText(idx, d.text);
          else if (d.type === 'thinking_delta') this.appendText(idx, d.thinking);
          else if (d.type === 'input_json_delta') this.jsonBuf.set(ev.index, (this.jsonBuf.get(ev.index) || '') + d.partial_json);
        } else if (ev.type === 'content_block_stop') {
          const idx = this.blockToPart.get(ev.index);
          const p = idx !== undefined ? this.parts[idx] : undefined;
          if (p?.type === 'tool') {
            try {
              p.input = JSON.parse(this.jsonBuf.get(ev.index) || '{}');
            } catch {
              /* the complete message carries the input */
            }
            this.updatePart(p);
          }
        }
        return;
      }
      case 'assistant': {
        const nested = m.parent_tool_use_id;
        const content = (m.message?.content || []) as any[];
        const streamed = !!m.message?.id && this.streamedIds.has(m.message.id);
        for (const b of content) {
          if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            const existing = this.toolPart(b.id);
            if (existing) {
              existing.input = b.input;
              this.updatePart(existing);
            } else {
              this.addPart({ type: 'tool', id: b.id, name: b.name, input: b.input, status: 'running', parent: nested, startedAt: Date.now() });
              if (!nested) this.onActivity('tool', b.name);
            }
          } else if (!streamed && !nested && b.type === 'text' && b.text?.trim()) {
            this.addPart({ type: 'text', text: b.text });
          }
        }
        if (m.error) this.errorCode = m.error;
        return;
      }
      case 'user': {
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content as any[]) {
          if (b?.type !== 'tool_result') continue;
          const part = this.toolPart(b.tool_use_id);
          if (!part) continue;
          const { text, images } = toolResultText(b.content);
          part.status = b.is_error ? 'error' : 'done';
          part.result = text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + `\n…（共 ${text.length} 字符）` : text;
          part.endedAt = Date.now();
          if (images.length) part.images = images.slice(0, 4).map((img) => saveUpload(Buffer.from(img.data, 'base64'), img.mime, 'screenshot').url);
          this.updatePart(part);
        }
        this.onActivity('thinking');
        return;
      }
      case 'system': {
        const sub = (m as any).subtype;
        if (sub === 'status' && (m as any).status === 'compacting') this.onActivity('thinking', '整理上下文…');
        return;
      }
      case 'tool_progress': {
        this.onActivity('tool', `${m.tool_name} · ${Math.round(m.elapsed_time_seconds)}s`);
        return;
      }
      default:
        return;
    }
  }

  /** Tools still marked running when the turn ends did not finish. */
  private closeOpenTools(status: 'done' | 'error') {
    for (const p of this.parts) {
      if (p.type === 'tool' && p.status === 'running') {
        p.status = status;
        p.endedAt = Date.now();
      }
      if (p.type === 'approval' && p.status === 'pending') p.status = 'expired';
    }
  }

  finish(result: SDKResultMessage) {
    this.msg.meta = { costUsd: result.total_cost_usd, durationMs: result.duration_ms, numTurns: result.num_turns, model: mainModel(result.modelUsage) };
    const isError = result.is_error || result.subtype !== 'success';
    if (this.stopped) {
      this.msg.status = 'stopped';
      this.closeOpenTools('error');
    } else if (this.errorCode || isError) {
      this.msg.status = 'error';
      const resultText = result.subtype === 'success' ? (result as any).result : '';
      this.msg.error =
        (this.errorCode && ERROR_TEXT[this.errorCode]) || (result.subtype === 'error_max_turns' ? '达到了最大轮数限制。' : '') || (typeof resultText === 'string' && resultText) || '执行出错。';
      this.closeOpenTools('error');
    } else {
      this.msg.status = 'done';
      this.closeOpenTools('done');
    }
  }

  fail(e: unknown) {
    const text = e instanceof Error ? e.message : String(e);
    if (this.stopped) this.msg.status = 'stopped';
    else {
      this.msg.status = 'error';
      this.msg.error = /ENOENT|spawn/.test(text) ? `无法启动 Claude Code：${text}。请确认已安装 Claude Code（npm i -g @anthropic-ai/claude-code），或设置 CREW_CLAUDE_PATH。` : text;
    }
    this.closeOpenTools('error');
  }

  /** Text the bot said, for chat previews and @mention detection. */
  finalText(): string {
    return this.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n\n');
  }
}

/** The model that produced most of a turn's output. */
function mainModel(usage: Record<string, { outputTokens?: number }> | undefined): string | undefined {
  const entries = Object.entries(usage || {});
  if (!entries.length) return undefined;
  return entries.reduce((a, b) => ((b[1].outputTokens || 0) > (a[1].outputTokens || 0) ? b : a))[0];
}
