// The agent fence (ADR 104): Crew's own API and WebSocket are not open to the processes Crew
// starts. Loopback requests are otherwise trusted as the user's (security.ts), and every agent
// command runs on this machine: without the fence, a command could change settings, approve its own
// draft, answer its own approval card, or type into the user's terminal. A request is refused when
// the process on the other end of its TCP connection descends from the Crew server: Claude Code
// sessions (and, through the sandbox, their proxy), their commands and MCP servers, background
// jobs, dev servers, Crew's headless Chrome. The user's terminals are registered as trusted.
// Linux only (it reads /proc); elsewhere the guard's crew-api rule and the sandbox remain.

import fs from 'node:fs';
import type net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { audit } from '../audit';
import { logger } from '../log';

const log = logger('fence');

const trusted = new Set<number>();

/** A process the user drives (a terminal Crew opened for them): it and its children may use the API. */
export function trustProcess(pid: number | undefined) {
  if (pid) trusted.add(pid);
}

export function untrustProcess(pid: number | undefined) {
  if (pid) trusted.delete(pid);
}

/** The inode of the client end of a local TCP connection, from /proc/net/tcp and tcp6; null when the client is not on this machine. */
export function clientInode(clientPort: number, serverPort: number, procNet = '/proc/net'): string | null {
  for (const f of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = fs.readFileSync(`${procNet}/${f}`, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = Number.parseInt(cols[1].split(':').at(-1) || '', 16);
      const remote = Number.parseInt(cols[2].split(':').at(-1) || '', 16);
      if (local === clientPort && remote === serverPort && cols[9] !== '0') return cols[9];
    }
  }
  return null;
}

/** Every process's parent, from /proc/<pid>/stat. */
function parents(): Map<number, number> {
  const out = new Map<number, number>();
  let names: string[] = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // "pid (comm) state ppid …": comm may hold spaces and parentheses.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid) out.set(Number(name), ppid);
    } catch {
      /* gone */
    }
  }
  return out;
}

/** The processes below `root`, without the subtrees of trusted processes. */
export function descendants(root: number, table = parents()): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) children.set(ppid, [...(children.get(ppid) || []), pid]);
  const out: number[] = [];
  const queue = [...(children.get(root) || [])];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (trusted.has(pid)) continue;
    out.push(pid);
    queue.push(...(children.get(pid) || []));
  }
  return out;
}

/** Which of these processes holds the socket, or null. */
function owner(inode: string, pids: number[]): number | null {
  const want = `socket:[${inode}]`;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === want) return pid;
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return null;
}

const verdicts = new WeakMap<net.Socket, number | null>();

/** The pid of the process Crew started that is on the other end of this connection, or null. */
export function agentPeer(socket: net.Socket, root = process.pid): number | null {
  if (process.platform !== 'linux') return null;
  const cached = verdicts.get(socket);
  if (cached !== undefined) return cached;
  let pid: number | null = null;
  if (socket.remotePort && socket.localPort) {
    const inode = clientInode(socket.remotePort, socket.localPort);
    if (inode) pid = owner(inode, descendants(root));
  }
  verdicts.set(socket, pid);
  return pid;
}

function command(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '?';
  }
}

export const FENCE_MESSAGE = "Crew's API does not take requests from processes Crew started (agents, their commands, jobs, dev servers). If something in Crew needs changing, ask the user.";

/** Records a refused request; the reason is what the caller sends back. */
export function refuse(pid: number, what: string): string {
  const who = `pid ${pid} (${command(pid)})`;
  log.warn(`refused ${what} from ${who}`);
  audit({ event: 'blocked', rule: 'crew-api', actor: {}, command: what, detail: `From ${who}: Crew's API is not open to agent processes.` });
  return FENCE_MESSAGE;
}

/** Express middleware for /api. */
export function fence(req: Request, res: Response, next: NextFunction) {
  const pid = agentPeer(req.socket);
  if (pid === null) return next();
  res.status(403).json({ error: refuse(pid, `${req.method} /api${req.path}`) });
}
