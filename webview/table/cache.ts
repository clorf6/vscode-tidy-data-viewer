// Row data cache for the webview: blocks of rows fetched from the host on demand, kept while near the viewport.
import { post } from '../shared/vscode';
import type { RowData } from '../../src/table/protocol';

interface Block {
  rows: RowData[];
  stale: boolean;
  used: number;
}

const PENDING_MS = 2000;

export class RowCache {
  bs = 128;
  vv = 0;
  private blocks = new Map<number, Block>();
  private pending = new Map<number, number>();
  private tick = 0;
  maxBlocks = 200;
  onData?: () => void;

  configure(cols: number): void {
    const bs = cols > 200 ? 32 : cols > 60 ? 64 : cols > 1 ? 128 : 256;
    this.maxBlocks = Math.max(24, Math.floor(1_500_000 / Math.max(1, bs * cols)));
    if (bs !== this.bs) {
      this.bs = bs;
      this.blocks.clear();
      this.pending.clear();
    }
  }

  get(r: number): RowData | undefined {
    const b = this.blocks.get(Math.floor(r / this.bs));
    if (!b) return undefined;
    b.used = this.tick;
    return b.rows[r % this.bs];
  }

  /** Make sure rows [r0, r1) are (being) loaded; prefetch one block on each side. */
  need(r0: number, r1: number, count: number): void {
    this.tick++;
    if (r1 <= r0 || count === 0) return;
    const now = performance.now();
    const b0 = Math.floor(r0 / this.bs);
    const b1 = Math.floor((Math.min(r1, count) - 1) / this.bs);
    const last = Math.floor((count - 1) / this.bs);
    const want: number[] = [];
    const add = (b: number) => {
      if (b < 0 || b > last) return;
      const have = this.blocks.get(b);
      // a block fetched while the file was still indexing (or before a log grew) can be short: fetch it again
      if (have && !have.stale && have.rows.length >= Math.min(this.bs, count - b * this.bs)) return;
      const p = this.pending.get(b);
      // a reply can get lost (webview reloaded, host restarted the view): ask again after a while
      if (p !== undefined && now - p < PENDING_MS) return;
      this.pending.set(b, now);
      want.push(b);
    };
    for (let b = b0; b <= b1; b++) add(b);
    add(b1 + 1);
    add(b0 - 1);
    if (want.length) post({ type: 'rows', vv: this.vv, blocks: want, bs: this.bs });
  }

  receive(vv: number, b: number, bs: number, rows: RowData[]): boolean {
    if (vv !== this.vv || bs !== this.bs) return false;
    this.pending.delete(b);
    this.blocks.set(b, { rows, stale: false, used: this.tick });
    if (this.blocks.size > this.maxBlocks) this.evict();
    return true;
  }

  /** The host skipped these requests (queue overflow, stale view, error): allow asking again shortly. */
  dropped(vv: number, blocks: number[]): void {
    if (vv !== this.vv) return;
    const retry = performance.now() - PENDING_MS + 250;
    for (const b of blocks) if (this.pending.has(b)) this.pending.set(b, retry);
  }

  private evict(): void {
    const arr = [...this.blocks].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < arr.length - this.maxBlocks; i++) this.blocks.delete(arr[i][0]);
  }

  /** New view version: keep showing old rows until fresh ones arrive (no flicker after edits). */
  revalidate(vv: number): void {
    this.vv = vv;
    for (const b of this.blocks.values()) b.stale = true;
    this.pending.clear();
  }

  clear(vv: number): void {
    this.vv = vv;
    this.blocks.clear();
    this.pending.clear();
  }

  /** Update a cached cell optimistically after an edit. */
  patch(r: number, li: number, value: string): void {
    const row = this.get(r);
    if (row) {
      row.c = row.c.slice();
      row.c[li] = value;
      row.f = (row.f ?? 0) | 2;
      const b = this.blocks.get(Math.floor(r / this.bs))!;
      b.rows[r % this.bs] = { ...row };
    }
  }

  loadedRows(): RowData[] {
    const out: RowData[] = [];
    for (const b of this.blocks.values()) out.push(...b.rows);
    return out;
  }
}

/** Variable row heights (wrap mode): base height + measured deltas, with a block Fenwick tree for prefix sums. */
export class Heights {
  private static readonly B = 256;
  private fen: Float64Array;
  private deltas = new Map<number, Map<number, number>>();
  constructor(
    public n: number,
    public base: number,
  ) {
    this.fen = new Float64Array(Math.ceil(n / Heights.B) + 2);
  }
  resize(n: number): void {
    if (n === this.n) return;
    if (Math.ceil(n / Heights.B) + 2 > this.fen.length) {
      const old = this.deltas;
      this.fen = new Float64Array(Math.ceil(n / Heights.B) * 2 + 2);
      this.deltas = new Map();
      this.n = n;
      for (const m of old.values()) for (const [r, d] of m) if (r < n) this.set(r, this.base + d);
      return;
    }
    // rows beyond n are ignored by prefix(); just drop their deltas
    if (n < this.n) for (const [b, m] of this.deltas) for (const [r, d] of m) if (r >= n) (m.delete(r), this.fenAdd(b, -d));
    this.n = n;
  }
  private fenAdd(b: number, d: number): void {
    for (let i = b + 1; i < this.fen.length; i += i & -i) this.fen[i] += d;
  }
  private fenSum(b: number): number {
    // sum of blocks [0, b)
    let s = 0;
    for (let i = b; i > 0; i -= i & -i) s += this.fen[i];
    return s;
  }
  get(r: number): number {
    const m = this.deltas.get(Math.floor(r / Heights.B));
    return this.base + (m?.get(r) ?? 0);
  }
  set(r: number, h: number): boolean {
    const b = Math.floor(r / Heights.B);
    let m = this.deltas.get(b);
    const old = m?.get(r) ?? 0;
    const d = h - this.base;
    if (Math.abs(d - old) < 0.5) return false;
    if (!m) this.deltas.set(b, (m = new Map()));
    if (d === 0) m.delete(r);
    else m.set(r, d);
    this.fenAdd(b, d - old);
    return true;
  }
  /** Top of row r. */
  top(r: number): number {
    const b = Math.floor(r / Heights.B);
    let y = r * this.base + this.fenSum(b);
    const m = this.deltas.get(b);
    if (m) for (const [k, d] of m) if (k < r) y += d;
    return y;
  }
  total(): number {
    return this.top(this.n);
  }
  /** Row containing y. */
  find(y: number): number {
    if (y <= 0) return 0;
    // binary search on block starts, then walk
    let lo = 0;
    let hi = Math.ceil(this.n / Heights.B);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.top(mid * Heights.B) <= y) lo = mid;
      else hi = mid - 1;
    }
    let r = lo * Heights.B;
    let t = this.top(r);
    while (r < this.n - 1) {
      const h = this.get(r);
      if (t + h > y) break;
      t += h;
      r++;
    }
    return Math.min(r, Math.max(0, this.n - 1));
  }
}
