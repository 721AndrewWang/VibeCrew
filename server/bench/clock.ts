// A virtual clock for the bench (ADR 101): timers run in time order (then in the order they were
// set), and between two timers every pending promise settles, so async code written in Crew's
// style runs unchanged and a run takes milliseconds of real time, the same way every time.

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

/** A fixed start, so rendered times ("12s ago") and every derived number are reproducible. */
export const BENCH_EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

export class VirtualClock {
  now: number;
  private heap: Timer[] = [];
  private seq = 0;
  private inflight = 0;
  private idle: (() => void)[] = [];

  constructor(start = BENCH_EPOCH) {
    this.now = start;
  }

  /** Runs fn at virtual time `at` (never before now). */
  at(at: number, fn: () => void) {
    this.push({ at: Math.max(at, this.now), seq: this.seq++, fn });
  }

  after(ms: number, fn: () => void) {
    this.at(this.now + Math.max(0, ms), fn);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  /**
   * Work outside the clock (a model call over HTTP): time does not move until it settles, so the
   * real time it takes never shows in the results.
   */
  async track<T>(p: Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await p;
    } finally {
      this.inflight--;
      if (!this.inflight) for (const f of this.idle.splice(0)) f();
    }
  }

  /** Timers still waiting. */
  get pending() {
    return this.heap.length;
  }

  /** Runs until no timer is left (or the next one is past `until`). */
  async run(until = Number.POSITIVE_INFINITY): Promise<void> {
    for (;;) {
      await this.settle();
      const t = this.heap[0];
      if (!t || t.at > until) return;
      this.pop();
      this.now = t.at;
      t.fn();
    }
  }

  private async settle() {
    for (;;) {
      // Every microtask queued so far (and every one those queue) runs before this callback.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!this.inflight) return;
      await new Promise<void>((resolve) => this.idle.push(resolve));
    }
  }

  private less(a: Timer, b: Timer) {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private push(t: Timer) {
    const h = this.heap;
    h.push(t);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private pop(): Timer | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}
