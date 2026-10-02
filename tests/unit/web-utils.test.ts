import { describe, expect, it } from 'vitest';
import { fmtDuration, modelLabel, PERMISSION_INFO } from '../../web/src/utils';

describe('modelLabel', () => {
  it('names Claude models the way people say them', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude-opus-5[1m]')).toBe('Opus 5（1M）');
  });
  it('leaves other providers’ ids alone', () => {
    expect(modelLabel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(modelLabel('')).toBe('');
    expect(modelLabel(undefined)).toBe('');
  });
});

describe('fmtDuration', () => {
  it('reads like a person would say it', () => {
    expect(fmtDuration(855)).toBe('855ms');
    expect(fmtDuration(6 * 60_000 + 27_000)).toBe('6分27秒');
  });
});

describe('PERMISSION_INFO', () => {
  it('describes every level', () => {
    for (const k of ['auto', 'edits', 'ask', 'review', 'plan'] as const) {
      expect(PERMISSION_INFO[k].label).toBeTruthy();
      expect(PERMISSION_INFO[k].desc).toBeTruthy();
    }
  });
});
