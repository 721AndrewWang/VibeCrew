import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTrace, readTurnRows, transcriptPath, turnTrace } from '../../server/trace';
import { tempDir } from '../helpers/server';

// Rows in the shape Claude Code writes (trimmed to what the trace reads).
const T0 = Date.parse('2026-10-01T07:55:39.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const S = 'sess-1';
const rows = [
  { type: 'user', sessionId: S, timestamp: at(0), uuid: 'u1', message: { role: 'user', content: '<context>…</context>\n\nAdd a section to the home page' } },
  { type: 'attachment', sessionId: S, timestamp: at(10), uuid: 'a1', attachment: { type: 'sandbox_instructions' } },
  {
    type: 'assistant',
    sessionId: S,
    timestamp: at(5500),
    uuid: 'm1a',
    effort: 'high',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: 'Look at the files first' }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 14317, cache_read_input_tokens: 10522, output_tokens: 279, output_tokens_details: { thinking_tokens: 157 } },
    },
  },
  {
    type: 'assistant',
    sessionId: S,
    timestamp: at(6400),
    uuid: 'm1b',
    effort: 'high',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 14317, cache_read_input_tokens: 10522, output_tokens: 279 },
    },
  },
  {
    type: 'user',
    sessionId: S,
    timestamp: at(6500),
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'index.html\nstyles.css' }] },
    toolUseResult: {},
  },
  {
    type: 'assistant',
    sessionId: S,
    timestamp: at(25_000),
    uuid: 'm2',
    message: {
      id: 'msg_2',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'Over to @Pixel' }],
      usage: { input_tokens: 5, cache_read_input_tokens: 24800, output_tokens: 1035, output_tokens_details: { thinking_tokens: 600 } },
    },
  },
  // Another turn, long after: not part of this one.
  { type: 'user', sessionId: S, timestamp: at(120_000), uuid: 'u9', message: { role: 'user', content: 'Again' } },
  // Another session in the same file: never.
  {
    type: 'assistant',
    sessionId: 'other',
    timestamp: at(7000),
    uuid: 'x',
    message: { id: 'msg_x', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'title' }], usage: { output_tokens: 18 } },
  },
];

describe('buildTrace', () => {
  const { steps, totals } = buildTrace(rows.filter((r) => r.sessionId === S && Date.parse(r.timestamp) < T0 + 60_000) as any, T0);
  it('makes one step per API call, joining its rows, plus prompts, results and attachments', () => {
    expect(steps.map((s) => s.kind)).toEqual(['prompt', 'attachment', 'model', 'tool_result', 'model']);
    const call = steps[2];
    if (call.kind !== 'model') throw new Error('not a model step');
    expect(call.blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(call.usage).toEqual({ input: 2, cacheRead: 10522, cacheWrite: 14317, output: 279, thinking: 157 });
    expect(call.effort).toBe('high');
    expect(call.at).toBe(5500);
    expect(call.waitMs).toBe(5500);
  });
  it('sums the turn', () => {
    expect(totals).toEqual({ calls: 2, tools: 1, input: 7, cacheRead: 35322, cacheWrite: 14317, output: 1314, thinking: 757, durationMs: 25_000 });
  });
  it('keeps the tool result and what was sent', () => {
    expect(steps[0]).toMatchObject({ kind: 'prompt', text: expect.stringContaining('Add a section to the home page') });
    expect(steps[3]).toMatchObject({ kind: 'tool_result', toolUseId: 'toolu_1', isError: false, text: 'index.html\nstyles.css' });
  });
});

describe('parallel tool calls', () => {
  it('are one API call even with their results written in between', () => {
    const usage = { input_tokens: 12, cache_read_input_tokens: 34_000, cache_creation_input_tokens: 1500, output_tokens: 617, output_tokens_details: { thinking_tokens: 77 } };
    const call = (uuid: string, block: object, ms: number) => ({
      type: 'assistant',
      sessionId: S,
      requestId: 'req_7',
      timestamp: at(ms),
      uuid,
      message: { id: 'msg_7', model: 'claude-opus-5-5', content: [block], usage },
    });
    const result = (id: string, ms: number) => ({
      type: 'user',
      sessionId: S,
      timestamp: at(ms),
      uuid: `r${id}`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      toolUseResult: {},
    });
    const { steps, totals } = buildTrace(
      [
        call('c1', { type: 'thinking', thinking: '…' }, 7000),
        call('c2', { type: 'tool_use', id: 't1', name: 'Edit', input: {} }, 7100),
        result('t1', 8800),
        call('c3', { type: 'tool_use', id: 't2', name: 'Edit', input: {} }, 10_500),
        result('t2', 10_500),
        call('c4', { type: 'tool_use', id: 't3', name: 'Edit', input: {} }, 10_600),
        result('t3', 10_600),
      ] as any,
      T0,
    );
    expect(steps.map((s) => s.kind)).toEqual(['model', 'tool_result', 'tool_result', 'tool_result']);
    expect(totals.calls).toBe(1);
    expect(totals.output).toBe(617);
    expect(totals.cacheRead).toBe(34_000);
    if (steps[0].kind === 'model') expect(steps[0].blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_use', 'tool_use']);
  });
});

describe('turnTrace', () => {
  it('reads the turn from the transcript file, skipping other sessions, other turns and a torn line', () => {
    const home = tempDir('crew-trace');
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const cwd = '/home/u/My Site_v2';
      const file = transcriptPath(cwd, S);
      expect(file).toBe(path.join(home, 'projects', '-home-u-My-Site-v2', `${S}.jsonl`));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{"type":"assistant","sess`);
      const t = turnTrace({ sessionId: S, cwd, from: T0, to: T0 + 30_000 });
      expect(t.available).toBe(true);
      if (!t.available) return;
      expect(t.totals.calls).toBe(2);
      expect(readTurnRows(file, S, T0, T0 + 30_000)).toHaveLength(6);
      expect(turnTrace({ sessionId: 'nope', cwd, from: T0, to: T0 + 1 })).toMatchObject({ available: false, reason: expect.stringContaining("Can't find") });
      expect(turnTrace(undefined)).toMatchObject({ available: false });
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('keys the transcript folder by the real path, the one Claude Code sees as its working directory', () => {
    // macOS keeps temp folders under /var -> /private/var, and a project may sit behind a symlink
    // anywhere; the CLI resolves its cwd, so the folder is named after the resolved path.
    const home = tempDir('crew-trace');
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const real = path.join(home, 'site');
      const link = path.join(home, 'link');
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      const key = fs.realpathSync.native(real).replace(/[^a-zA-Z0-9]/g, '-');
      expect(transcriptPath(link, S)).toBe(path.join(home, 'projects', key, `${S}.jsonl`));
      expect(transcriptPath(link, S)).toBe(transcriptPath(real, S));
      // A folder that no longer exists keeps the spelling it was recorded with.
      expect(transcriptPath(path.join(home, 'gone'), S)).toBe(path.join(home, 'projects', path.join(home, 'gone').replace(/[^a-zA-Z0-9]/g, '-'), `${S}.jsonl`));
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});
