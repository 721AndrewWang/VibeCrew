/**
 * The logos to choose from in Settings → 外观. Each glyph is drawn in currentColor on a 128 × 128
 * grid, so the same markup makes the app icon (white on a dark tile), the logo inside the app (the
 * theme's logo colours) and the picker. After changing one, run `npm run icons` for the PNGs.
 */
export const LOGOS = [
  {
    id: 'c',
    name: 'C 字母',
    glyph: '<path d="M85.1 44.9A27 27 0 1 0 85.1 83.1" fill="none" stroke="currentColor" stroke-width="15" stroke-linecap="round"/>',
  },
  {
    id: 'orbit',
    name: '轨道小队',
    glyph:
      '<circle cx="64" cy="64" r="29" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="5"/>' +
      '<circle cx="64" cy="64" r="11" fill="currentColor"/><circle cx="64" cy="35" r="8.5" fill="currentColor"/>' +
      '<circle cx="38.9" cy="78.5" r="8.5" fill="currentColor"/><circle cx="89.1" cy="78.5" r="8.5" fill="currentColor"/>',
  },
  {
    id: 'bot',
    name: '机器人',
    glyph:
      '<rect x="32" y="48" width="64" height="46" rx="15" fill="none" stroke="currentColor" stroke-width="8"/>' +
      '<path d="M64 48V37" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><circle cx="64" cy="31" r="6.5" fill="currentColor"/>' +
      '<circle cx="52" cy="70" r="6" fill="currentColor"/><circle cx="76" cy="70" r="6" fill="currentColor"/>',
  },
  {
    id: 'prompt',
    name: '终端',
    glyph:
      '<path d="M38 44 60 64 38 84" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M68 84H90" stroke="currentColor" stroke-width="12" stroke-linecap="round"/>',
  },
  {
    id: 'wave',
    name: '声波',
    glyph: '<path d="M42 48V80M64 36V92M86 54V74" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/>',
  },
  {
    id: 'code',
    name: '代码括号',
    glyph:
      '<path d="M49 42 28 64 49 86M79 42l21 22-21 22" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="64" cy="64" r="9" fill="currentColor"/>',
  },
] as const;

export type LogoId = (typeof LOGOS)[number]['id'];

export const DEFAULT_LOGO: LogoId = 'c';

export function isLogoId(v: unknown): v is LogoId {
  return LOGOS.some((l) => l.id === v);
}

export function logoOf(id: string | undefined) {
  return LOGOS.find((l) => l.id === id) || LOGOS[0];
}

/** The app icon (Dock, window, tray, browser tab): the mark in white on a dark tile with a faint rim. */
export function appIconSvg(id: string | undefined): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#303030"/><stop offset="1" stop-color="#0b0b0b"/></linearGradient></defs>' +
    '<rect width="128" height="128" rx="28" fill="url(#bg)"/>' +
    '<rect x="1" y="1" width="126" height="126" rx="27" fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="2"/>' +
    logoOf(id).glyph.replaceAll('currentColor', '#fff') +
    '</svg>\n'
  );
}
