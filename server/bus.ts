import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../shared/types';
import { logger } from './log';

const log = logger('bus');

type Listener = (ev: ServerEvent) => void;
const listeners = new Set<Listener>();

/** Broadcast channel to every connected browser. */
export const bus = {
  emit(ev: ServerEvent) {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        log.error(e);
      }
    }
  },
  on(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export interface InternalEvents {
  /** Files changed on disk inside a project (relative paths). */
  files: (projectId: string, paths: string[]) => void;
  /** A commit landed in a project's git repository. */
  commit: (projectId: string) => void;
}

/** Server-internal events (watchers -> routines, recorders, previews). */
class Internal extends EventEmitter {
  on<K extends keyof InternalEvents>(event: K, listener: InternalEvents[K]): this {
    return super.on(event, listener);
  }
  off<K extends keyof InternalEvents>(event: K, listener: InternalEvents[K]): this {
    return super.off(event, listener);
  }
  emit<K extends keyof InternalEvents>(event: K, ...args: Parameters<InternalEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

export const internal = new Internal();
internal.setMaxListeners(100);

export function notify(title: string, body: string, opts: { chatId?: string; level?: 'info' | 'success' | 'warn' | 'error' } = {}) {
  bus.emit({ t: 'notify', title, body, ...opts });
}
