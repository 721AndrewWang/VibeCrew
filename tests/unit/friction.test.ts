import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-friction-')), 'friction.jsonl');
vi.mock('../../server/config', () => ({ DATA: { friction: file } }));

const { frictionReport, recordFriction, GUARDED_FILES } = await import('../../server/friction');

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 8);

beforeEach(() => fs.rmSync(file, { force: true }));

describe('frictionReport', () => {
  it('groups by kind and cause, worst first, inside the window', () => {
    for (let i = 0; i < 3; i++) recordFriction({ at: now - DAY, kind: 'approval-readonly', key: 'Bash(ls*)', detail: `Forge: ls ${i}`, chatId: 'c1', chatTitle: 'Squad' });
    recordFriction({ at: now - DAY, kind: 'approval-readonly', key: 'Bash(cat*)', detail: 'Forge: cat a' });
    recordFriction({ at: now - 2 * DAY, kind: 'stall', key: 'Nobody picked up after Chief handed back', detail: 'Chief stopped' });
    recordFriction({ at: now - 30 * DAY, kind: 'turn-error', key: 'old', detail: 'too old' });
    const r = frictionReport(7, now);
    expect(r.total).toBe(5);
    expect(r.kinds.map((k) => [k.kind, k.count])).toEqual([
      ['approval-readonly', 4],
      ['stall', 1],
    ]);
    const ro = r.kinds[0];
    expect(ro.groups.map((g) => [g.key, g.count])).toEqual([
      ['Bash(ls*)', 3],
      ['Bash(cat*)', 1],
    ]);
    // Newest example first.
    expect(ro.groups[0].examples[0].detail).toBe('Forge: ls 2');
  });

  it('skips torn lines and unknown kinds', () => {
    recordFriction({ at: now, kind: 'stall', key: 'k', detail: 'd' });
    fs.appendFileSync(file, '{"at":1,"kind":"nope","key":"x","detail":"y"}\n{"at":');
    expect(frictionReport(7, now + 1).total).toBe(1);
  });

  it('caps and flattens details', () => {
    recordFriction({ at: now, kind: 'turn-error', key: 'k', detail: `a\n\nb ${'x'.repeat(500)}` });
    const d = frictionReport(7, now).kinds[0].groups[0].examples[0].detail;
    expect(d.startsWith('a b x')).toBe(true);
    expect(d.length).toBe(300);
  });

  it('is empty with no brief when nothing happened', () => {
    const r = frictionReport(7, now);
    expect(r).toMatchObject({ total: 0, kinds: [], brief: '' });
  });
});

describe('the brief', () => {
  it('names the lead to fill in, the evidence, the guarded files, and leaves merging to the user', () => {
    recordFriction({ at: now, kind: 'hop-limit', key: '"Squad" limit 15', detail: 'Reached 15 handoffs', chatTitle: 'Squad' });
    const { brief } = frictionReport(14, now);
    expect(brief.startsWith("@{lead} Here's Crew's friction report for the last 14 days")).toBe(true);
    expect(brief).toContain('- Automatic handoffs hit the limit: 1x');
    expect(brief).toContain('"Squad" limit 15 (1x) e.g. Reached 15 handoffs ("Squad")');
    for (const f of GUARDED_FILES) expect(brief).toContain(f);
    expect(brief).toContain("Don't merge, push, package or restart Crew");
  });
});
