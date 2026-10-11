import { AlertTriangle, ArrowLeft, ArrowRight, Camera, Circle, ExternalLink, Laptop, Maximize, MousePointerClick, RotateCw, Send, Smartphone, Tablet, TerminalSquare, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, ConsoleEntry, PreviewToHost, Project } from '../../../../shared/types';
import { api } from '../../api';
import { addAttachment, attachmentId, type Device, openModal, previewOf, setComputer, toast, updatePreview, useStore } from '../../store';
import { cx, fmtClock } from '../../utils';
import { Glyph } from '../ui';

const DEVICES: { id: Device; label: string; icon: typeof Laptop; w?: number; h?: number }[] = [
  { id: 'fill', label: 'Fit', icon: Maximize },
  { id: 'desktop', label: 'Desktop 1280', icon: Laptop, w: 1280, h: 800 },
  { id: 'tablet', label: 'Tablet 820', icon: Tablet, w: 820, h: 1180 },
  { id: 'mobile', label: 'Phone 390', icon: Smartphone, w: 390, h: 844 },
];

function previewHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ? '127.0.0.1' : h;
}

function ConsoleDrawer({ projectId, chatId, entries, onClose }: { projectId: string; chatId: string; entries: ConsoleEntry[]; onClose: () => void }) {
  const [filter, setFilter] = useState<'all' | 'problems'>('problems');
  const shown = filter === 'all' ? entries : entries.filter((e) => e.level === 'error' || e.level === 'warn');
  const list = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll down when lines are added
  useLayoutEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [shown.length]);
  const send = () => {
    const problems = entries.filter((e) => e.level === 'error' || e.level === 'warn');
    const pick = (problems.length ? problems : entries).slice(-40);
    if (!pick.length) return;
    addAttachment(chatId, { kind: 'console', id: attachmentId(), page: previewOf(projectId).path, entries: pick });
    toast('Attached to input', `${pick.length} console log${pick.length === 1 ? '' : 's'}. Add a note and send it to the bot.`, 'success');
  };
  return (
    <div className="console-drawer">
      <div className="console-head">
        <span className="segmented">
          <button className={cx(filter === 'problems' && 'on')} onClick={() => setFilter('problems')}>
            Problems
          </button>
          <button className={cx(filter === 'all' && 'on')} onClick={() => setFilter('all')}>
            All {entries.length}
          </button>
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={send} disabled={!entries.length}>
          <Send size={12} /> Send to bot to fix
        </button>
        <button className="icon-btn sm" title="Clear" onClick={() => updatePreview(projectId, { console: [] })}>
          <Trash2 size={13} />
        </button>
        <button className="icon-btn sm" title="Collapse" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="console-list" ref={list}>
        {!shown.length && (
          <div className="muted" style={{ padding: 10 }}>
            {filter === 'problems' ? 'No errors or warnings' : 'No logs yet'}
          </div>
        )}
        {shown.map((e, i) => (
          <div key={i} className={cx('console-row', e.level)}>
            <span className="c-time">{fmtClock(e.ts)}</span>
            <span className="c-text">{e.text}</span>
            {e.source && <span className="c-src">{e.source}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BrowserTab({ chat, project, active }: { chat: Chat; project: Project; active: boolean }) {
  const info = useStore((s) => s.previews[project.id]);
  const ds = useStore((s) => s.devServers[project.id]);
  const pv = useStore((s) => s.preview[project.id]) || previewOf(project.id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const hostOrigin = useRef<string | null>(null);
  const [address, setAddress] = useState(pv.path);
  const [src, setSrc] = useState<{ path: string; n: number }>({ path: pv.path || '/', n: 0 });
  const [scale, setScale] = useState(1);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [shooting, setShooting] = useState(false);
  const pageTimer = useRef<number | undefined>(undefined);

  const needsDev = !!project.devDetected;
  const devReady = !needsDev || (ds?.status === 'running' && !!ds.url);
  const base = info ? `${location.protocol}//${previewHost()}:${info.port}` : null;

  // Make sure a preview server exists for this project.
  useEffect(() => {
    api
      .preview(project.id)
      .then((p) => useStore.setState((s) => ({ previews: { ...s.previews, [p.projectId]: p } })))
      .catch((e) => toast('Preview failed to start', e.message, 'error'));
  }, [project.id]);

  // Reload when the preview switches between static files and the dev server.
  const mode = info?.mode;
  const target = info?.target;
  const firstMode = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the mode or target changes
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setSrc((s) => ({ path: previewOf(project.id).path || s.path, n: s.n + 1 }));
  }, [mode, target, project.id]);

  useEffect(() => {
    if (pv.reloadKey) setSrc((s) => ({ path: previewOf(project.id).path || s.path, n: s.n + 1 }));
  }, [pv.reloadKey, project.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each request carries a new nonce
  useEffect(() => {
    if (pv.navigate) {
      setSrc((s) => ({ path: pv.navigate!.path, n: s.n + 1 }));
      setAddress(pv.navigate.path);
    }
  }, [pv.navigate?.nonce]);

  const post = (msg: object) => {
    const w = iframe.current?.contentWindow;
    if (w && hostOrigin.current) w.postMessage({ __crew_host: true, ...msg }, hostOrigin.current);
  };

  // Messages from the script injected into the previewed page.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!iframe.current || e.source !== iframe.current.contentWindow) return;
      const d = e.data as PreviewToHost & { __crew?: boolean };
      if (d?.__crew !== true) return;
      if (d.type === 'ready' || d.type === 'nav') {
        hostOrigin.current = e.origin;
        if (d.type === 'ready') {
          (e.source as Window).postMessage({ __crew_host: true, type: 'hello' }, e.origin);
          const cur = previewOf(project.id);
          if (cur.picking) (e.source as Window).postMessage({ __crew_host: true, type: 'pick', on: true }, e.origin);
          if (cur.recording) (e.source as Window).postMessage({ __crew_host: true, type: 'record', on: true }, e.origin);
        }
        let path = '/';
        try {
          const u = new URL(d.url);
          path = u.pathname + u.search + u.hash;
        } catch {
          /* keep / */
        }
        setLoading(false);
        setAddress(path);
        updatePreview(project.id, (p) => ({ path, title: d.title || p.title, console: d.type === 'ready' ? p.console.slice(-50) : p.console }));
        clearTimeout(pageTimer.current);
        pageTimer.current = window.setTimeout(() => void api.previewPage(project.id, path).catch(() => {}), 400);
        return;
      }
      if (d.type === 'console') {
        updatePreview(project.id, (p) => ({ console: [...p.console, d.entry].slice(-300) }));
        return;
      }
      if (d.type === 'picked') {
        addAttachment(chat.id, { kind: 'element', id: attachmentId(), ...d.info });
        toast('Element selected', `${d.info.tag}${d.info.text ? ` "${d.info.text.slice(0, 30)}"` : ''} attached to input. Hold Shift to select more.`, 'success');
        return;
      }
      if (d.type === 'pick_end') {
        updatePreview(project.id, { picking: false });
        return;
      }
      if (d.type === 'recorded') {
        updatePreview(project.id, (p) => ({ steps: [...p.steps, d.step] }));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [project.id, chat.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tell the page only when the flag changes
  useEffect(() => post({ type: 'pick', on: pv.picking }), [pv.picking]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tell the page only when the flag changes
  useEffect(() => post({ type: 'record', on: pv.recording }), [pv.recording]);

  // Fit fixed-size devices into the available space.
  const dev = DEVICES.find((d) => d.id === pv.device) || DEVICES[0];
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the tab becomes visible
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !dev.w) {
      setScale(1);
      return;
    }
    const fitFrame = () => {
      const pad = 24;
      setScale(Math.min(1, (el.clientWidth - pad) / dev.w!, (el.clientHeight - pad) / dev.h!));
    };
    fitFrame();
    const ro = new ResizeObserver(fitFrame);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dev.w, dev.h, active]);

  const go = (path: string) => {
    let p = path.trim() || '/';
    if (/^https?:\/\//i.test(p)) {
      try {
        const u = new URL(p);
        // A dev server address typed by hand: remember it for the proxy.
        if (needsDev && ds?.status !== 'running' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
          void api.devUrl(project.id, u.origin + '/');
        }
        p = u.pathname + u.search + u.hash;
      } catch {
        /* treat as path */
      }
    }
    if (!p.startsWith('/')) p = '/' + p;
    setLoading(true);
    setSrc((s) => ({ path: p, n: s.n + 1 }));
    setAddress(p);
  };

  const reload = () => {
    setLoading(true);
    setSrc((s) => ({ path: previewOf(project.id).path || s.path, n: s.n + 1 }));
  };

  const screenshot = async () => {
    setShooting(true);
    try {
      const up = await api.screenshot(project.id, pv.path || '/', pv.device === 'fill' ? 'desktop' : pv.device);
      addAttachment(chat.id, { kind: 'image', id: attachmentId(), name: up.name, mime: up.mime, url: up.url });
      toast('Screenshot attached to input', undefined, 'success');
    } catch (e) {
      toast('Screenshot failed', (e as Error).message, 'error');
    } finally {
      setShooting(false);
    }
  };

  const toggleRecord = () => {
    if (pv.recording) {
      updatePreview(project.id, { recording: false });
      if (previewOf(project.id).steps.length) openModal({ kind: 'saveRecording', projectId: project.id });
    } else {
      updatePreview(project.id, { recording: true, steps: [], picking: false });
      toast('Recording started', 'Use the preview as usual, then click the record button again when done. You can save it as a skill or have a bot turn it into an automated test.', 'info');
    }
  };

  const problems = pv.console.filter((c) => c.level === 'error' || c.level === 'warn');
  const errorCount = pv.console.filter((c) => c.level === 'error').length;
  const frameUrl = base ? `${base}${src.path}` : null;

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn sm" title="Back" onClick={() => post({ type: 'history', dir: -1 })}>
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn sm" title="Forward" onClick={() => post({ type: 'history', dir: 1 })}>
          <ArrowRight size={15} />
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={reload}>
          <RotateCw size={14} className={cx(loading && devReady && 'spin-slow')} />
        </button>
        <form
          className="address"
          onSubmit={(e) => {
            e.preventDefault();
            go(address);
          }}
        >
          <span className="addr-host" title={info?.target}>
            {info?.mode === 'proxy' ? (ds?.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '') : 'static'}
          </span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} onFocus={(e) => e.target.select()} />
        </form>
        <div className="segmented devices">
          {DEVICES.map((d) => (
            <button key={d.id} className={cx(pv.device === d.id && 'on')} title={d.label} onClick={() => updatePreview(project.id, { device: d.id })}>
              <d.icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div className="browser-tools">
        <button
          className={cx('btn sm', pv.picking && 'primary')}
          onClick={() => updatePreview(project.id, { picking: !pv.picking, recording: false })}
          title="Click an element on the page to send it to the bot (Esc to cancel, Shift to select more)"
        >
          <MousePointerClick size={13} /> {pv.picking ? 'Click an element…' : 'Pick element'}
        </button>
        <button className={cx('btn sm', pv.recording && 'danger solid')} onClick={toggleRecord} title="Record your actions to save as a skill or generate a test (like Grokbot's Teach a task)">
          <Circle size={11} fill={pv.recording ? 'currentColor' : 'none'} /> {pv.recording ? `Stop recording (${pv.steps.length} step${pv.steps.length === 1 ? '' : 's'})` : 'Record demo'}
        </button>
        <button className="btn sm" onClick={screenshot} disabled={shooting} title="Take a screenshot and attach it to the input">
          {shooting ? <span className="spinner" /> : <Camera size={13} />} Screenshot
        </button>
        <span className="spacer" />
        <button className={cx('btn sm', consoleOpen && 'primary')} onClick={() => setConsoleOpen(!consoleOpen)} title="Console">
          <AlertTriangle size={13} /> Console
          {problems.length > 0 && <span className={cx('count', errorCount ? 'red' : 'orange')}>{problems.length}</span>}
        </button>
        {frameUrl && (
          <a className="icon-btn sm" href={`${base}${pv.path || '/'}`} target="_blank" rel="noreferrer" title="Open in new tab">
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      <div className={cx('stage', dev.w ? 'framed' : 'fill')} ref={stage}>
        {frameUrl && devReady && (
          <div className="frame-wrap" style={dev.w ? { width: dev.w, height: dev.h, transform: `scale(${scale})` } : undefined}>
            <iframe key={src.n} ref={iframe} src={frameUrl} title="Preview" onLoad={() => setLoading(false)} allow="clipboard-write; fullscreen" />
          </div>
        )}
        {needsDev && !devReady && (
          <div className="stage-overlay">
            {ds?.status === 'installing' || ds?.status === 'starting' ? (
              <>
                <div className="spinner" style={{ width: 26, height: 26 }} />
                <h3>{ds.status === 'installing' ? 'Installing dependencies…' : 'Starting dev server…'}</h3>
                <p className="muted">{ds.command || project.devDetected}</p>
              </>
            ) : (
              <>
                <div className="big">
                  <Glyph emoji="🚀" size={26} />
                </div>
                <h3>{ds?.status === 'error' ? 'Dev server error' : 'Dev server not running'}</h3>
                <p className="muted">{ds?.error || `Run ${project.devDetected} to preview this project`}</p>
                <div className="row">
                  <button className="btn primary" onClick={() => api.dev(project.id, 'start').catch((e) => toast('Failed to start', e.message, 'error'))}>
                    Start dev server
                  </button>
                </div>
              </>
            )}
            <button className="btn sm ghost" onClick={() => setComputer({ tab: 'terminal' })}>
              <TerminalSquare size={13} /> View logs
            </button>
          </div>
        )}
      </div>
      {pv.recording && (
        <div className="rec-bar">
          <span className="rec-dot" /> Recording · {pv.steps.length} step{pv.steps.length === 1 ? '' : 's'}
          <span className="spacer" />
          <button className="btn sm" onClick={toggleRecord}>
            Done
          </button>
          <button className="btn sm ghost" onClick={() => updatePreview(project.id, { recording: false, steps: [] })}>
            Discard
          </button>
        </div>
      )}
      {consoleOpen && <ConsoleDrawer projectId={project.id} chatId={chat.id} entries={pv.console} onClose={() => setConsoleOpen(false)} />}
    </div>
  );
}
