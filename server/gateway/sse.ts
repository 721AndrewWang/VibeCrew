// An incremental parser for the Messages API's server-sent events: bytes in, whole events out,
// each with the exact text it arrived as (so an unchanged event goes out byte for byte).

export interface SseEvent {
  /** The event's lines and the blank line after it, as received. */
  raw: string;
  event?: string;
  /** The data lines joined, parsed as JSON when they are. */
  data?: unknown;
}

export class SseParser {
  private buf = '';

  /** Feeds a chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const raw = this.buf.slice(0, m.index + m[0].length);
      this.buf = this.buf.slice(m.index + m[0].length);
      out.push(parseEvent(raw));
    }
    return out;
  }

  /** Whatever is left when the stream ends (an event without its blank line). */
  rest(): string {
    const r = this.buf;
    this.buf = '';
    return r;
  }
}

function parseEvent(raw: string): SseEvent {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  const ev: SseEvent = { raw, event };
  if (data.length) {
    const text = data.join('\n');
    try {
      ev.data = JSON.parse(text);
    } catch {
      ev.data = text;
    }
  }
  return ev;
}

/** An event written back out, for one whose data changed. */
export function formatEvent(event: string | undefined, data: unknown): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}
