// The Super-agent views' shared vocabulary and colours (ADR 107): every part has one name, says what
// it does and what it costs under the current limits, names what it needs first; a status's tone is
// orange only when it waits for the user; and the muted text and status colours keep WCAG AA
// contrast on every surface, in both themes.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUPER_AGENT } from '../../server/triggers/fastPath';
import type { PublicSettings } from '../../shared/types';
import {
  blockedBy,
  corePatch,
  DRAFT_STATUS,
  fmtCost,
  JOB_STATUS,
  PART,
  PARTS,
  partPatch,
  ROUTER_STATE,
  SPECULATION_STATUS,
  type StatusInfo,
  switchOn,
  TICK_OUTCOME,
  TONE_CLASS,
  TRIGGER_VERDICT,
  WATCHDOG_STATE,
  WORKER_STATUS,
} from '../../web/src/superagent';

const settings = (sa: Partial<PublicSettings['superAgent']> = {}, gateway = false) =>
  ({ superAgent: { ...structuredClone(DEFAULT_SUPER_AGENT), ...sa }, gateway: { enabled: gateway } }) as unknown as PublicSettings;

describe('the parts of Super-agent mode', () => {
  it('each has one name, says what it does and what it costs, and needs only parts that exist', () => {
    expect(new Set(PARTS.map((p) => p.id)).size).toBe(PARTS.length);
    expect(new Set(PARTS.map((p) => p.name)).size).toBe(PARTS.length);
    for (const p of PARTS) {
      expect(p.does.length).toBeGreaterThan(30);
      expect(p.cost(settings()).length).toBeGreaterThan(10);
      if (p.needs) expect(PART[p.needs]).toBeDefined();
    }
  });

  it('states costs from the current limits, not the defaults', () => {
    const s = settings({ watchdog: { ...DEFAULT_SUPER_AGENT.watchdog, maxTicksPerHour: 2, dailyBudgetUsd: 3 } });
    expect(PART.watchdog.cost(s)).toBe('No model call while nothing is flagged; at most 2 looks an hour and $3.00 a day.');
    expect(PART.triggers.cost(settings({ maxCandidatesPerHour: 0 }))).toMatch(/^No model call/);
    expect(PART.speculative.cost(settings({ speculative: { ...DEFAULT_SUPER_AGENT.speculative, maxConcurrent: 1 } }))).toContain('at most 1 at once');
  });

  it('names the nearest part that has to be on first', () => {
    const off = settings();
    expect(blockedBy('triggers', off)).toBeUndefined();
    expect(blockedBy('router', off)?.id).toBe('triggers');
    expect(blockedBy('direct', off)?.id).toBe('router');
    const bus = settings({ enabled: true });
    expect(blockedBy('direct', bus)?.id).toBe('router');
    expect(blockedBy('watchdog', bus)).toBeUndefined();
    expect(blockedBy('direct', settings({ enabled: true, router: { ...DEFAULT_SUPER_AGENT.router, enabled: true } }))).toBeUndefined();
  });

  it('turns parts on and off with patches that keep their other settings', () => {
    const s = settings({ enabled: true, router: { ...DEFAULT_SUPER_AGENT.router, maxWorkers: 5 } });
    expect(partPatch('router', true, s)).toEqual({ router: { ...s.superAgent.router, enabled: true } });
    expect(partPatch('direct', true, s).router?.maxWorkers).toBe(5);
    expect(partPatch('triggers', false, s)).toEqual({ enabled: false });
    const core = { ...s.superAgent, ...corePatch(s) } as PublicSettings['superAgent'];
    const after = { ...s, superAgent: core } as PublicSettings;
    for (const p of PARTS.filter((x) => x.core)) expect(switchOn(p.id, after)).toBe(true);
    expect(switchOn('watchdog', after)).toBe(false);
    expect(core.router.maxWorkers).toBe(5);
    expect(switchOn('gateway', settings({}, true))).toBe(true);
  });
});

describe('status tones', () => {
  const maps: Record<string, Record<string, StatusInfo>> = { WORKER_STATUS, JOB_STATUS, SPECULATION_STATUS, DRAFT_STATUS, ROUTER_STATE, WATCHDOG_STATE, TICK_OUTCOME, TRIGGER_VERDICT };

  it('keeps orange for what waits for the user, and nothing else', () => {
    const attention = Object.entries(maps).flatMap(([m, map]) =>
      Object.entries(map)
        .filter(([, v]) => v.tone === 'attention')
        .map(([k]) => `${m}.${k}`),
    );
    expect(attention.sort()).toEqual(['DRAFT_STATUS.pending', 'JOB_STATUS.waiting', 'SPECULATION_STATUS.ready', 'WORKER_STATUS.waiting']);
    expect(TONE_CLASS.attention).toBe('orange');
  });

  it('reads work in progress as active, never as needing the user', () => {
    expect(TRIGGER_VERDICT.candidate.tone).toBe('active');
    expect(SPECULATION_STATUS.verifying).toEqual({ label: 'Checking', tone: 'active' });
    expect(WATCHDOG_STATE.thinking.tone).toBe('active');
  });

  it('formats every cost the same way', () => {
    expect([fmtCost(0), fmtCost(undefined), fmtCost(0.002), fmtCost(0.4567), fmtCost(12.4)]).toEqual(['$0.00', '$0.00', '<$0.01', '$0.46', '$12']);
  });
});

describe('colour contrast of the theme tokens (WCAG AA, 4.5:1 for small text)', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '../../web/src/styles/base.css'), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('\n}', start));
  };
  const tokens = (text: string) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const rgb = (v: string): [number, number, number, number] => {
    const hex = v.match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) throw new Error(`not a colour: ${v}`);
    const p = m[1].split(/[\s,]+/).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const over = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] =>
    [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as [number, number, number, number];
  const lum = (c: number[]) => {
    const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  const themes = { light: tokens(block(':root')), dark: tokens(block(':root[data-theme="dark"]')) };

  it('matches the dark theme chosen by the system to the one chosen in Settings', () => {
    const system = tokens(block('  :root:not([data-theme="light"])'));
    for (const k of ['text-3', 'green', 'orange', 'red']) expect(system[k]).toBe(themes.dark[k]);
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`keeps muted text and status colours readable in the ${name} theme`, () => {
      const surfaces = ['bg', 'bg-elev', 'bg-sunken', 'sidebar'].map((k) => rgb(t[k]));
      const low: string[] = [];
      for (const fg of ['text-2', 'text-3', 'green', 'orange', 'red'])
        for (const [i, bg] of surfaces.entries()) if (ratio(rgb(t[fg]), bg) < 4.5) low.push(`${fg} on surface ${i}: ${ratio(rgb(t[fg]), bg).toFixed(2)}`);
      // A badge draws its colour on its own soft tint over a card.
      for (const tone of ['green', 'orange', 'red']) {
        const badge = over(rgb(t[`${tone}-soft`]), rgb(t['bg-elev']));
        if (ratio(rgb(t[tone]), badge) < 4.5) low.push(`${tone} badge: ${ratio(rgb(t[tone]), badge).toFixed(2)}`);
      }
      expect(low).toEqual([]);
    });
  }
});
