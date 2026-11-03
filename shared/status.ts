// What the server and the UI both read off a status: whether the thing is still working.

import type { BackgroundJob, Speculation, WorkerStatus } from './types';

/** A Worker in one of these is working (or about to): it counts against the chat's limit and receives its Threads' events (ADR 002). */
export const WORKER_ACTIVE: ReadonlySet<string> = new Set<WorkerStatus>(['starting', 'running', 'waiting']);

/** A background job still running, or waiting for an approval (ADR 004). */
export const isJobRunning = (j: Pick<BackgroundJob, 'status'>) => j.status === 'running' || j.status === 'waiting';

/** A speculative run still working or being verified (ADR 008). */
export const SPECULATION_IN_FLIGHT: ReadonlySet<string> = new Set<Speculation['status']>(['running', 'verifying']);
