// Cooperative scheduling: long host-side jobs (indexing, sorting, filtering, stats) run in slices so the extension
// host never blocks for more than a few tens of milliseconds.

export const SLICE_MS = 16;

export function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Thrown when a job is superseded (newer query, document closed). */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export class Token {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
  check(): void {
    if (this.cancelled) throw new Cancelled();
  }
}

/** Call `await s.step()` often (it only checks the clock every `every` calls). */
export class Slicer {
  private t = performance.now();
  private n = 0;
  yields = 0;
  maxBlock = 0;
  constructor(
    private token?: Token,
    private ms = SLICE_MS,
    private every = 256,
  ) {}
  /** True when the caller should `await yieldNow()`. Cheap to call per item. */
  due(): boolean {
    if (++this.n < this.every) return false;
    this.n = 0;
    return performance.now() - this.t > this.ms;
  }
  async yieldNow(): Promise<void> {
    const d = performance.now() - this.t;
    if (d > this.maxBlock) this.maxBlock = d;
    await tick();
    this.yields++;
    this.token?.check();
    this.t = performance.now();
  }
  async step(): Promise<void> {
    if (this.due()) await this.yieldNow();
  }
  /** Check the clock now (for coarse steps) and yield if the slice is used up. */
  async maybe(): Promise<void> {
    this.n = 0;
    if (performance.now() - this.t > this.ms) await this.yieldNow();
  }
}

export function isCancel(e: unknown): boolean {
  return e instanceof Cancelled;
}
