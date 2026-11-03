// What the server and the UI both read off a Worker's status (ADR 002).

import type { WorkerStatus } from './types';

/** A Worker in one of these is working (or about to): it counts against the chat's limit and receives its Threads' events. */
export const WORKER_ACTIVE: ReadonlySet<string> = new Set<WorkerStatus>(['starting', 'running', 'waiting']);
