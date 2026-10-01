import { describe, expect, it } from 'vitest';
import { appIconSvg, DEFAULT_LOGO, isLogoId, LOGOS, logoOf } from '../../shared/logos';

describe('logos', () => {
  it('has unique ids and a default among them', () => {
    const ids = LOGOS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_LOGO);
  });
  it('draws every glyph in currentColor only', () => {
    for (const l of LOGOS)
      expect(
        l.glyph.match(/(?:fill|stroke)="(?!none)([^"]+)"/g)?.every((a) => a.includes('currentColor')),
        l.id,
      ).toBe(true);
  });
  it('validates ids', () => {
    expect(isLogoId('c')).toBe(true);
    expect(isLogoId('v')).toBe(false);
    expect(isLogoId('../x')).toBe(false);
    expect(isLogoId(undefined)).toBe(false);
  });
  it('falls back to the first logo', () => {
    expect(logoOf('nope').id).toBe(LOGOS[0].id);
  });
  it('makes a white-on-dark app icon', () => {
    const svg = appIconSvg('code');
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain(logoOf('code').glyph.replaceAll('currentColor', '#fff'));
    expect(svg).not.toContain('currentColor');
  });
});
