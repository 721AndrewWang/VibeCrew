import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { LOGOS, type LogoId } from '../../../../../shared/logos';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { cx } from '../../../utils';
import { Logo } from '../../ui';
import { Section } from './Section';

type Theme = 'system' | 'light' | 'dark';

/** Accent presets; the colours match the [data-accent] blocks in styles/base.css. 'mono' is none. */
const ACCENTS = [
  { id: 'mono', name: '黑白灰', from: '#111111', to: '#8c8c8c' },
  { id: 'glacier', name: '冰川蓝', from: '#2f6ff0', to: '#13aee0' },
  { id: 'ocean', name: '深海蓝', from: '#2d5be3', to: '#5a4ff0' },
  { id: 'teal', name: '青碧', from: '#0c93a3', to: '#22c3b0' },
  { id: 'indigo', name: '靛紫', from: '#5b5ff0', to: '#9068f2' },
] as const;

function readAccent(): string {
  try {
    return localStorage.getItem('vc-accent') || 'mono';
  } catch {
    return 'mono';
  }
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('vc-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [accent, setAccent] = useState(readAccent);
  const logo = useStore((s) => s.settings.logo);
  // Saved on the server: the desktop app's window, tray and Dock icons follow it too.
  const chooseLogo = async (id: LogoId) => {
    if (id === logo) return;
    useStore.setState((s) => ({ settings: { ...s.settings, logo: id } }));
    try {
      const r = await api.updateSettings({ logo: id });
      useStore.setState({ settings: r.settings });
    } catch (e) {
      useStore.setState((s) => ({ settings: { ...s.settings, logo } }));
      toast('换图标失败', (e as Error).message, 'error');
    }
  };
  const applyAccent = (id: string) => {
    setAccent(id);
    try {
      if (id === 'mono') localStorage.removeItem('vc-accent');
      else localStorage.setItem('vc-accent', id);
    } catch {
      /* storage blocked: still apply for this session */
    }
    if (id === 'mono') delete document.documentElement.dataset.accent;
    else document.documentElement.dataset.accent = id;
  };
  const apply = (v: Theme) => {
    setTheme(v);
    try {
      if (v === 'system') localStorage.removeItem('vc-theme');
      else localStorage.setItem('vc-theme', v);
    } catch {
      /* storage blocked: still apply for this session */
    }
    if (v === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
  };
  const options: { id: Theme; label: string; icon: ReactNode }[] = [
    { id: 'system', label: '跟随系统', icon: <Monitor size={13} /> },
    { id: 'light', label: '浅色', icon: <Sun size={13} /> },
    { id: 'dark', label: '深色', icon: <Moon size={13} /> },
  ];
  return (
    <Section icon={<Palette size={18} />} title="外观">
      <div className="setting-row">
        <div>
          <div className="sr-title">主题</div>
          <div className="hint">只影响这台设备上的浏览器</div>
        </div>
        <div className="segmented">
          {options.map((o) => (
            <button key={o.id} className={cx(theme === o.id && 'on')} onClick={() => apply(o.id)}>
              {o.icon} {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">主题色</div>
          <div className="hint">按钮、选中状态和你发出的消息用这个颜色；选彩色时，机器人头像也会显示各自的颜色和表情</div>
        </div>
        <div className="accent-swatches" role="radiogroup" aria-label="主题色">
          {ACCENTS.map((a) => (
            <button key={a.id} role="radio" aria-checked={accent === a.id} className={cx('accent-swatch', accent === a.id && 'on')} onClick={() => applyAccent(a.id)}>
              <i style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">应用图标</div>
          <div className="hint">桌面版的 Dock、托盘、窗口图标和浏览器标签页图标都会跟着换，所有设备共用这个设置</div>
        </div>
        <div className="logo-choices" role="radiogroup" aria-label="应用图标">
          {LOGOS.map((l) => (
            <button key={l.id} role="radio" aria-checked={logo === l.id} className={cx('logo-choice', logo === l.id && 'on')} onClick={() => void chooseLogo(l.id)}>
              <Logo id={l.id} size={32} />
              <span>{l.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}
