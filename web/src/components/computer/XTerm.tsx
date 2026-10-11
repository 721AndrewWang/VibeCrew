import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { onTerminal, send } from '../../socket';
import { useDarkMode } from './theme';

// Neutral greys, matching the app's black / white / grey palette (styles/base.css).
const DARK: ITheme = {
  background: '#0c0c0c',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  selectionBackground: 'rgba(255,255,255,0.2)',
  black: '#1a1a1a',
  brightBlack: '#6b6b6b',
  blue: '#6ea8ff',
  brightBlue: '#94c0ff',
  cyan: '#4fd1e8',
  brightCyan: '#7fe0f0',
};

const LIGHT: ITheme = {
  background: '#f6f6f6',
  foreground: '#111111',
  cursor: '#111111',
  selectionBackground: 'rgba(0,0,0,0.15)',
  black: '#111111',
  white: '#8c8c8c',
  brightWhite: '#6b6b6b',
  blue: '#2f6ff0',
  brightBlue: '#1f55c9',
  yellow: '#b26b00',
  brightYellow: '#9a5b00',
  green: '#1f8a3a',
  brightGreen: '#1a7a33',
  cyan: '#0a7ea4',
  brightCyan: '#086a8a',
};

function makeTerm(dark: boolean, readOnly: boolean) {
  return new Terminal({
    fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: !readOnly,
    disableStdin: readOnly,
    convertEol: false,
    scrollback: 5000,
    allowProposedApi: true,
    theme: dark ? DARK : LIGHT,
  });
}

function useFit(
  host: React.RefObject<HTMLDivElement | null>,
  term: React.RefObject<Terminal | null>,
  fit: React.RefObject<FitAddon | null>,
  active: boolean,
  onResize?: (cols: number, rows: number) => void,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit again when the tab becomes visible
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const doFit = () => {
      if (!active || !el.offsetWidth || !el.offsetHeight || !term.current || !fit.current) return;
      try {
        fit.current.fit();
        onResize?.(term.current.cols, term.current.rows);
      } catch {
        /* not attached yet */
      }
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    const t = setTimeout(doFit, 30);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [active]);
}

/** An interactive shell on the server, attached over the websocket. */
export function LiveTerminal({ id, projectId, command, active }: { id: string; projectId: string; command?: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const dark = useDarkMode();

  // biome-ignore lint/correctness/useExhaustiveDependencies: one terminal per session id; the theme is applied separately
  useEffect(() => {
    const t = makeTerm(dark, false);
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try {
      f.fit();
    } catch {
      /* hidden */
    }
    const off = onTerminal(id, {
      data: (d) => t.write(d),
      exit: (code) => t.write(`\r\n\x1b[90m[Process exited${code !== null ? ` with code ${code}` : ''}]\x1b[0m\r\n`),
    });
    send({ t: 'term_open', id, projectId, cols: t.cols || 80, rows: t.rows || 24, command });
    const sub = t.onData((d) => send({ t: 'term_input', id, data: d }));
    return () => {
      off();
      sub.dispose();
      t.dispose();
      term.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (term.current) term.current.options.theme = dark ? DARK : LIGHT;
  }, [dark]);

  useFit(host, term, fit, active, (cols, rows) => send({ t: 'term_resize', id, cols, rows }));

  useEffect(() => {
    if (active) setTimeout(() => term.current?.focus(), 50);
  }, [active]);

  return <div className="xterm-host" ref={host} />;
}

/** A read-only terminal that renders a growing log. */
export function LogTerminal({ content, active }: { content: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const written = useRef(0);
  const dark = useDarkMode();

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; the theme is applied separately
  useEffect(() => {
    const t = makeTerm(dark, true);
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    written.current = 0;
    return () => {
      t.dispose();
      term.current = null;
    };
  }, []);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    if (content.length < written.current) {
      t.reset();
      written.current = 0;
    }
    if (content.length > written.current) {
      t.write(content.slice(written.current));
      written.current = content.length;
    }
  }, [content]);

  useEffect(() => {
    if (term.current) term.current.options.theme = dark ? DARK : LIGHT;
  }, [dark]);

  useFit(host, term, fit, active);

  return <div className="xterm-host" ref={host} />;
}
