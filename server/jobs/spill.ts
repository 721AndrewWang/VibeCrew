// Inline & Spill for background jobs (ADR 004): a result shows the head and the tail of the
// output with the job's id; the rest stays in the log, read by slice ("read more"). Pure.

import type { BackgroundJob } from '../../shared/types';

export const HEAD = { lines: 20, chars: 1500 };
export const TAIL = { lines: 40, chars: 3000 };
/** The most one `status` read returns. */
export const SLICE = { lines: 400, chars: 16_000 };

const cutStart = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const cutEnd = (s: string, max: number) => (s.length > max ? `…${s.slice(-max)}` : s);

/** Splits output into lines, without the empty one a trailing newline leaves. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The output as it is inlined: all of it when it fits, else the head and the tail with what was left
 * out and how to read it in between. `omitted` names the first left-out line, 1-based.
 */
export function inlineOutput(lines: string[], id: string): string {
  const all = lines.join('\n');
  if (lines.length <= HEAD.lines + TAIL.lines && all.length <= HEAD.chars + TAIL.chars) return all;
  const head = lines.slice(0, HEAD.lines);
  const tail = lines.slice(Math.max(HEAD.lines, lines.length - TAIL.lines));
  const omitted = lines.length - head.length - tail.length;
  const from = head.length + 1;
  const gap =
    omitted > 0 ? `… ${omitted} line${omitted === 1 ? '' : 's'} omitted (read them with status id=${id} from=${from} lines=200) …` : '… (long lines shortened; read them in full with status) …';
  return [cutStart(head.join('\n'), HEAD.chars), gap, cutEnd(tail.join('\n'), TAIL.chars)].join('\n');
}

/** A slice of the log for `status id from lines`: 1-based, bounded by SLICE. */
export function sliceLines(lines: string[], from = 1, count = 200): { from: number; lines: string[] } {
  const start = Math.max(1, Math.min(Math.floor(from) || 1, lines.length || 1));
  const n = Math.max(1, Math.min(Math.floor(count) || 200, SLICE.lines));
  const out: string[] = [];
  let size = 0;
  for (const l of lines.slice(start - 1, start - 1 + n)) {
    if (size + l.length > SLICE.chars && out.length) break;
    out.push(l.length > SLICE.chars ? `${l.slice(0, SLICE.chars)}…` : l);
    size += l.length + 1;
  }
  return { from: start, lines: out };
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const STATUS_WORD: Record<BackgroundJob['status'], string> = { running: 'running', waiting: 'waiting for an approval', done: 'finished', failed: 'failed', stopped: 'stopped' };

/** One line about a job: id, kind, outcome, duration, size. */
export function jobLine(j: BackgroundJob, now = Date.now()): string {
  const bits = [j.id, j.kind === 'command' ? 'command' : 'sub-task', STATUS_WORD[j.status]];
  if (j.kind === 'command' && j.exitCode !== undefined && j.exitCode !== null) bits.push(`exit ${j.exitCode}`);
  if (j.signal) bits.push(j.signal);
  bits.push(fmtDuration((j.endedAt ?? now) - j.startedAt));
  if (j.kind === 'command') bits.push(`${j.lines.toLocaleString('en-US')} line${j.lines === 1 ? '' : 's'}${j.truncated ? ' (log capped)' : ''}`);
  if (j.sandboxed) bits.push('sandboxed');
  return `${bits.join(' · ')}: ${j.title}${j.detail ? ` (${j.detail})` : ''}`;
}

/**
 * The result as it is delivered to the session (and shown by stop/status): the job's line, what it
 * ran, then the output inlined and spilled. Output is fenced as data: it comes from a program.
 */
export function resultText(j: BackgroundJob, output: string[]): string {
  const what = j.kind === 'command' ? `$ ${cutStart(j.command || '', 500)}` : `Task: ${cutStart((j.task || '').replace(/\s+/g, ' '), 300)}`;
  const body = output.length ? inlineOutput(output, j.id) : '(no output)';
  const label = j.kind === 'command' ? 'output' : 'report';
  return [`Background job ${jobLine(j)}`, what, `<job_${label} id="${j.id}">`, defuse(body), `</job_${label}>`].join('\n');
}

/** Output cannot close the fence it is in, or open one of Crew's own tags. */
export function defuse(text: string): string {
  return text.replace(/<(\/?)(job_output|job_report|new_input)/gi, '<$1 $2');
}
