import type { ClientEvent, ServerEvent } from '../../shared/types';
import { applyEvent, boot, useStore } from './store';

type TermListener = { data: (d: string) => void; exit: (code: number | null) => void };

let ws: WebSocket | null = null;
let retry = 0;
let everConnected = false;
let pingTimer: number | undefined;
const termListeners = new Map<string, TermListener>();
const outbox: ClientEvent[] = [];

export function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    useStore.setState({ connected: true });
    // Re-sync everything that may have changed while offline.
    if (everConnected) void boot();
    everConnected = true;
    for (const ev of outbox.splice(0)) sock.send(JSON.stringify(ev));
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => send({ t: 'ping' }), 25_000);
  };
  sock.onmessage = (e) => {
    let ev: ServerEvent | { t: 'pong' };
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.t === 'pong') return;
    if (ev.t === 'term_data') termListeners.get(ev.id)?.data(ev.data);
    else if (ev.t === 'term_exit') termListeners.get(ev.id)?.exit(ev.code);
    else applyEvent(ev);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    window.clearInterval(pingTimer);
    useStore.setState({ connected: false });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    window.setTimeout(connectSocket, delay);
  };
  sock.onerror = () => sock.close();
}

export function send(ev: ClientEvent) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  else if (ev.t !== 'ping') outbox.push(ev);
}

export function onTerminal(id: string, l: TermListener) {
  termListeners.set(id, l);
  return () => {
    if (termListeners.get(id) === l) termListeners.delete(id);
  };
}
