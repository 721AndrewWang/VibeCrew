// Channel profiles (ADR 103): what output may look like on each surface it goes to. The in-app
// chat is a low-interruption channel (a few lines, only decisions, questions and acceptance
// requests, never tool output); drafts for pull requests, issues and release notes are
// asynchronous (structured and dense, evidence fenced and folded). Pure: the places that write to
// a surface call these checks, and each refusal tells the model what to change.

import type { DraftKind, ReplyKind } from '../../shared/types';
import { firstWords, REPLY_WORDS, wordCount } from '../layers/prompts';

// ---------------------------------------------------------------- the chat profile

export const CHAT_PROFILE = {
  maxWords: REPLY_WORDS,
  maxLines: 6,
  kinds: ['decision', 'question', 'acceptance'] as const satisfies readonly ReplyKind[],
};

export const GIST_WORDS = 30;
export const REPORT_CHARS = 20_000;

export const isReplyKind = (v: unknown): v is ReplyKind => typeof v === 'string' && (CHAT_PROFILE.kinds as readonly string[]).includes(v);

export const KIND_LABEL: Record<ReplyKind, string> = { decision: 'Update', question: 'Question', acceptance: 'Ready for your OK' };

/** Crew's and Claude Code's own tags: text in them was written for a model, never for a person. */
const PROMPT_TAG = /<\s*\/?\s*(untrusted|event|workers|direct|context|job_output|audit|delivered|tool_use_error|system-reminder|function_results)\b/i;
const FENCE_LINE = /^\s*(```|~~~)/;
const DIFF_LINE = /^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@|\+\+\+ (b\/|\/dev\/null)|--- (a\/|\/dev\/null)|index [0-9a-f]{7,}\.\.[0-9a-f]{7,})/;
const STACK_LINE = /^\s*at\s+\S.*\(\S*:\d+:\d+\)\s*$|^\s+at\s+\S+:\d+:\d+\s*$|Traceback \(most recent call last\)|^\s*File ".+", line \d+/;
const LOG_LINE = /^\s*(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2}(\.\d+)?\]|\[?(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\]?[:\s]|\[(error|warn|info|log|debug)\]\s)/;
const NPM_ERR = /^\s*npm (ERR!|error)/;
const SHELL_LINE = /^\s*\$ \S/;
/** One unbroken run of characters no sentence has: minified code, base64, a hash of a whole file. Links may be longer. */
const longToken = (line: string) => line.split(/\s+/).some((t) => t.length > (/^<?https?:\/\//.test(t) ? 400 : 120));

/**
 * The same output with its line breaks gone, as it reads once text is flattened into one line (a
 * report cut to its first words): fences, frames, hunks and log stamps in the middle of a line.
 */
const INLINE: [RegExp, string][] = [
  [/(^|\s)(```|~~~)/, 'a code block'],
  [/\bat [\w$.<>[\]]+ \(\S+:\d+:\d+\)/, 'a stack trace'],
  [/Traceback \(most recent call last\)/, 'a stack trace'],
  [/(^|\s)(diff --git \S|@@ -\d+(,\d+)? \+\d+(,\d+)? @@)/, 'a diff'],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?\S*\s+\[?(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b/, 'log output'],
  [/\bnpm (ERR!|error) /, 'log output'],
];

/** Why one line reads as tool output rather than a sentence, or null. */
export function outputLine(line: string): string | null {
  if (PROMPT_TAG.test(line)) return 'prompt tags';
  if (DIFF_LINE.test(line)) return 'a diff';
  if (STACK_LINE.test(line)) return 'a stack trace';
  if (NPM_ERR.test(line)) return 'log output';
  if (SHELL_LINE.test(line)) return 'a shell transcript';
  if (longToken(line)) return 'an unbroken run of over 120 characters';
  for (const [re, why] of INLINE) if (re.test(line) && why !== 'a code block') return why;
  return null;
}

/** Why this text carries tool output (code, a diff, a trace, a log, prompt tags), or null. */
export function toolOutputIn(text: string): string | null {
  const lines = text.split('\n');
  if (lines.some((l) => FENCE_LINE.test(l))) return 'a code block';
  for (const l of lines) {
    const why = outputLine(l);
    if (why) return why;
  }
  if (lines.filter((l) => LOG_LINE.test(l)).length >= 2) return 'log output';
  for (const [re, why] of INLINE) if (re.test(text)) return why;
  return null;
}

/** Why a Router reply does not fit the chat, or null. The model reads it as the tool's error. */
export function chatRefusal(text: string, kind: ReplyKind = 'decision'): string | null {
  if (!text.trim()) return 'The reply is empty.';
  const n = wordCount(text);
  if (n > CHAT_PROFILE.maxWords)
    return `The reply has ${n} words; the chat takes at most ${CHAT_PROFILE.maxWords}. Keep only what the user needs (a result, a decision, a question); the details stay in the Workers' transcripts.`;
  const leak = toolOutputIn(text);
  if (leak)
    return `The reply contains ${leak}. The chat takes no tool output: say in a sentence what it means for the user. A Worker's full report is attached under Details by itself; name a command or file inline (\`npm test\`) if the user needs it.`;
  const lines = text.split('\n').filter((l) => l.trim()).length;
  if (lines > CHAT_PROFILE.maxLines) return `The reply has ${lines} lines; the chat takes at most ${CHAT_PROFILE.maxLines}. Say it in a few sentences.`;
  if (kind === 'question' && !/[?？]/.test(text)) return 'A question needs a question mark: ask the user what you need them to decide, or use kind "decision".';
  return null;
}

/** The text split into prose and fenced blocks (an unclosed fence runs to the end). */
function segments(text: string): { fenced: boolean; lines: string[] }[] {
  const out: { fenced: boolean; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(```|~~~)/);
    if (!fence && m) {
      fence = m[1];
      out.push({ fenced: true, lines: [line] });
    } else if (fence) {
      out[out.length - 1].lines.push(line);
      if (line.trim() === fence || (line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim())) fence = null;
    } else if (out.length && !out[out.length - 1].fenced) out[out.length - 1].lines.push(line);
    else out.push({ fenced: false, lines: [line] });
  }
  return out;
}

const stripFences = (text: string) =>
  segments(text)
    .filter((s) => !s.fenced)
    .flatMap((s) => s.lines)
    .join('\n');

/**
 * A Worker report in a few words for the chat's Details row: its first sentences, without code
 * blocks, tool output, headings or list markers. Deterministic; the Router writes the real summary.
 */
export function reportGist(report: string, words = GIST_WORDS): string {
  const lines = stripFences(report)
    .split('\n')
    // Headings are labels, not sentences.
    // A stack trace's first line (the error) goes with its frames.
    .filter((l, i, all) => l.trim() && !/^\s*#{1,6}\s/.test(l) && !outputLine(l) && !LOG_LINE.test(l) && !STACK_LINE.test(all[i + 1] || ''))
    .map((l) =>
      l
        .replace(/^\s*([-*+]\s+|\d+[.)]\s+|>\s*)/, '')
        .replace(/`([^`]{41,})`/g, '…')
        .trim(),
    );
  const flat = lines
    .join(' ')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  // Whole sentences while they fit, else the first words.
  const sentences = flat.split(/(?<=[.!?])\s+|(?<=[。！？])/).filter(Boolean);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out}${/[。！？]$/.test(out) ? '' : ' '}${s}` : s;
    if (wordCount(next) > words) break;
    out = next;
  }
  return out || firstWords(flat, words).text;
}

// ---------------------------------------------------------------- the asynchronous profiles

export type AsyncProfileId = 'pull-request' | 'issue' | 'release-notes' | 'comment' | 'message';

export interface AsyncProfile {
  id: AsyncProfileId;
  /** Words outside code blocks. */
  maxWords: number;
  /** Tool output allowed, inside a fenced block (and folded when long). */
  fencedOutput: boolean;
  /** One line for the tool description and the refusal. */
  shape: string;
}

/** Bodies of up to this many words need no structure: a one-line PR description is dense already. */
export const STRUCTURE_FROM_WORDS = 60;
/** Fenced blocks longer than this are folded into a <details> block. */
export const FOLD_LINES = 15;

export const ASYNC_PROFILES: Record<AsyncProfileId, AsyncProfile> = {
  'pull-request': {
    id: 'pull-request',
    maxWords: 1500,
    fencedOutput: true,
    shape: 'Markdown sections: ## Summary (what and why, two or three lines), ## Changes (a list), ## Testing (what you ran and what it showed), ## Risks if any',
  },
  issue: {
    id: 'issue',
    maxWords: 1500,
    fencedOutput: true,
    shape: 'a heading or list per part: what happens, steps to reproduce, expected and actual behaviour, environment',
  },
  'release-notes': { id: 'release-notes', maxWords: 1200, fencedOutput: true, shape: 'a two-line summary, then lists under Added / Changed / Fixed' },
  comment: { id: 'comment', maxWords: 600, fencedOutput: true, shape: 'the point first, then the evidence; output in a fenced block' },
  message: { id: 'message', maxWords: 150, fencedOutput: false, shape: 'a few plain sentences, no code or tool output (it goes to a chat)' },
};

const RELEASE_CHANNEL = /\b(release|changelog)/i;
const TEST_HEADING = /^#{1,6}\s+(testing|test plan|tests|verification|how to test|how i tested)\b/im;
const HEADING = /^#{1,6}\s+\S/gm;
const LIST = /^\s*([-*+]|\d+[.)])\s+\S/m;

/** The profile a draft of this kind is written under; null for a push (it has no body). */
export function asyncProfileFor(kind: DraftKind, channel?: string): AsyncProfileId | null {
  switch (kind) {
    case 'pr-open':
      return 'pull-request';
    case 'issue-open':
      return 'issue';
    case 'pr-comment':
    case 'issue-comment':
      return 'comment';
    case 'message':
      return RELEASE_CHANNEL.test(channel || '') ? 'release-notes' : 'message';
    default:
      return null;
  }
}

/** Why an agent's draft body does not fit its surface, or null. */
export function asyncRefusal(id: AsyncProfileId, body: string): string | null {
  const p = ASYNC_PROFILES[id];
  const prose = stripFences(body);
  if (PROMPT_TAG.test(body)) return 'The body contains prompt tags (<untrusted>, <event>…): write it for a person, and quote outside text as text.';
  const n = wordCount(prose);
  if (n > p.maxWords) return `The body has ${n} words outside code blocks; a ${id} takes at most ${p.maxWords}. Keep it dense: ${p.shape}.`;
  if (!p.fencedOutput) {
    const leak = toolOutputIn(body);
    return leak ? `A ${id} goes to a chat: it takes no ${leak}. Say what it means in a sentence or two.` : null;
  }
  const loose = toolOutputIn(prose);
  if (loose) return `The body has ${loose} outside a code block. Put tool output in a fenced block (\`\`\`), after the prose that says what it shows.`;
  if (n <= STRUCTURE_FROM_WORDS) return null;
  if (id === 'pull-request') {
    const headings = prose.match(HEADING)?.length ?? 0;
    if (headings < 2 || !TEST_HEADING.test(prose)) return `A pull request description this long needs structure: ${p.shape}. A ## Testing section is required.`;
  }
  if (id === 'issue' && !prose.match(HEADING) && !LIST.test(prose)) return `An issue this long needs structure: ${p.shape}.`;
  if (id === 'release-notes' && !LIST.test(prose)) return `Release notes need lists: ${p.shape}.`;
  return null;
}

/** Deterministic shaping: tidy whitespace, and fold long output into a collapsed <details> block. */
export function shapeAsync(id: AsyncProfileId, body: string): string {
  const out = body
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!ASYNC_PROFILES[id].fencedOutput) return out;
  const parts: string[] = [];
  for (const seg of segments(out)) {
    const block = seg.lines.join('\n');
    const inner = seg.lines.length - 2;
    // Already folded by the agent: the prose before it ends with a <summary>.
    const folded = /<summary>[^\n]*<\/summary>\s*$/.test(parts.join('\n'));
    parts.push(seg.fenced && inner > FOLD_LINES && !folded ? `<details><summary>Output (${inner} lines)</summary>\n\n${block}\n\n</details>` : block);
  }
  return parts.join('\n');
}

/** What the draft tool's description says about shape. */
export function asyncGuide(): string {
  return `Write the body for its surface: a pull request as ${ASYNC_PROFILES['pull-request'].shape}; an issue with ${ASYNC_PROFILES.issue.shape}; release notes (a message to a release channel) as ${ASYNC_PROFILES['release-notes'].shape}; a message as ${ASYNC_PROFILES.message.shape}. Dense, no chatter; tool output only in fenced blocks (long ones are folded).`;
}

// ---------------------------------------------------------------- the webhook's text

export const WEBHOOK_WORDS = REPLY_WORDS;

/**
 * A Router reply as it may leave the machine: code blocks dropped, long inline code elided, any line
 * that reads as tool output dropped, cut to the chat's word cap. Never file contents.
 */
export function webhookText(text: string): string {
  const lines = stripFences(text)
    .split('\n')
    .filter((l) => !outputLine(l) && !LOG_LINE.test(l) && !/```|~~~/.test(l))
    .map((l) => l.replace(/`([^`]{41,})`/g, '`…`').replace(/\s+$/, ''))
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  const joined = lines.join('\n').trim();
  return wordCount(joined) > WEBHOOK_WORDS ? firstWords(joined.replace(/\s+/g, ' '), WEBHOOK_WORDS).text : joined;
}
