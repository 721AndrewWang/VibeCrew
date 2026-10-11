import { cx } from '../../../utils';

export const BOT_NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

const PRESET_COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];

/** In the black / white / grey look avatars show a grey line icon; colour and emoji apply with a colour accent. */
export function MonoAvatarHint() {
  if (document.documentElement.dataset.accent) return null;
  return <div className="hint">The black and white look shows every avatar as a grey line icon. Pick a color accent in Settings → Appearance to see the color and emoji chosen here.</div>;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="swatches">
      {PRESET_COLORS.map((c) => (
        <button key={c} type="button" className={cx('swatch', value.toLowerCase() === c && 'on')} style={{ background: c }} title={c} aria-label={c} onClick={() => onChange(c)} />
      ))}
      <label className="swatch custom" title="Custom color">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#0a84ff'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
