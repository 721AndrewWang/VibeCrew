// The Router's inbox: one turn at a time, and everything that arrives meanwhile goes into the next
// turn together. Batching is cheap for the Router (long input, short output), so the cost per
// decision falls as events pile up. The same pattern as the slow path's SlowQueue.

import { logger } from '../log';

const log = logger('router');

export class BatchQueue<T> {
  private pending: T[] = [];
  private running = false;

  constructor(
    private run: (batch: T[]) => Promise<void>,
    /** Called whenever the queue's length or running state changes. */
    private onChange: () => void = () => {},
  ) {}

  /** Events waiting for the next turn. */
  get waiting() {
    return this.pending.length;
  }

  get busy() {
    return this.running;
  }

  push(item: T) {
    this.pending.push(item);
    this.onChange();
    void this.drain();
  }

  /** Drops what is waiting (the user stopped the chat); returns it. */
  clear(): T[] {
    const dropped = this.pending.splice(0);
    this.onChange();
    return dropped;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const batch = this.pending.splice(0);
        this.onChange();
        try {
          await this.run(batch);
        } catch (e) {
          log.error('a turn failed', e);
        }
      }
    } finally {
      this.running = false;
      this.onChange();
    }
  }
}
