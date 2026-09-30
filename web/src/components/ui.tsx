import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { X } from 'lucide-react';
import type { Bot, BotStatus } from '../../../shared/types';
import { dismissToast, openChat, useStore } from '../store';
import { cx } from '../utils';

// ---------------------------------------------------------------- avatars

export function Avatar({ bot, size = 36, status }: { bot?: Pick<Bot, 'emoji' | 'color' | 'name'> | null; size?: number; status?: BotStatus }) {
  const tone =
    !status || status.state === 'idle' ? null : status.state === 'waiting' ? 'orange' : status.state === 'error' ? 'red' : status.state === 'queued' ? 'blue' : 'green';
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.52, background: `linear-gradient(145deg, ${bot?.color || '#8e8e93'}, ${shade(bot?.color || '#8e8e93')})` }}
      title={bot?.name}
    >
      {bot?.emoji || '🤖'}
      {tone && <span className={cx('status', 'dot', tone, status?.state !== 'error' && 'pulse')} />}
    </span>
  );
}

function shade(hex: string) {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (v: number) => Math.max(0, Math.round(v * 0.72));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

export function GroupAvatar({ bots, size = 40 }: { bots: Bot[]; size?: number }) {
  const list = bots.slice(0, 3);
  if (list.length <= 1) return <Avatar bot={list[0]} size={size} />;
  const small = Math.round(size * 0.62);
  const pos =
    list.length === 2
      ? [
          { left: 0, top: 0 },
          { left: size - small, top: size - small },
        ]
      : [
          { left: (size - small) / 2, top: 0 },
          { left: 0, top: size - small },
          { left: size - small, top: size - small },
        ];
  return (
    <span className="avatar-stack" style={{ width: size, height: size }}>
      {list.map((b, i) => (
        <span key={b.id} style={{ position: 'absolute', ...pos[i] }}>
          <Avatar bot={b} size={small} />
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Promise-based confirmation dialog. */
export function confirmDialog(opts: { title: string; body?: ReactNode; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(
      <Modal
        title={opts.title}
        onClose={() => done(false)}
        footer={
          <>
            <button className="btn" onClick={() => done(false)}>
              取消
            </button>
            <button className={cx('btn', opts.danger ? 'danger solid' : 'primary')} autoFocus onClick={() => done(true)}>
              {opts.ok || '确定'}
            </button>
          </>
        }
      >
        {opts.body && <div style={{ color: 'var(--text-2)', lineHeight: 1.6 }}>{opts.body}</div>}
      </Modal>,
    );
  });
}

/** Promise-based single-line prompt. */
export function promptDialog(opts: { title: string; label?: string; value?: string; placeholder?: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    function Body() {
      const [v, setV] = useState(opts.value || '');
      return (
        <Modal
          title={opts.title}
          onClose={() => done(null)}
          footer={
            <>
              <button className="btn" onClick={() => done(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => done(v)}>
                {opts.ok || '确定'}
              </button>
            </>
          }
        >
          <div className="field">
            {opts.label && <label>{opts.label}</label>}
            <input className="input" autoFocus value={v} placeholder={opts.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && done(v)} />
          </div>
        </Modal>
      );
    }
    root.render(<Body />);
  });
}

// ---------------------------------------------------------------- menus

export interface MenuItem {
  label?: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  heading?: string;
  disabled?: boolean;
}

export function Menu({ anchor, items, onClose, align = 'left' }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'right' ? anchor.right - w : anchor.left;
    let top = anchor.bottom + 4;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 4);
    setPos({ left, top });
  }, [anchor, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div className="menu" ref={ref} style={pos}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.heading ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            className={cx('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            {it.icon}
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.hint && <span className="muted" style={{ fontSize: 12 }}>{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** A button that opens a menu. */
export function MenuButton({ items, children, className, title, align }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; className?: string; title?: string; align?: 'left' | 'right' }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button className={className || 'icon-btn'} title={title} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        {children}
      </button>
      {anchor && <Menu anchor={anchor} align={align} items={typeof items === 'function' ? items() : items} onClose={() => setAnchor(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- misc

export function Toggle({ on, onChange, disabled, title }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return <button type="button" className={cx('toggle', on && 'on')} disabled={disabled} title={title} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx('toast', t.level, t.chatId && 'clickable')}
          onClick={() => {
            if (t.chatId) openChat(t.chatId);
            dismissToast(t.id);
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
          <button
            className="icon-btn sm"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(t.id);
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
