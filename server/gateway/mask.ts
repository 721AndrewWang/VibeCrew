// Privacy masking (ADR 009): keys, passwords and emails in an outgoing prompt are replaced with
// placeholders, and the placeholders in the reply are turned back into the values. Pure.
//
// A placeholder is an HMAC of the value, so the same secret gets the same placeholder in every call
// and the history Claude Code resends stays byte-identical (prompt caching keeps working). Thinking
// blocks are never touched in either direction: their signatures must stay valid.

import crypto from 'node:crypto';

export type MaskKind = 'EMAIL' | 'KEY' | 'PASSWORD';
const KINDS: MaskKind[] = ['EMAIL', 'KEY', 'PASSWORD'];
const PREFIX = 'CREW_MASKED_';
const PLACEHOLDER = /CREW_MASKED_(?:EMAIL|KEY|PASSWORD)_[0-9a-f]{8}/g;

/** Token shapes of common services, then generic ones. Each matches the whole secret. */
const KEY_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
/** "Bearer <token>": only the token. */
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;
/** password=…, "secret": "…", api_key: …: only the value. */
const ASSIGNMENT =
  /(\b(?:pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|access[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token)["']?\s*[:=]\s*["']?)([^\s"'`,;&<>()[\]{}]{4,200})/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** An assigned value that is code or a plain word (`token: string`, `password = getPassword`), not a secret. */
const notSecretValue = (v: string) => /^[A-Za-z_][A-Za-z_.]*$/.test(v) || /^\d+$/.test(v) || v.includes('${') || v.startsWith(PREFIX);

export class Masker {
  /** placeholder → value, for restoring the reply. */
  readonly map = new Map<string, string>();
  count = 0;

  constructor(private salt: string) {}

  private placeholder(kind: MaskKind, value: string): string {
    const p = `${PREFIX}${kind}_${crypto.createHmac('sha256', this.salt).update(`${kind}\0${value}`).digest('hex').slice(0, 8)}`;
    if (!this.map.has(p)) this.map.set(p, value);
    this.count++;
    return p;
  }

  /** One string with every secret replaced. */
  text(s: string): string {
    if (!s) return s;
    let out = s;
    for (const re of KEY_PATTERNS) out = out.replace(re, (m) => this.placeholder('KEY', m));
    out = out.replace(BEARER, (m, pre: string, tok: string) => (tok.startsWith(PREFIX) ? m : pre + this.placeholder('KEY', tok)));
    out = out.replace(ASSIGNMENT, (m, pre: string, val: string) => (notSecretValue(val) ? m : pre + this.placeholder('PASSWORD', val)));
    out = out.replace(EMAIL, (m) => this.placeholder('EMAIL', m));
    return out;
  }

  /** Every string inside a JSON value (a tool call's input). */
  deep(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.deep(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)]));
    return v;
  }

  private blocks(content: unknown): unknown {
    if (typeof content === 'string') return this.text(content);
    if (!Array.isArray(content)) return content;
    return content.map((b) => {
      if (!b || typeof b !== 'object') return b;
      const block = b as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: this.text(block.text) };
      if (block.type === 'tool_result') return { ...block, content: this.blocks(block.content) };
      if (block.type === 'tool_use' && block.input !== undefined) return { ...block, input: this.deep(block.input) };
      // Thinking (signed), images, documents and server tool blocks go as they are.
      return block;
    });
  }

  /** A Messages API request body with its prompt masked: system and every message's content. */
  request(body: Record<string, unknown>): Record<string, unknown> {
    const out = { ...body };
    if (out.system !== undefined) out.system = this.blocks(out.system);
    if (Array.isArray(out.messages)) {
      out.messages = out.messages.map((m) => (m && typeof m === 'object' ? { ...(m as Record<string, unknown>), content: this.blocks((m as Record<string, unknown>).content) } : m));
    }
    return out;
  }
}

/** Placeholders in a reply's text turned back into their values; unknown ones stay. */
export function restoreText(s: string, map: Map<string, string>, json = false): string {
  if (!map.size || !s.includes(PREFIX)) return s;
  return s.replace(PLACEHOLDER, (p) => {
    const v = map.get(p);
    if (v === undefined) return p;
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
}

function restoreDeep(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === 'string') return restoreText(v, map);
  if (Array.isArray(v)) return v.map((x) => restoreDeep(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, map)]));
  return v;
}

/** A whole (non-streamed) Messages API answer restored: text and tool calls, not thinking. */
export function restoreMessage(msg: Record<string, unknown>, map: Map<string, string>): Record<string, unknown> {
  if (!map.size || !Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: msg.content.map((b) => {
      if (!b || typeof b !== 'object') return b;
      const block = b as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: restoreText(block.text, map) };
      if (block.type === 'tool_use') return { ...block, input: restoreDeep(block.input, map) };
      return block;
    }),
  };
}

/** Could `t` be the start of a placeholder that the next chunk completes? */
function placeholderPrefix(t: string): boolean {
  if (t.length <= PREFIX.length) return PREFIX.startsWith(t);
  if (!t.startsWith(PREFIX)) return false;
  const rest = t.slice(PREFIX.length);
  return KINDS.some((k) => {
    const head = `${k}_`;
    if (rest.length <= head.length) return head.startsWith(rest);
    return rest.startsWith(head) && /^[0-9a-f]{0,7}$/.test(rest.slice(head.length));
  });
}

/**
 * Restores one streamed content block: deltas in, restored text out. A tail that could be the start
 * of a placeholder is held back until the next delta, or until flush() at the block's end.
 */
export class StreamRestorer {
  private buf = '';

  constructor(
    private map: Map<string, string>,
    private json = false,
  ) {}

  push(delta: string): string {
    this.buf = restoreText(this.buf + delta, this.map, this.json);
    const max = PREFIX.length + 'PASSWORD_'.length + 8;
    let cut = this.buf.length;
    for (let i = Math.max(0, this.buf.length - max); i < this.buf.length; i++) {
      if (placeholderPrefix(this.buf.slice(i))) {
        cut = i;
        break;
      }
    }
    const out = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return out;
  }

  flush(): string {
    const out = this.buf;
    this.buf = '';
    return out;
  }
}
