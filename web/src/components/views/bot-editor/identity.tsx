import { cx } from '../../../utils';

export const BOT_NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

const PRESET_COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];

/** In the black / white / grey look avatars show a grey line icon; colour and emoji apply with a colour accent. */
export function MonoAvatarHint() {
  if (document.documentElement.dataset.accent) return null;
  return <div className="hint">现在是黑白灰外观，头像统一显示为灰色线条图标；在「设置 → 外观」选彩色主题色后，会显示这里的颜色和表情。</div>;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="swatches">
      {PRESET_COLORS.map((c) => (
        <button key={c} type="button" className={cx('swatch', value.toLowerCase() === c && 'on')} style={{ background: c }} title={c} aria-label={c} onClick={() => onChange(c)} />
      ))}
      <label className="swatch custom" title="自定义颜色">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#0a84ff'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
