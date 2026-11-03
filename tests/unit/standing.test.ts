// Standing rules (ADR 108): a candidate the default policy line already decides is settled in code,
// only while the user's policies still hold that line word for word.
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES, type FastInput, fastPath, normalizeSuperAgent } from '../../server/triggers/fastPath';
import { POLICY_LINES, STANDING_RULE, standingRule } from '../../server/triggers/standing';
import type { Thread, Trigger } from '../../shared/types';

const NOW = 1_700_000_000_000;
const thread: Thread = { id: 'th_1', key: 'k', kind: 'workspace', title: 'Workspace', projectId: 'p1', chatId: null, createdAt: NOW, lastAt: NOW, count: 0 };
const settings = (policies = DEFAULT_POLICIES) => normalizeSuperAgent({ enabled: true, policies });
const ctx = (o: { policies?: string; recent?: Trigger[]; candidatesLastHour?: number } = {}) => ({
  settings: settings(o.policies),
  thread,
  recent: o.recent ?? [],
  candidatesLastHour: o.candidatesLastHour ?? 0,
  now: NOW,
});
const input = (p: Partial<FastInput>): FastInput => ({ source: 'preview-console', explicit: false, rootProjectId: 'p1', subjects: [], fingerprint: 'f1', facts: {}, ...p });
const check = (conclusion: string) => input({ source: 'github', subjects: ['check', 'ci', conclusion, 'abc123'] });

describe('standing rules', () => {
  it('builds the default policies from the lines the rules apply', () => {
    for (const line of Object.values(POLICY_LINES)) expect(DEFAULT_POLICIES).toContain(line);
    expect(DEFAULT_POLICIES.endsWith('- When unsure, stay quiet.')).toBe(true);
  });

  it('acts on a failing check on a pull request without the model, and leaves other GitHub events to it', () => {
    const f = fastPath(check('failure'), ctx());
    expect(f).toMatchObject({ verdict: 'act', stage: 'fast', rule: STANDING_RULE });
    expect(f.reason).toContain('The check ci failed');
    expect(fastPath(check('timed_out'), ctx()).verdict).toBe('act');
    expect(fastPath(input({ source: 'github', subjects: ['issue', 'alice', 'The checkout is broken'] }), ctx()).verdict).toBe('candidate');
  });

  it('drops a turn that failed on a passing network or provider error, and leaves the rest to the model', () => {
    const turn = (error: string) => fastPath(input({ source: 'turn', subjects: [error], facts: { status: 'error' } }), ctx());
    expect(turn('API Error: 529 overloaded_error')).toMatchObject({ verdict: 'drop', rule: STANDING_RULE });
    expect(turn('socket hang up')).toMatchObject({ verdict: 'drop', rule: STANDING_RULE });
    expect(turn('Not logged in · Please run /login').verdict).toBe('candidate');
    expect(turn('Monthly budget reached').verdict).toBe('candidate');
  });

  it('acts on a changed dependency manifest or build config, and leaves ordinary edits to the model', () => {
    const edit = (paths: string[]) => fastPath(input({ source: 'outside-edit', subjects: paths }), ctx());
    expect(edit(['src/App.tsx', 'package.json'])).toMatchObject({ verdict: 'act', rule: STANDING_RULE });
    expect(edit(['web/vite.config.ts']).verdict).toBe('act');
    expect(edit(['tsconfig.app.json']).verdict).toBe('act');
    expect(edit(['src/App.tsx', 'README.md']).verdict).toBe('candidate');
    expect(edit(['src/package.json.bak']).verdict).toBe('candidate');
  });

  it('drops console errors that all come from extensions, ads or analytics', () => {
    const errors = (subjects: string[]) => fastPath(input({ subjects, facts: { errors: subjects.length } }), ctx());
    expect(errors(['Uncaught TypeError (chrome-extension://abc/content.js:1)', 'Failed to load https://www.googletagmanager.com/gtm.js'])).toMatchObject({ verdict: 'drop', rule: STANDING_RULE });
    expect(errors(['Uncaught TypeError (chrome-extension://abc/content.js:1)', 'ReferenceError: total is not defined (src/cart.ts:12)']).verdict).toBe('candidate');
  });

  it('holds only while the user keeps the line word for word', () => {
    const edited = DEFAULT_POLICIES.replace(POLICY_LINES.github, '- GitHub: tell me about failing checks only on main.');
    expect(fastPath(check('failure'), ctx({ policies: edited })).verdict).toBe('candidate');
    expect(standingRule(check('failure'), '')).toBeNull();
    expect(standingRule(check('failure'), DEFAULT_POLICIES)?.verdict).toBe('act');
  });

  it('comes after the cooldown and the duplicate rule, and takes nothing from the hourly model budget', () => {
    const settled = { id: 'tg_1', at: NOW - 60_000, fingerprint: 'f1', filter: { verdict: 'act', stage: 'fast', rule: STANDING_RULE, reason: '' } } as Trigger;
    expect(fastPath(check('failure'), ctx({ recent: [settled] }))).toMatchObject({ verdict: 'drop', rule: 'duplicate' });
    expect(fastPath(check('failure'), { ...ctx(), thread: { ...thread, lastNoticeAt: NOW - 60_000 } }).rule).toBe('cooldown');
    expect(fastPath(check('failure'), ctx({ candidatesLastHour: 999 })).verdict).toBe('act');
  });
});
