// The trajectory of a turn: every model call and tool result Claude Code recorded while the bot
// worked, read from its own transcript (~/.claude/projects/<cwd>/<session>.jsonl). Crew keeps
// the message, not the trajectory; the transcript is the complete record of what the model saw
// and said, and reading it on demand answers "why did this turn cost $0.27".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TraceStep, TraceTotals, TurnTrace } from '../shared/types';

/** Claude Code keeps one folder per working directory, named by the path with everything but letters and digits turned into dashes. */
export function transcriptDir(cwd: string): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(transcriptDir(cwd), `${sessionId}.jsonl`);
}

/** How far outside the turn's own window transcript rows are still taken as its own (clock skew, last writes). */
const SLACK_MS = 3000;

interface Row {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  requestId?: string;
  effort?: string;
  message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Record<string, unknown> };
  toolUseResult?: unknown;
  attachment?: { type?: string };
}

const CLIP = 20_000;
const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text || '') : '')).join('');
}

const emptyTotals = (): TraceTotals => ({ calls: 0, tools: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, durationMs: 0 });

/** Reads the rows of one transcript that fall inside the turn. */
export function readTurnRows(file: string, sessionId: string, from: number, to: number): Row[] {
  const out: Row[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: Row;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a torn last line
    }
    if (r.sessionId && r.sessionId !== sessionId) continue;
    if (!r.timestamp) continue;
    const t = Date.parse(r.timestamp);
    if (t < from - SLACK_MS || t > to + SLACK_MS) continue;
    out.push(r);
  }
  return out;
}

/** Turns transcript rows into a timeline: one step per model call (its blocks together), per tool result, per prompt. */
export function buildTrace(rows: Row[], from: number): { steps: TraceStep[]; totals: TraceTotals } {
  const steps: TraceStep[] = [];
  const totals = emptyTotals();
  // Rows of one API call share its request and message ids. Claude Code writes each block as its
  // own row and may put the tool results of parallel calls in between, so the join is by id, not
  // by adjacency.
  const calls = new Map<string, number>();
  let last = from;
  for (const r of rows) {
    const t = Date.parse(r.timestamp!);
    const at = Math.max(0, t - from);
    if (r.type === 'assistant' && r.message) {
      const m = r.message;
      const u = (m.usage || {}) as Record<string, number>;
      const blocks = (Array.isArray(m.content) ? m.content : []).map((c: any) => {
        if (c.type === 'thinking') return { type: 'thinking' as const, text: clip(String(c.thinking || '')) };
        if (c.type === 'tool_use') return { type: 'tool_use' as const, id: String(c.id || ''), name: String(c.name || ''), input: clip(JSON.stringify(c.input ?? {})) };
        return { type: 'text' as const, text: clip(String(c.text || '')) };
      });
      const key = `${r.requestId || ''}:${m.id || r.uuid || ''}`;
      const seen = calls.get(key);
      if (seen !== undefined) {
        const s = steps[seen];
        if (s.kind === 'model') s.blocks.push(...blocks);
        continue;
      }
      const usage = {
        input: u.input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        output: u.output_tokens || 0,
        thinking: (u.output_tokens_details as any)?.thinking_tokens || 0,
      };
      calls.set(key, steps.length);
      steps.push({ kind: 'model', at, waitMs: Math.max(0, t - last), model: m.model || '', effort: r.effort, sidechain: !!r.isSidechain, usage, blocks });
      totals.calls += 1;
      totals.input += usage.input;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.output += usage.output;
      totals.thinking += usage.thinking;
      last = t;
    } else if (r.type === 'user' && r.message) {
      const content = r.message.content;
      const results = Array.isArray(content) ? content.filter((c: any) => c?.type === 'tool_result') : [];
      if (results.length) {
        for (const c of results as any[]) {
          steps.push({ kind: 'tool_result', at, waitMs: Math.max(0, t - last), toolUseId: String(c.tool_use_id || ''), isError: !!c.is_error, text: clip(textOf(c.content)) });
          totals.tools += 1;
        }
      } else {
        steps.push({ kind: 'prompt', at, text: clip(textOf(content)), sidechain: !!r.isSidechain });
      }
      last = t;
    } else if (r.type === 'attachment' && r.attachment) {
      steps.push({ kind: 'attachment', at, type: String(r.attachment.type || 'attachment') });
    }
  }
  totals.durationMs = Math.max(0, last - from);
  return { steps, totals };
}

/** The trace of a turn, or why there is none. */
export function turnTrace(meta: { sessionId: string; cwd: string; from: number; to: number } | undefined): TurnTrace {
  if (!meta) return { available: false, reason: 'No session info was recorded for this turn (demo mode, or a message from an older version).' };
  const file = transcriptPath(meta.cwd, meta.sessionId);
  if (!fs.existsSync(file)) return { available: false, reason: `Can't find the Claude Code session log (${file}). It may have been cleaned up.` };
  const rows = readTurnRows(file, meta.sessionId, meta.from, meta.to);
  if (!rows.length) return { available: false, reason: 'The session log has nothing for this turn.' };
  const { steps, totals } = buildTrace(rows, meta.from);
  return { available: true, sessionId: meta.sessionId, file, steps, totals };
}

/** The raw transcript rows of the turn, as JSON Lines, for analysis elsewhere. */
export function turnTraceRaw(meta: { sessionId: string; cwd: string; from: number; to: number }): string | null {
  const file = transcriptPath(meta.cwd, meta.sessionId);
  if (!fs.existsSync(file)) return null;
  return readTurnRows(file, meta.sessionId, meta.from, meta.to)
    .map((r) => JSON.stringify(r))
    .join('\n');
}
