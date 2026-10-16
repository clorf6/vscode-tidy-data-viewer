// Parquet (read-only) through hyparquet: schema, row counts, lazy row-group reads for the visible window.
import * as fs from 'fs';
import * as zlib from 'zlib';
import { isMainThread, parentPort, Worker, workerData } from 'worker_threads';
import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import type { AsyncBuffer, Compressors, FileMetaData, SchemaElement } from 'hyparquet';
import { decompressLz4, decompressLz4Raw, decompressZstd } from 'hyparquet-compressors';
import type { TableModel } from './models';
import { CELL_MAX, ColMeta, ColType, RowData } from './protocol';
import { Slicer } from './sched';

const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Uint8Array) => Buffer }).zstdDecompressSync;

export const compressors: Compressors = {
  GZIP: (input: Uint8Array) => new Uint8Array(zlib.gunzipSync(input)),
  BROTLI: (input: Uint8Array) => new Uint8Array(zlib.brotliDecompressSync(input)),
  ZSTD: (input: Uint8Array) => (zstd ? new Uint8Array(zstd(input)) : decompressZstd(input)),
  LZ4: decompressLz4,
  LZ4_RAW: decompressLz4Raw,
} as Compressors;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function isoTs(ms: number, frac = ''): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(ms);
  const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const msPart = d.getUTCMilliseconds();
  return `${isoDate(d)} ${t}${msPart || frac ? '.' + pad(msPart, 3) + frac : ''}`;
}

// Timestamps/dates are formatted as strings directly (no Date objects, no timezone surprises).
const parsers = {
  timestampFromMilliseconds: (v: bigint) => isoTs(Number(v)),
  timestampFromMicroseconds: (v: bigint) => {
    const us = Number(v % 1000n);
    return isoTs(Number(v / 1000n), us ? pad(Math.abs(us), 3) : '');
  },
  timestampFromNanoseconds: (v: bigint) => isoTs(Number(v / 1000000n)),
  dateFromDays: (days: number) => isoDate(new Date(days * 86400000)),
};

function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

/** Display text + kind for a decoded parquet value. */
export function cellOf(v: unknown, scale?: number): [string, string] {
  if (v === null || v === undefined) return ['', 'z'];
  switch (typeof v) {
    case 'string':
      return [v, 's'];
    case 'number':
      return [scale !== undefined && isFinite(v) ? v.toFixed(Math.min(20, scale)) : String(v), 'n'];
    case 'bigint':
      return [v.toString(), 'n'];
    case 'boolean':
      return [v ? 'true' : 'false', 'b'];
  }
  if (v instanceof Date) return [isNaN(v.getTime()) ? '' : v.toISOString(), 's'];
  if (v instanceof Uint8Array) return [Buffer.from(v).toString('hex'), 's'];
  if (Array.isArray(v)) return [JSON.stringify(v, jsonReplacer), 'a'];
  return [JSON.stringify(v, jsonReplacer), 'o'];
}

function colTypeOf(el: SchemaElement, nested: boolean): ColType {
  if (nested) return 'json';
  const lt = el.logical_type?.type;
  const ct = el.converted_type;
  if (lt === 'DATE' || lt === 'TIMESTAMP' || ct === 'DATE' || ct === 'TIMESTAMP_MILLIS' || ct === 'TIMESTAMP_MICROS' || el.type === 'INT96') return 'date';
  if (lt === 'JSON' || ct === 'JSON') return 'json';
  if (lt === 'DECIMAL' || ct === 'DECIMAL' || el.type === 'FLOAT' || el.type === 'DOUBLE' || lt === 'FLOAT16') return 'float';
  if (el.type === 'INT32' || el.type === 'INT64') return 'int';
  if (el.type === 'BOOLEAN') return 'bool';
  return 'string';
}

function logicalName(el: SchemaElement): string {
  const lt = el.logical_type;
  if (lt) {
    if (lt.type === 'DECIMAL') return `DECIMAL(${lt.precision},${lt.scale})`;
    if (lt.type === 'TIMESTAMP' || lt.type === 'TIME') return `${lt.type}(${lt.unit}${lt.isAdjustedToUTC ? ', UTC' : ''})`;
    if (lt.type === 'INTEGER') return `INT(${lt.bitWidth}${lt.isSigned ? '' : ', unsigned'})`;
    return lt.type;
  }
  return el.converted_type ?? '';
}

export interface ParquetInfo {
  /** DECIMAL scale per column (formatted with fixed digits instead of float noise). */
  scales: (number | undefined)[];
  rows: number;
  groups: { start: number; end: number }[];
  columns: ColMeta[];
  names: string[];
  compression: string;
  createdBy?: string;
  version?: number;
}

/** hyparquet decoding with a cache of decoded row groups (or 4096-row blocks of very wide groups). */
export class ParquetEngine {
  info!: ParquetInfo;
  private meta!: FileMetaData;
  private fh?: fs.promises.FileHandle;
  private file!: AsyncBuffer;
  private cache = new Map<string, { s: number; rows: unknown[][] }>();
  private cells = 0;
  static CELL_BUDGET = 3_000_000;

  constructor(private path: string) {}

  async open(): Promise<ParquetInfo> {
    this.fh = await fs.promises.open(this.path, 'r');
    const { size } = await this.fh.stat();
    const fh = this.fh;
    this.file = {
      byteLength: size,
      slice: async (start: number, end?: number) => {
        const e = end ?? size;
        const buf = Buffer.allocUnsafe(e - start);
        await fh.read(buf, 0, e - start, start);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },
    };
    this.meta = await parquetMetadataAsync(this.file);
    const groups: { start: number; end: number }[] = [];
    let s = 0;
    for (const rg of this.meta.row_groups) {
      const n = Number(rg.num_rows);
      groups.push({ start: s, end: s + n });
      s += n;
    }
    const columns: ColMeta[] = [];
    const names: string[] = [];
    const scales: (number | undefined)[] = [];
    const schema = this.meta.schema;
    let i = 1;
    let key = 0;
    while (i < schema.length) {
      const el = schema[i];
      const nested = (el.num_children ?? 0) > 0;
      names.push(el.name);
      scales.push(!nested && (el.logical_type?.type === 'DECIMAL' || el.converted_type === 'DECIMAL') ? (el.logical_type?.type === 'DECIMAL' ? el.logical_type.scale : el.scale) ?? 0 : undefined);
      columns.push({
        key: key++,
        name: el.name,
        type: colTypeOf(el, nested || el.repetition_type === 'REPEATED'),
        physical: nested ? 'GROUP' : (el.type ?? ''),
        logical: logicalName(el) || (nested ? 'STRUCT' : ''),
        repetition: el.repetition_type,
      });
      i = skipSchema(schema, i);
    }
    const codecs = new Set<string>();
    for (const rg of this.meta.row_groups) for (const c of rg.columns) if (c.meta_data) codecs.add(c.meta_data.codec);
    this.info = { scales, rows: Number(this.meta.num_rows), groups, columns, names, compression: [...codecs].join(', '), createdBy: this.meta.created_by, version: this.meta.version };
    return this.info;
  }

  close(): void {
    void this.fh?.close();
    this.fh = undefined;
  }

  private async read(rowStart: number, rowEnd: number, columns?: string[]): Promise<unknown[][]> {
    let out: unknown[][] = [];
    await parquetRead({
      file: this.file,
      metadata: this.meta,
      rowStart,
      rowEnd,
      columns,
      compressors,
      parsers,
      rowFormat: 'array',
      onComplete: (rows: unknown[][]) => {
        out = rows;
      },
    });
    return out;
  }

  /** Decoded rows around `id`: the whole row group when it fits the cache budget, else a 4096-row block. */
  private async unit(id: number): Promise<{ s: number; rows: unknown[][] }> {
    const g = this.info.groups.findIndex((x) => id >= x.start && id < x.end);
    const grp = this.info.groups[g];
    const ncol = Math.max(1, this.info.columns.length);
    const whole = (grp.end - grp.start) * ncol <= ParquetEngine.CELL_BUDGET / 2;
    const s = whole ? grp.start : Math.max(grp.start, id - (id % 4096));
    const e = whole ? grp.end : Math.min(grp.end, s + 4096);
    const k = s + ':' + e;
    const hit = this.cache.get(k);
    if (hit) {
      this.cache.delete(k);
      this.cache.set(k, hit);
      return hit;
    }
    const u = { s, rows: await this.read(s, e) };
    this.cache.set(k, u);
    this.cells += (e - s) * ncol;
    while (this.cells > ParquetEngine.CELL_BUDGET && this.cache.size > 1) {
      const [ok, ov] = this.cache.entries().next().value as [string, { s: number; rows: unknown[][] }];
      this.cache.delete(ok);
      this.cells -= ov.rows.length * ncol;
    }
    return u;
  }

  async rows(ids: number[], full: boolean): Promise<RowData[]> {
    const out: RowData[] = [];
    for (const id of ids) {
      const u = await this.unit(id);
      const vals = u.rows[id - u.s] ?? [];
      const c: string[] = [];
      let kinds = '';
      let tr: number[] | undefined;
      for (let i = 0; i < this.info.columns.length; i++) {
        let [v, kind] = cellOf(vals[i], this.info.scales[i]);
        if (!full && v.length > CELL_MAX) {
          v = v.slice(0, CELL_MAX);
          (tr ??= []).push(i);
        }
        c.push(v);
        kinds += kind;
      }
      const row: RowData = { id, ln: id + 1, c, k: kinds };
      if (tr) row.tr = tr;
      out.push(row);
    }
    return out;
  }

  private colCache = new Map<string, (string | null)[]>();
  private colCells = 0;

  /** Display values of one column for a whole row group (cached: scans read each group once). */
  private async groupColumn(g: number, key: number): Promise<(string | null)[]> {
    const k = g + ':' + key;
    const hit = this.colCache.get(k);
    if (hit) {
      this.colCache.delete(k);
      this.colCache.set(k, hit);
      return hit;
    }
    const grp = this.info.groups[g];
    const rows = await this.read(grp.start, grp.end, [this.info.names[key]]);
    const vals = rows.map((r) => {
      const v = r[0];
      return v === null || v === undefined ? null : cellOf(v, this.info.scales[key])[0];
    });
    this.colCache.set(k, vals);
    this.colCells += vals.length;
    while (this.colCells > ParquetEngine.CELL_BUDGET && this.colCache.size > 1) {
      const [ok, ov] = this.colCache.entries().next().value as [string, (string | null)[]];
      this.colCache.delete(ok);
      this.colCells -= ov.length;
    }
    return vals;
  }

  /** Display values of some columns for rows [s, e) within one row group (null = missing). */
  async column(keys: number[], s: number, e: number): Promise<(string | null)[][]> {
    const g = this.info.groups.findIndex((x) => s >= x.start && s < x.end);
    const grp = this.info.groups[g];
    const out: (string | null)[][] = [];
    for (const key of keys) out.push((await this.groupColumn(g, key)).slice(s - grp.start, Math.min(e, grp.end) - grp.start));
    return out;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Decoding runs in a worker thread so big pages never block the extension host. The worker reuses this very bundle
// (with a stand-in for the `vscode` module); see startWorker below.

type Call = { id: number; method: 'open' | 'rows' | 'column'; args: unknown[] };

const IN_WORKER = !isMainThread && (workerData as { dvParquet?: string } | undefined)?.dvParquet !== undefined;
if (IN_WORKER) startWorker();

function startWorker(): void {
  const engine = new ParquetEngine((workerData as { dvParquet: string }).dvParquet);
  let chain = Promise.resolve();
  parentPort!.on('message', (m: Call) => {
    chain = chain.then(async () => {
      try {
        const fn = engine[m.method] as (...a: unknown[]) => Promise<unknown>;
        parentPort!.postMessage({ id: m.id, result: await fn.apply(engine, m.args) });
      } catch (e) {
        parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}

const BOOT = (bundle: string) => `
const M = require('module');
const make = () => { const f = function () {}; const p = new Proxy(f, { get: (t, k) => (k === 'prototype' ? t.prototype : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : p), apply: () => p, construct: () => ({}) }); return p; };
const stub = make();
const orig = M._load;
M._load = function (req, ...a) { return req === 'vscode' ? stub : orig.call(this, req, ...a); };
require(${JSON.stringify(bundle)});
`;

/** Calls into the engine, in a worker when possible (falls back to in-process). */
class EngineClient {
  private worker?: Worker;
  private local?: ParquetEngine;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(path: string) {
    const bundle = typeof __filename === 'string' ? __filename : '';
    if (/extension\.js$/.test(bundle) && !process.env.DV_PARQUET_INPROC) {
      try {
        this.worker = new Worker(BOOT(bundle), { eval: true, workerData: { dvParquet: path } });
        this.worker.unref();
        this.worker.on('message', (m: { id: number; result?: unknown; error?: string }) => {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error !== undefined) p.reject(new Error(m.error));
          else p.resolve(m.result);
        });
        this.worker.on('error', (e) => {
          for (const p of this.pending.values()) p.reject(e);
          this.pending.clear();
          this.worker = undefined;
        });
      } catch {
        this.worker = undefined;
      }
    }
    if (!this.worker) this.local = new ParquetEngine(path);
  }

  get inWorker(): boolean {
    return !!this.worker;
  }

  call<T>(method: Call['method'], ...args: unknown[]): Promise<T> {
    if (this.local) return (this.local[method] as (...a: unknown[]) => Promise<T>).apply(this.local, args);
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, method, args });
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.local?.close();
  }
}

export class ParquetModel implements TableModel {
  readonly kind = 'parquet' as const;
  columns: ColMeta[] = [];
  columnsChanged = false;
  rows = 0;
  groups: { start: number; end: number }[] = [];
  names: string[] = [];
  info!: ParquetInfo;
  private client: EngineClient;
  private identityCache?: Uint32Array;

  constructor(public path: string) {
    this.client = new EngineClient(path);
  }

  get inWorker(): boolean {
    return this.client.inWorker;
  }

  async open(): Promise<void> {
    this.info = await this.client.call<ParquetInfo>('open');
    this.rows = this.info.rows;
    this.groups = this.info.groups;
    this.columns = this.info.columns;
    this.names = this.info.names;
  }

  compression(): string {
    return this.info.compression;
  }

  dispose(): void {
    this.client.dispose();
  }

  count(): number {
    return this.rows;
  }
  isIdentity(): boolean {
    return true;
  }
  idAt(p: number): number {
    return p;
  }
  orderArray(): Uint32Array {
    if (!this.identityCache || this.identityCache.length !== this.rows) {
      this.identityCache = new Uint32Array(this.rows);
      for (let i = 0; i < this.rows; i++) this.identityCache[i] = i;
    }
    return this.identityCache;
  }
  colType(key: number): ColType {
    return this.columns[key]?.type ?? 'string';
  }

  getRows(ids: ArrayLike<number>, full: boolean): Promise<RowData[]> {
    return this.client.call<RowData[]>('rows', Array.from(ids), full);
  }

  /** Column values in slices of ≤ 32K rows (each slice decodes off-thread; visiting yields regularly). */
  private async *slices(keys: number[]): AsyncGenerator<{ s: number; vals: (string | null)[][] }> {
    for (const g of this.groups)
      for (let s = g.start; s < g.end; s += 32768) {
        const e = Math.min(g.end, s + 32768);
        yield { s, vals: await this.client.call<(string | null)[][]>('column', keys, s, e) };
      }
  }

  async scan(ids: ArrayLike<number>, keys: number[], slicer: Slicer, cb: (pos: number, id: number, vals: (string | undefined)[]) => void): Promise<void> {
    const identity = ids.length === this.rows && (ids.length === 0 || (ids[0] === 0 && ids[ids.length - 1] === this.rows - 1));
    const vals: (string | undefined)[] = new Array(keys.length);
    if (identity) {
      for await (const sl of this.slices(keys)) {
        const n = sl.vals[0]?.length ?? 0;
        for (let r = 0; r < n; r++) {
          for (let k = 0; k < keys.length; k++) vals[k] = sl.vals[k][r] ?? undefined;
          cb(sl.s + r, sl.s + r, vals);
          if (slicer.due()) await slicer.yieldNow();
        }
        await slicer.maybe();
      }
      return;
    }
    // arbitrary ids (filtered/sorted view): read in document order and report each row's view position
    // (callbacks therefore arrive in document order, not view order)
    const pos = new Int32Array(this.rows).fill(-1);
    for (let p = 0; p < ids.length; p++) pos[ids[p]] = p;
    for await (const sl of this.slices(keys)) {
      const n = sl.vals[0]?.length ?? 0;
      for (let r = 0; r < n; r++) {
        const id = sl.s + r;
        const p = pos[id];
        if (p < 0) continue;
        for (let k = 0; k < keys.length; k++) vals[k] = sl.vals[k][r] ?? undefined;
        cb(p, id, vals);
        if (slicer.due()) await slicer.yieldNow();
      }
      await slicer.maybe();
    }
  }
}

function skipSchema(schema: SchemaElement[], i: number): number {
  const n = schema[i].num_children ?? 0;
  i++;
  for (let c = 0; c < n; c++) i = skipSchema(schema, i);
  return i;
}
