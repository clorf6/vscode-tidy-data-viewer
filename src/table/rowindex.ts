// Row offset index built by scanning bytes. CSV mode respects quoted newlines; line mode splits on \n only.

export interface ScanOptions {
  /** Treat `"` at a field start as an opening quote (CSV). */
  quotes: boolean;
  /** Delimiter byte (for "quote at field start"). */
  delim: number;
  /** Drop empty lines (JSONL). */
  skipBlank: boolean;
}

/**
 * Scan complete rows in buf[lo, hi). `lo` must be a row boundary. Emits (start, end) as absolute offsets
 * (base + index), `end` excluding the line ending. Returns the absolute offset of the first row that is not complete
 * yet (the caller continues from there once more data is available). With `final`, the trailing partial row is
 * emitted too.
 */
export function scanRows(buf: Uint8Array, lo: number, hi: number, base: number, final: boolean, o: ScanOptions, emit: (s: number, e: number) => void): number {
  const view = hi === buf.length ? buf : buf.subarray(0, hi);
  let rowStart = lo;
  let pos = lo;
  let nl = -2;
  let nq = o.quotes ? -2 : -1;
  while (pos < hi) {
    if (nl !== -1 && nl < pos) nl = view.indexOf(10, pos);
    if (nq !== -1 && nq < pos) nq = view.indexOf(34, pos);
    if (nq !== -1 && (nl === -1 || nq < nl)) {
      const p = nq > rowStart ? buf[nq - 1] : o.delim;
      if (p !== o.delim && nq !== rowStart) {
        // a literal quote inside an unquoted field
        nq = view.indexOf(34, nq + 1);
        continue;
      }
      // quoted field: find the closing quote ("" is an escaped quote)
      let q = nq + 1;
      for (;;) {
        const c = view.indexOf(34, q);
        if (c === -1) {
          if (!final) return base + rowStart;
          q = hi;
          break;
        }
        if (c + 1 >= hi && !final) return base + rowStart;
        if (buf[c + 1] === 34 && c + 1 < hi) {
          q = c + 2;
          continue;
        }
        q = c + 1;
        break;
      }
      pos = q;
      continue;
    }
    if (nl === -1) break;
    let e = nl;
    if (e > rowStart && buf[e - 1] === 13) e--;
    if (!(o.skipBlank && isBlank(buf, rowStart, e))) emit(base + rowStart, base + e);
    rowStart = pos = nl + 1;
  }
  if (final && rowStart < hi) {
    let e = hi;
    if (e > rowStart && buf[e - 1] === 13) e--;
    if (!(o.skipBlank && isBlank(buf, rowStart, e))) emit(base + rowStart, base + e);
    rowStart = hi;
  }
  return base + rowStart;
}

function isBlank(buf: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    const c = buf[i];
    if (c !== 32 && c !== 9 && c !== 13) return false;
  }
  return true;
}

/** Dense index: start/end of every row (offsets < 4 GiB; resident files only). */
export class RowIndex {
  starts = new Uint32Array(4096);
  ends = new Uint32Array(4096);
  n = 0;
  push = (s: number, e: number): void => {
    if (this.n === this.starts.length) this.grow();
    this.starts[this.n] = s;
    this.ends[this.n] = e;
    this.n++;
  };
  private grow(): void {
    const cap = this.starts.length * 2;
    const s = new Uint32Array(cap);
    s.set(this.starts);
    const e = new Uint32Array(cap);
    e.set(this.ends);
    this.starts = s;
    this.ends = e;
  }
  pop(): void {
    if (this.n) this.n--;
  }
  truncate(n: number): void {
    this.n = Math.min(this.n, n);
  }
  get bytes(): number {
    return this.starts.byteLength * 2;
  }
}

/** Sparse index for streamed (non-resident) files: the start of every STRIDE-th row. */
export const STRIDE = 64;
export class SparseIndex {
  blocks = new Float64Array(1024);
  n = 0;
  /** Start of the last indexed row (to re-scan an incomplete last line). */
  lastStart = 0;
  push = (s: number, _e: number): void => {
    if (this.n % STRIDE === 0) {
      const b = this.n / STRIDE;
      if (b === this.blocks.length) {
        const nb = new Float64Array(b * 2);
        nb.set(this.blocks);
        this.blocks = nb;
      }
      this.blocks[b] = s;
    }
    this.n++;
    this.lastStart = s;
  };
  get bytes(): number {
    return this.blocks.byteLength;
  }
}
