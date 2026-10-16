// Text-based tables (CSV/TSV/JSONL/logs): bytes + row index. Resident files keep their bytes in one Buffer; files
// above the resident limit are streamed from disk with a sparse index and ranged reads.
import * as fs from 'fs';
import { RowIndex, ScanOptions, SparseIndex, STRIDE, scanRows } from './rowindex';
import { Slicer, Token, tick } from './sched';

export interface EncodingInfo {
  /** Display name. */
  name: string;
  /** BOM bytes at the start of the original file. */
  bom: Uint8Array;
  /** Bytes were converted to UTF-8 in memory. */
  transcoded: boolean;
  /** Can be written back. */
  writable: boolean;
}

export type RowHook = (i: number, s: number, e: number, buf: Uint8Array, base: number) => void;

const FIRST_CHUNK = 256 * 1024;
const CHUNK = 4 * 1024 * 1024;
const SCAN_SLICE = 1024 * 1024;

export function detectEncoding(head: Uint8Array): EncodingInfo {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { name: 'UTF-8 BOM', bom: head.slice(0, 3), transcoded: false, writable: true };
  if (head[0] === 0xff && head[1] === 0xfe) return { name: 'UTF-16 LE', bom: head.slice(0, 2), transcoded: true, writable: true };
  if (head[0] === 0xfe && head[1] === 0xff) return { name: 'UTF-16 BE', bom: head.slice(0, 2), transcoded: true, writable: true };
  return { name: 'UTF-8', bom: new Uint8Array(0), transcoded: false, writable: true };
}

/** Is the sample valid UTF-8 (ignoring a sequence cut off at the end)? */
export function isUtf8(sample: Uint8Array): boolean {
  let end = sample.length;
  // back off an incomplete trailing sequence
  for (let k = 1; k <= 3 && end - k >= 0; k++) {
    const c = sample[end - k];
    if ((c & 0xc0) === 0x80) continue;
    if (c >= 0xc0) {
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
      if (k < need) end -= k;
    }
    break;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

/** Decode a whole file in a non-UTF-8 encoding to UTF-8 bytes. */
export function transcode(bytes: Uint8Array, enc: EncodingInfo): Buffer {
  const body = bytes.subarray(enc.bom.length);
  let text: string;
  if (enc.name === 'UTF-16 LE') text = new TextDecoder('utf-16le').decode(body);
  else if (enc.name === 'UTF-16 BE') {
    const sw = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    sw.swap16();
    text = new TextDecoder('utf-16le').decode(sw);
  } else text = new TextDecoder(enc.name.toLowerCase()).decode(body);
  return Buffer.from(text, 'utf8');
}

/** Encode UTF-8 output back to the file's encoding (with its BOM). */
export function encodeOut(utf8: Buffer, enc: EncodingInfo): Buffer {
  if (enc.name === 'UTF-16 LE' || enc.name === 'UTF-16 BE') {
    const b = Buffer.from(utf8.toString('utf8'), 'utf16le');
    if (enc.name === 'UTF-16 BE') b.swap16();
    return Buffer.concat([Buffer.from(enc.bom), b]);
  }
  return enc.bom.length ? Buffer.concat([Buffer.from(enc.bom), utf8]) : utf8;
}

export class TextRows {
  resident = true;
  /** Resident bytes (UTF-8, without BOM); valid up to `size`. */
  buf: Buffer = Buffer.alloc(0);
  size = 0;
  /** Total bytes of the file on disk (streamed mode) */
  fileSize = 0;
  idx = new RowIndex();
  sparse?: SparseIndex;
  path?: string;
  /** Absolute offset of the next row the scanner has not consumed. */
  scanPos = 0;
  done = false;
  /** The last row was emitted at EOF without a trailing newline. */
  partialTail = false;
  /** Did the source end with a line break? */
  trailingEol = false;
  enc: EncodingInfo = detectEncoding(new Uint8Array(0));
  /** Offset of the data after the BOM, in the file (streamed mode reads at file offsets). */
  dataStart = 0;
  hook?: RowHook;
  /** Called with the first bytes (UTF-8, after the BOM) before indexing starts. */
  onHead?: (head: Uint8Array) => void;
  private blockCache = new Map<number, string[]>();

  constructor(public opts: ScanOptions) {}

  count(): number {
    return this.resident ? this.idx.n : this.sparse!.n;
  }

  private emitDense = (s: number, e: number): void => {
    const i = this.idx.n;
    this.idx.push(s, e);
    if (this.hook) this.hook(i, s, e, this.buf, 0);
  };

  /** Index resident bytes buf[scanPos, hi) in slices. */
  async scanResident(hi: number, final: boolean, slicer?: Slicer): Promise<void> {
    // a row hook (log level detection) costs ~µs per line: scan smaller pieces so the host stays responsive
    const piece = this.hook ? SCAN_SLICE >> 3 : SCAN_SLICE;
    while (this.scanPos < hi) {
      const stop = Math.min(hi, this.scanPos + piece);
      const last = stop === hi && final;
      // keep slicing on row boundaries: scanRows returns the first incomplete row
      const before = this.scanPos;
      this.scanPos = scanRows(this.buf, this.scanPos, stop, 0, last, this.opts, this.emitDense);
      if (this.scanPos === before && !last) {
        // a single row longer than the slice: scan up to hi in one go
        if (stop === hi) break;
        this.scanPos = scanRows(this.buf, this.scanPos, hi, 0, final, this.opts, this.emitDense);
        break;
      }
      if (slicer) await slicer.maybe();
    }
    if (final) {
      const n = this.idx.n;
      this.trailingEol = hi > 0 && this.buf[hi - 1] === 10;
      this.partialTail = !this.trailingEol && n > 0 && this.idx.ends[n - 1] >= hi - 1;
    }
  }

  /** Load a resident file from disk, reporting progress after the first chunk and then periodically. */
  async loadFile(path: string, onProgress: (first: boolean) => void, token: Token, slackBytes = 0): Promise<void> {
    this.path = path;
    const fh = await fs.promises.open(path, 'r');
    try {
      const { size } = await fh.stat();
      this.fileSize = size;
      const head = Buffer.alloc(Math.min(size, 65536));
      await fh.read(head, 0, head.length, 0);
      this.enc = detectEncoding(head);
      if (!this.enc.transcoded && !isUtf8(head.subarray(this.enc.bom.length))) {
        try {
          new TextDecoder('gb18030', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)));
          this.enc = { name: 'GB18030', bom: new Uint8Array(0), transcoded: true, writable: false };
        } catch {
          this.enc = { name: 'UTF-8', bom: new Uint8Array(0), transcoded: false, writable: true };
        }
      }
      if (this.enc.transcoded) {
        const all = Buffer.alloc(size);
        await fh.read(all, 0, size, 0);
        token.check();
        this.setBytes(transcode(all, this.enc));
        this.onHead?.(this.buf.subarray(0, 65536));
        await this.scanResident(this.size, true, new Slicer(token));
        this.done = true;
        onProgress(true);
        return;
      }
      const bom = this.enc.bom.length;
      this.dataStart = bom;
      this.onHead?.(head.subarray(bom));
      const total = size - bom;
      this.buf = Buffer.allocUnsafe(total + slackBytes);
      this.size = 0;
      let first = true;
      const slicer = new Slicer(token);
      while (this.size < total) {
        const want = Math.min(first ? FIRST_CHUNK : CHUNK, total - this.size);
        const { bytesRead } = await fh.read(this.buf, this.size, want, bom + this.size);
        token.check();
        if (bytesRead <= 0) break;
        this.size += bytesRead;
        await this.scanResident(this.size, this.size >= total, slicer);
        onProgress(first);
        first = false;
      }
      if (this.size < total) await this.scanResident(this.size, true, slicer);
      this.done = true;
      onProgress(first);
    } finally {
      await fh.close();
    }
  }

  /** Use the given UTF-8 bytes (no BOM) as resident content and reset the index. */
  setBytes(b: Buffer): void {
    this.buf = b;
    this.size = b.length;
    this.idx = new RowIndex();
    this.scanPos = 0;
    this.done = false;
    this.partialTail = false;
    this.blockCache.clear();
  }

  async loadBytes(bytes: Uint8Array, token: Token): Promise<void> {
    this.enc = detectEncoding(bytes.subarray(0, 4));
    if (!this.enc.transcoded && !isUtf8(bytes.subarray(this.enc.bom.length, 65536))) {
      try {
        new TextDecoder('gb18030', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 65536) - 4));
        this.enc = { name: 'GB18030', bom: new Uint8Array(0), transcoded: true, writable: false };
      } catch {
        /* keep UTF-8 */
      }
    }
    this.fileSize = bytes.length;
    if (this.enc.transcoded) this.setBytes(transcode(bytes, this.enc));
    else this.setBytes(Buffer.from(bytes.buffer, bytes.byteOffset + this.enc.bom.length, bytes.length - this.enc.bom.length));
    this.dataStart = this.enc.transcoded ? 0 : this.enc.bom.length;
    this.onHead?.(this.buf.subarray(0, 65536));
    await this.scanResident(this.size, true, new Slicer(token));
    this.done = true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Streamed mode

  async openStreamed(path: string, onProgress: (first: boolean) => void, token: Token): Promise<void> {
    this.resident = false;
    this.path = path;
    this.sparse = new SparseIndex();
    const fh = await fs.promises.open(path, 'r');
    try {
      const { size } = await fh.stat();
      this.fileSize = size;
      const head = Buffer.alloc(Math.min(size, 65536));
      await fh.read(head, 0, head.length, 0);
      this.enc = detectEncoding(head);
      if (this.enc.transcoded) this.enc = { ...this.enc, name: this.enc.name + ' (unsupported for large files)', transcoded: false, writable: false };
      this.dataStart = this.enc.bom.length;
      this.onHead?.(head.subarray(this.dataStart));
      this.scanPos = this.dataStart;
      await this.scanStreamed(fh, size, onProgress, token);
    } finally {
      await fh.close();
    }
  }

  private async scanStreamed(fh: fs.promises.FileHandle, size: number, onProgress: (first: boolean) => void, token: Token): Promise<void> {
    let chunk = Buffer.allocUnsafe(CHUNK);
    let first = true;
    const sp = this.sparse!;
    const emit = this.hook
      ? (s: number, e: number) => {
          const i = sp.n;
          sp.push(s, e);
          this.hook!(i, s, e, chunk, base);
        }
      : sp.push;
    let base = this.scanPos;
    let lastReport = performance.now();
    while (this.scanPos < size) {
      base = this.scanPos;
      const want = Math.min(first ? FIRST_CHUNK : chunk.length, size - base);
      const { bytesRead } = await fh.read(chunk, 0, want, base);
      token.check();
      if (bytesRead <= 0) break;
      const eof = base + bytesRead >= size;
      // scan in slices so a chunk full of short lines does not block for long
      let lo = 0;
      while (lo < bytesRead) {
        let hi = Math.min(bytesRead, lo + SCAN_SLICE);
        let next = scanRows(chunk, lo, hi, base, eof && hi === bytesRead, this.opts, emit) - base;
        if (next === lo && hi < bytesRead) {
          hi = bytesRead;
          next = scanRows(chunk, lo, hi, base, eof, this.opts, emit) - base;
        }
        if (next === lo) break;
        lo = next;
        await tick();
        token.check();
      }
      const consumed = lo;
      if (consumed === 0 && !eof) {
        // one row larger than the chunk
        const bigger = Buffer.allocUnsafe(chunk.length * 2);
        chunk = bigger;
        continue;
      }
      this.scanPos = base + consumed;
      if (eof) this.scanPos = size;
      const now = performance.now();
      if (first || now - lastReport > 150) {
        onProgress(first);
        first = false;
        lastReport = now;
      }
    }
    this.size = size;
    if (size > 0) {
      const tail = Buffer.alloc(1);
      await fh.read(tail, 0, 1, size - 1);
      this.trailingEol = tail[0] === 10;
      this.partialTail = !this.trailingEol && sp.n > 0;
    }
    this.done = true;
    onProgress(first);
  }

  /** Re-read the indexed part of a streamed file and call `hook` for every row (second pass, e.g. log levels). */
  async replay(hook: RowHook, token: Token, onProgress: () => void): Promise<void> {
    const fh = await fs.promises.open(this.path!, 'r');
    try {
      const end = this.scanPos;
      let chunk = Buffer.allocUnsafe(SCAN_SLICE * 2);
      let pos = this.dataStart;
      let i = 0;
      let last = performance.now();
      const slicer = new Slicer(token);
      while (pos < end) {
        const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, end - pos), pos);
        if (bytesRead <= 0) break;
        const base = pos;
        const eof = pos + bytesRead >= end;
        const next = scanRows(chunk, 0, bytesRead, base, eof, this.opts, (s, e) => hook(i++, s, e, chunk, base));
        if (next === base) {
          chunk = Buffer.allocUnsafe(chunk.length * 2);
          continue;
        }
        pos = eof ? end : next;
        await slicer.maybe();
        if (performance.now() - last > 250) {
          last = performance.now();
          onProgress();
        }
      }
    } finally {
      await fh.close();
    }
  }

  /** Byte range [start, end) of sparse block b. */
  private blockRange(b: number): [number, number] {
    const sp = this.sparse!;
    const start = sp.blocks[b];
    const nb = Math.ceil(sp.n / STRIDE);
    const end = b + 1 < nb ? sp.blocks[b + 1] : this.done ? this.size : this.scanPos;
    return [start, end];
  }

  private async readBlock(b: number): Promise<string[]> {
    const hit = this.blockCache.get(b);
    if (hit) {
      this.blockCache.delete(b);
      this.blockCache.set(b, hit);
      return hit;
    }
    const [start, end] = this.blockRange(b);
    const len = end - start;
    const bytes = Buffer.allocUnsafe(len);
    const fh = await fs.promises.open(this.path!, 'r');
    try {
      await fh.read(bytes, 0, len, start);
    } finally {
      await fh.close();
    }
    const rows: string[] = [];
    scanRows(bytes, 0, len, 0, true, this.opts, (s, e) => {
      if (rows.length < STRIDE) rows.push(bytes.toString('utf8', s, e));
    });
    this.blockCache.set(b, rows);
    if (this.blockCache.size > 256) this.blockCache.delete(this.blockCache.keys().next().value as number);
    return rows;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Access

  /** Row text (resident only). */
  text(i: number): string {
    return this.buf.toString('utf8', this.idx.starts[i], this.idx.ends[i]);
  }

  /** Raw bytes of row i including its line ending (resident only). */
  rawWithEol(i: number): [number, number] {
    const s = this.idx.starts[i];
    const e = i + 1 < this.idx.n ? this.idx.starts[i + 1] : this.size;
    return [s, e];
  }

  async textAsync(i: number): Promise<string> {
    if (this.resident) return this.text(i);
    const rows = await this.readBlock(Math.floor(i / STRIDE));
    return rows[i % STRIDE] ?? '';
  }

  /** Texts for arbitrary row indices. */
  async texts(ids: ArrayLike<number>): Promise<string[]> {
    const out: string[] = new Array(ids.length);
    if (this.resident) {
      for (let k = 0; k < ids.length; k++) out[k] = this.text(ids[k]);
      return out;
    }
    for (let k = 0; k < ids.length; k++) out[k] = await this.textAsync(ids[k]);
    return out;
  }

  /**
   * Visit rows [from, to) sequentially with their text. Streamed files are read in large chunks.
   * Yields to the event loop regularly.
   */
  async forEach(from: number, to: number, slicer: Slicer, fn: (i: number, text: string) => void): Promise<void> {
    if (this.resident) {
      for (let i = from; i < to; i++) {
        fn(i, this.text(i));
        if (slicer.due()) await slicer.yieldNow();
      }
      return;
    }
    const sp = this.sparse!;
    let i = from - (from % STRIDE);
    let pos = sp.blocks[i / STRIDE];
    const fh = await fs.promises.open(this.path!, 'r');
    try {
      let chunk = Buffer.allocUnsafe(SCAN_SLICE);
      while (i < to) {
        const end = Math.min(this.size, pos + chunk.length);
        const { bytesRead } = await fh.read(chunk, 0, end - pos, pos);
        if (bytesRead <= 0) break;
        const eof = pos + bytesRead >= this.size;
        const base = pos;
        let stop = false;
        const next = scanRows(chunk, 0, bytesRead, base, eof, this.opts, (s, e) => {
          if (stop) return;
          if (i >= from && i < to) fn(i, chunk.toString('utf8', s - base, e - base));
          i++;
          if (i >= to) stop = true;
        });
        if (next === base) {
          chunk = Buffer.allocUnsafe(chunk.length * 2);
          continue;
        }
        pos = next;
        if (eof) break;
        await slicer.yieldNow();
      }
    } finally {
      await fh.close();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Follow (appended data)

  /** Index bytes appended to the file since the last scan. Returns false when the file was replaced/truncated. */
  async append(token: Token): Promise<boolean> {
    if (!this.path) return false;
    const st = await fs.promises.stat(this.path);
    const fileSize = st.size;
    if (this.enc.transcoded) return fileSize === this.fileSize;
    const oldFile = this.resident ? this.size + this.dataStart : this.size;
    if (fileSize < oldFile) return false;
    if (fileSize === oldFile) return true;
    const fh = await fs.promises.open(this.path, 'r');
    try {
      // cheap check that the prefix is unchanged
      const probeLen = Math.min(64, oldFile - this.dataStart);
      if (probeLen > 0) {
        const probe = Buffer.alloc(probeLen);
        await fh.read(probe, 0, probeLen, oldFile - probeLen);
        const mine = this.resident ? this.buf.subarray(this.size - probeLen, this.size) : undefined;
        if (mine && !probe.equals(mine)) return false;
      }
      if (this.partialTail) {
        // the last line was incomplete: rescan it
        if (this.resident) {
          this.scanPos = this.idx.starts[this.idx.n - 1];
          this.idx.pop();
        } else {
          const sp = this.sparse!;
          sp.n--;
          this.scanPos = sp.lastStart;
        }
        this.partialTail = false;
      }
      if (this.resident) {
        const add = fileSize - oldFile;
        if (this.size + add > this.buf.length) {
          const nb = Buffer.allocUnsafe(Math.max(this.size + add, Math.ceil(this.buf.length * 1.5)) + (1 << 20));
          this.buf.copy(nb, 0, 0, this.size);
          this.buf = nb;
        }
        const { bytesRead } = await fh.read(this.buf, this.size, add, oldFile);
        this.size += bytesRead;
        await this.scanResident(this.size, true, new Slicer(token));
      } else {
        this.blockCache.clear();
        this.done = false;
        await this.scanStreamed(fh, fileSize, () => undefined, token);
      }
      this.fileSize = fileSize;
      return true;
    } finally {
      await fh.close();
    }
  }
}
