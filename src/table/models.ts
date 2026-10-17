// Table models: CSV/TSV, JSONL and logs on top of TextRows, with an edit overlay (CSV/JSONL) and serialization.
import { DELIMS, detectHeader, letterName, parseRow, parseRowPrefix, serializeRow, sniffDelimiter } from './csv';
import { inferJsonType, inferType } from './infer';
import { compactJson, displayValue, inputToRaw, kindOf, Member, objectLine, rewriteLine, scanObject } from './jsonl';
import { analyzeLine, levelOfRaw } from './log';
import { ADDED_BASE, CELL_MAX, ColMeta, ColType, RowData, TableKind } from './protocol';
import { SLICE_MS, Slicer, Token } from './sched';
import { RowHook, TextRows } from './textrows';

export interface Change {
  label: string;
  undo(): void;
  redo(): void;
}

export interface CellSet {
  id: number;
  key: number;
  value: string;
}

/** Common surface used by the document, the query engine and the provider. */
export interface TableModel {
  readonly kind: TableKind;
  columns: ColMeta[];
  /** Number of data rows. */
  count(): number;
  /** Ids of all data rows in document order. */
  orderArray(): Uint32Array;
  /** Is orderArray() the plain source order (so streamed files can be scanned sequentially)? */
  isIdentity(): boolean;
  /** Id of the data row at document position p. */
  idAt(p: number): number;
  getRows(ids: ArrayLike<number>, full: boolean): Promise<RowData[]>;
  /** Visit `ids` with the values of the given column keys (undefined = missing/null). */
  scan(ids: ArrayLike<number>, keys: number[], slicer: Slicer, cb: (pos: number, id: number, vals: (string | undefined)[]) => void, identity?: boolean): Promise<void>;
  colType(key: number): ColType;
  /** Set when columns were discovered/changed since the flag was last cleared. */
  columnsChanged: boolean;
}

export function truncate(s: string): string {
  return s.length > CELL_MAX ? s.slice(0, CELL_MAX) : s;
}

/**
 * Drop the final line ending of serialized output (a file that had none keeps none). Works on the list of parts the
 * serializers build, without joining them: the ending can straddle two parts ("\r" | "\n").
 */
function trimFinalEol(parts: Buffer[]): Buffer[] {
  while (parts.length && !parts[parts.length - 1].length) parts.pop();
  const i = parts.length - 1;
  if (i < 0 || parts[i][parts[i].length - 1] !== 10) return parts;
  const p = parts[i];
  if (p.length > 1) parts[i] = p.subarray(0, p.length - (p[p.length - 2] === 13 ? 2 : 1));
  else {
    parts.pop();
    const q = parts[i - 1];
    if (q && q[q.length - 1] === 13) parts[i - 1] = q.subarray(0, q.length - 1);
  }
  return parts;
}

/** Bytes of serialized parts, joined (small files, tests). */
export function joinParts(parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

function rangeArray(from: number, n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = from + i;
  return a;
}

/** Shared row bookkeeping for text formats: ids, logical order (after inserts/deletes) and added rows. */
abstract class TextModel {
  order: number[] | null = null;
  nextAdded = ADDED_BASE;
  columnsChanged = false;
  private identityCache?: Uint32Array;
  constructor(public rows: TextRows) {}
  /** First data row (1 when the first record is a header). */
  first(): number {
    return 0;
  }
  count(): number {
    return this.order ? this.order.length : Math.max(0, this.rows.count() - this.first());
  }
  isIdentity(): boolean {
    return !this.order;
  }
  idAt(p: number): number {
    return this.order ? this.order[p] : this.first() + p;
  }
  orderArray(): Uint32Array {
    if (this.order) return Uint32Array.from(this.order);
    const n = this.count();
    if (!this.identityCache || this.identityCache.length !== n || (n && this.identityCache[0] !== this.first())) this.identityCache = rangeArray(this.first(), n);
    return this.identityCache;
  }
  materializeOrder(): number[] {
    if (!this.order) {
      const n = this.count();
      const o = new Array<number>(n);
      for (let i = 0; i < n; i++) o[i] = this.first() + i;
      this.order = o;
    }
    return this.order;
  }
  lineNo(id: number): number {
    return id >= ADDED_BASE ? 0 : id + 1;
  }
  hasEdits(): boolean {
    return false;
  }
  isEdited(_id: number): boolean {
    return false;
  }
  /** Insert `count` new rows after `afterId` (null = at the start). */
  insertRows(afterId: number | null, count: number, init: (id: number) => void, drop: (id: number) => void): { ids: number[]; change: Change } {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(this.nextAdded++);
    const order = this.materializeOrder();
    const at = () => (afterId === null ? 0 : order.indexOf(afterId) + 1);
    const apply = () => {
      for (const id of ids) init(id);
      order.splice(at(), 0, ...ids);
    };
    apply();
    return {
      ids,
      change: {
        label: 'Insert Row',
        undo: () => {
          const p = order.indexOf(ids[0]);
          if (p >= 0) order.splice(p, ids.length);
          for (const id of ids) drop(id);
        },
        redo: apply,
      },
    };
  }
  deleteRows(ids: number[]): Change {
    const order = this.materializeOrder();
    const set = new Set(ids);
    let removed: [number, number][] = [];
    const apply = () => {
      removed = [];
      let w = 0;
      for (let r = 0; r < order.length; r++) {
        const id = order[r];
        if (set.has(id)) removed.push([r, id]);
        else order[w++] = id;
      }
      order.length = w;
    };
    apply();
    return {
      label: 'Delete Rows',
      undo: () => {
        for (const [pos, id] of removed) order.splice(pos, 0, id);
      },
      redo: apply,
    };
  }
}

// =================================================================================================================
// CSV / TSV

interface EditedRow {
  /** values by physical column id */
  f: string[];
  /** quoted flags by physical column id */
  q: boolean[];
  /** values of inserted columns (pid ≥ NEW_PID) */
  x?: Map<number, string>;
}

/** Column ids of inserted columns start here, so they never collide with physical field indices. */
export const NEW_PID = 1 << 20;

export class CsvModel extends TextModel implements TableModel {
  readonly kind = 'csv' as const;
  columns: ColMeta[] = [];
  delim = ',';
  hasHeader = true;
  headerAuto = true;
  physCount = 0;
  colMap: number[] = [];
  names = new Map<number, string>();
  types = new Map<number, ColType>();
  edited = new Map<number, EditedRow>();
  nextPid = NEW_PID;
  header: string[] = [];
  ragged = 0;
  analyzed = false;

  first(): number {
    return this.hasHeader ? 1 : 0;
  }

  private async sample(ids: number[]): Promise<string[]> {
    return this.rows.texts(ids.filter((i) => i < this.rows.count()));
  }

  /** Decide delimiter + header from the first indexed rows. */
  async setup(name: string, setting: string | undefined, forcedDelim?: string, header?: boolean): Promise<void> {
    const n = Math.min(this.rows.count(), 200);
    const sample = await this.sample(Array.from({ length: n }, (_, i) => i));
    if (forcedDelim) this.delim = forcedDelim;
    else if (setting && setting !== 'auto' && DELIMS.includes(setting)) this.delim = setting;
    else {
      const ext = name.toLowerCase().split('.').pop();
      const byName = ext === 'tsv' || ext === 'tab' ? '\t' : ext === 'psv' ? '|' : undefined;
      this.delim = byName ?? sniffDelimiter(sample.join('\n'), ',');
    }
    this.rows.opts.delim = this.delim.charCodeAt(0);
    const parsed = sample.map((s) => parseRow(s, this.delim));
    if (header === undefined) {
      this.hasHeader = detectHeader(parsed.slice(0, 100));
      this.headerAuto = true;
    } else {
      this.hasHeader = header;
      this.headerAuto = false;
    }
    this.physCount = Math.max(1, ...parsed.map((r) => r.length));
    this.colMap = Array.from({ length: this.physCount }, (_, i) => i);
    this.header = this.hasHeader && parsed[0] ? parsed[0] : [];
    await this.inferTypes();
    this.buildColumns();
  }

  async setHeader(on: boolean): Promise<void> {
    this.hasHeader = on;
    this.headerAuto = false;
    this.header = on && this.rows.count() ? parseRow((await this.sample([0]))[0], this.delim) : [];
    await this.inferTypes();
    this.buildColumns();
  }

  colName(pid: number, li: number): string {
    const n = this.names.get(pid);
    if (n !== undefined) return n;
    if (this.hasHeader) {
      const h = this.header[pid];
      if (h !== undefined && h.trim() !== '') return h;
      return letterName(li);
    }
    return letterName(pid);
  }

  buildColumns(): void {
    this.columns = this.colMap.map((pid, li) => ({ key: pid, name: this.colName(pid, li), type: this.types.get(pid) ?? 'string' }));
    this.columnsChanged = true;
  }

  colType(key: number): ColType {
    return this.types.get(key) ?? 'string';
  }

  /** Sample rows (spread over the file once indexed) for type inference. */
  async inferTypes(): Promise<void> {
    const n = this.rows.count();
    const ids: number[] = [];
    const f = this.first();
    // wide tables: keep the sample to ~200k cells (head + spread) so inference stays cheap
    const per = Math.max(100, Math.min(1000, Math.floor(100_000 / Math.max(1, this.physCount))));
    for (let i = f; i < Math.min(n, f + per); i++) ids.push(i);
    if (n > 3000 && this.rows.done) for (let k = 0; k < per; k++) ids.push(f + per + Math.floor(((n - f - per) * k) / per));
    const cols: string[][] = Array.from({ length: this.physCount }, () => []);
    const slicer = new Slicer(undefined, SLICE_MS, 8);
    for (const text of await this.sample(ids)) {
      const fields = parseRow(text, this.delim);
      for (let c = 0; c < this.physCount; c++) cols[c].push(fields[c] ?? '');
      await slicer.step();
    }
    const types: ColType[] = [];
    for (let c = 0; c < this.physCount; c++) {
      types.push(inferType(cols[c]));
      await slicer.step();
    }
    types.forEach((t, c) => this.types.set(c, t));
  }

  /** Field counts of every row (quote-aware byte scan): extends columns for ragged rows. */
  async analyze(slicer: Slicer): Promise<void> {
    const r = this.rows;
    const d = this.delim.charCodeAt(0);
    let max = this.physCount;
    let ragged = 0;
    const expect = this.hasHeader ? this.header.length : this.physCount;
    const countRow = (buf: Uint8Array, s: number, e: number) => {
      let n = 1;
      let inQ = false;
      for (let i = s; i < e; i++) {
        const c = buf[i];
        if (c === 34) inQ = !inQ;
        else if (c === d && !inQ) n++;
      }
      return n;
    };
    if (r.resident) {
      for (let i = this.first(); i < r.idx.n; i++) {
        const n = countRow(r.buf, r.idx.starts[i], r.idx.ends[i]);
        if (n !== expect && !(n === 1 && r.idx.starts[i] === r.idx.ends[i])) ragged++;
        if (n > max) max = n;
        if (slicer.due()) await slicer.yieldNow();
      }
    }
    this.ragged = ragged;
    this.analyzed = true;
    if (max > this.physCount) {
      for (let p = this.physCount; p < max; p++) this.colMap.push(p);
      this.physCount = max;
    }
    if (this.rows.count() > 3000) await this.inferTypes();
    this.buildColumns();
  }

  private fieldsOf(id: number, text: string | undefined): string[] {
    const e = this.edited.get(id);
    if (e) return e.f;
    return text === undefined ? [] : parseRow(text, this.delim);
  }

  private cell(id: number, fields: string[], pid: number): string {
    if (pid >= NEW_PID) return this.edited.get(id)?.x?.get(pid) ?? '';
    return fields[pid] ?? '';
  }

  hasEdits(): boolean {
    return this.edited.size > 0;
  }
  isEdited(id: number): boolean {
    return this.edited.has(id);
  }

  /** Values of the given column keys for one row (search). */
  valuesOf(id: number, text: string, keys: number[]): string[] {
    const fields = this.fieldsOf(id, text);
    return keys.map((k) => this.cell(id, fields, k));
  }

  async getRows(ids: ArrayLike<number>, full: boolean): Promise<RowData[]> {
    const src: number[] = [];
    for (let k = 0; k < ids.length; k++) if (ids[k] < ADDED_BASE && !this.edited.has(ids[k])) src.push(ids[k]);
    const texts = new Map<number, string>();
    const t = await this.rows.texts(src);
    src.forEach((id, k) => texts.set(id, t[k]));
    const out: RowData[] = [];
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const fields = this.fieldsOf(id, texts.get(id));
      const c: string[] = new Array(this.colMap.length);
      let tr: number[] | undefined;
      for (let li = 0; li < this.colMap.length; li++) {
        const v = this.cell(id, fields, this.colMap[li]);
        if (!full && v.length > CELL_MAX) {
          c[li] = v.slice(0, CELL_MAX);
          (tr ??= []).push(li);
        } else c[li] = v;
      }
      const row: RowData = { id, ln: id >= ADDED_BASE ? 0 : id - this.first() + 1, c };
      if (tr) row.tr = tr;
      if (this.edited.has(id)) row.f = 2;
      out.push(row);
    }
    return out;
  }

  async scan(ids: ArrayLike<number>, keys: number[], slicer: Slicer, cb: (pos: number, id: number, vals: (string | undefined)[]) => void, identity = false): Promise<void> {
    const maxPid = Math.max(0, ...keys.filter((k) => k < NEW_PID));
    const vals: (string | undefined)[] = new Array(keys.length);
    const visit = (pos: number, id: number, text: string | undefined) => {
      const e = this.edited.get(id);
      const f = e?.f ?? (text === undefined ? [] : parseRowPrefix(text, this.delim, maxPid));
      for (let k = 0; k < keys.length; k++) vals[k] = keys[k] >= NEW_PID ? e?.x?.get(keys[k]) : f[keys[k]];
      cb(pos, id, vals);
    };
    if (!this.rows.resident) {
      if (identity) {
        const f = this.first();
        await this.rows.forEach(f, f + ids.length, slicer, (i, text) => visit(i - f, i, text));
      } else
        for (let p = 0; p < ids.length; p++) {
          visit(p, ids[p], ids[p] < ADDED_BASE ? await this.rows.textAsync(ids[p]) : undefined);
          if (slicer.due()) await slicer.yieldNow();
        }
      return;
    }
    // resident: pick the needed fields straight from the bytes (only quoted rows are decoded and parsed in full)
    const r = this.rows;
    const buf = r.buf as Buffer & { latin1Slice(s: number, e: number): string; utf8Slice(s: number, e: number): string };
    const starts = r.idx.starts;
    const ends = r.idx.ends;
    const d = this.delim.charCodeAt(0);
    const want = new Int32Array(maxPid + 1).fill(-1);
    keys.forEach((k, i) => {
      if (k < NEW_PID) want[k] = i;
    });
    for (let p = 0; p < ids.length; p++) {
      const id = ids[p];
      if (id >= ADDED_BASE || this.edited.has(id)) visit(p, id, undefined);
      else {
        const e = ends[id];
        let i = starts[id];
        let field = 0;
        let fs = i;
        let high = false;
        let quoted = false;
        vals.fill(undefined);
        if (buf[i] === 34) quoted = true;
        else
          for (; i <= e; i++) {
            const c = i < e ? buf[i] : d;
            if (c === d) {
              const k = want[field];
              if (k >= 0) vals[k] = high ? buf.utf8Slice(fs, i) : buf.latin1Slice(fs, i);
              if (++field > maxPid) break;
              fs = i + 1;
              high = false;
              if (buf[fs] === 34 && fs < e) {
                quoted = true;
                break;
              }
            } else if (c >= 0x80) high = true;
          }
        if (quoted) visit(p, id, r.text(id));
        else cb(p, id, vals);
      }
      if (slicer.due()) await slicer.yieldNow();
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Editing

  private materialize(id: number): EditedRow {
    let e = this.edited.get(id);
    if (!e) {
      const q: boolean[] = [];
      const f = id < ADDED_BASE ? parseRow(this.rows.text(id), this.delim, q) : [];
      e = { f, q };
      this.edited.set(id, e);
    }
    return e;
  }

  private snapshot(ids: number[]): Map<number, EditedRow | undefined> {
    const m = new Map<number, EditedRow | undefined>();
    for (const id of ids) {
      const e = this.edited.get(id);
      m.set(id, e ? { f: e.f.slice(), q: e.q.slice(), x: e.x && new Map(e.x) } : undefined);
    }
    return m;
  }

  private restore(m: Map<number, EditedRow | undefined>): void {
    for (const [id, e] of m) {
      if (e) this.edited.set(id, { f: e.f.slice(), q: e.q.slice(), x: e.x && new Map(e.x) });
      else this.edited.delete(id);
    }
  }

  setCells(sets: CellSet[], label = 'Edit Cell'): Change {
    const ids = [...new Set(sets.map((s) => s.id))];
    const before = this.snapshot(ids);
    for (const s of sets) {
      const e = this.materialize(s.id);
      if (s.key >= NEW_PID) (e.x ??= new Map()).set(s.key, s.value);
      else {
        while (e.f.length <= s.key) e.f.push('');
        e.f[s.key] = s.value;
      }
    }
    const after = this.snapshot(ids);
    return { label, undo: () => this.restore(before), redo: () => this.restore(after) };
  }

  insertRowsAfter(afterId: number | null, count: number): { ids: number[]; change: Change } {
    return this.insertRows(
      afterId,
      count,
      (id) => this.edited.set(id, { f: [], q: [] }),
      (id) => this.edited.delete(id),
    );
  }

  insertCol(at: number, name: string): Change {
    const pid = this.nextPid++;
    const apply = () => {
      this.colMap.splice(Math.min(at, this.colMap.length), 0, pid);
      this.names.set(pid, name);
      this.types.set(pid, 'empty');
      this.buildColumns();
    };
    apply();
    return {
      label: 'Insert Column',
      undo: () => {
        const p = this.colMap.indexOf(pid);
        if (p >= 0) this.colMap.splice(p, 1);
        this.buildColumns();
      },
      redo: apply,
    };
  }

  renameCol(key: number, name: string): Change {
    const prev = this.names.get(key);
    const apply = (n: string | undefined) => {
      if (n === undefined) this.names.delete(key);
      else this.names.set(key, n);
      this.buildColumns();
    };
    apply(name);
    return { label: 'Rename Column', undo: () => apply(prev), redo: () => apply(name) };
  }

  deleteCol(key: number): Change {
    const pos = this.colMap.indexOf(key);
    const apply = () => {
      const p = this.colMap.indexOf(key);
      if (p >= 0) this.colMap.splice(p, 1);
      this.buildColumns();
    };
    apply();
    return {
      label: 'Delete Column',
      undo: () => {
        this.colMap.splice(pos, 0, key);
        this.buildColumns();
      },
      redo: apply,
    };
  }

  private colsIdentity(): boolean {
    if (this.colMap.length !== this.physCount) return false;
    for (let i = 0; i < this.colMap.length; i++) if (this.colMap[i] !== i) return false;
    return true;
  }

  /** Serialize to UTF-8 (without BOM). Unchanged rows are copied byte for byte. */
  serialize(eol: string): Buffer {
    return joinParts(this.serializeParts(eol));
  }

  /**
   * The file's new content (UTF-8) as a list of parts: unchanged runs of rows are slices of the loaded bytes, edited
   * rows are new buffers. Saving writes them one after another, so a large file is never copied in memory.
   */
  serializeParts(eol: string): Buffer[] {
    const r = this.rows;
    const parts: Buffer[] = [];
    const ident = this.colsIdentity();
    const eolBuf = Buffer.from(eol);
    let runS = -1;
    let runE = -1;
    let lastSrc = -2;
    const flush = () => {
      if (runS >= 0) parts.push(r.buf.subarray(runS, runE));
      runS = runE = -1;
    };
    const verbatim = (id: number) => {
      const [s, e] = r.rawWithEol(id);
      if (runS >= 0 && id === lastSrc + 1 && s === runE) runE = e;
      else {
        flush();
        runS = s;
        runE = e;
      }
      lastSrc = id;
      if (e === r.size && r.buf[e - 1] !== 10) {
        flush();
        parts.push(eolBuf);
      }
    };
    const fieldsFor = (id: number): { f: string[]; q: boolean[] } => {
      const e = this.edited.get(id);
      if (e) return e;
      const q: boolean[] = [];
      return { f: parseRow(r.text(id), this.delim, q), q };
    };
    const emitFields = (id: number, f: string[], q: boolean[]) => {
      flush();
      lastSrc = -2;
      const out = this.colMap.map((pid) => this.cell(id, f, pid));
      const qq = this.colMap.map((pid) => (pid < NEW_PID ? q[pid] : false));
      // keep ragged rows ragged when the columns are unchanged
      if (ident) {
        let n = out.length;
        while (n > f.length && n > 0 && out[n - 1] === '') n--;
        out.length = n;
      }
      parts.push(Buffer.from(serializeRow(out, this.delim, qq) + eol));
    };
    const headerChanged = this.hasHeader && (!ident || this.names.size > 0);
    if (this.hasHeader && r.count() > 0) {
      if (headerChanged) {
        const hq: boolean[] = [];
        parseRow(r.text(0), this.delim, hq);
        const names = this.colMap.map((pid, li) => this.names.get(pid) ?? this.header[pid] ?? letterName(li));
        flush();
        parts.push(Buffer.from(serializeRow(names, this.delim, this.colMap.map((pid) => hq[pid])) + eol));
      } else verbatim(0);
    }
    const order = this.orderArray();
    for (let k = 0; k < order.length; k++) {
      const id = order[k];
      if (id < ADDED_BASE && ident && !this.edited.has(id)) verbatim(id);
      else {
        const { f, q } = id < ADDED_BASE || this.edited.has(id) ? fieldsFor(id) : { f: [], q: [] };
        emitFields(id, f, q);
      }
    }
    flush();
    return r.trailingEol ? parts : trimFinalEol(parts);
  }
}

// =================================================================================================================
// JSON Lines

export const VALUE_KEY_NAME = '(value)';

export class JsonlModel extends TextModel implements TableModel {
  readonly kind = 'jsonl' as const;
  columns: ColMeta[] = [];
  keys: string[] = [];
  keyPid = new Map<string, number>();
  colMap: number[] = [];
  names = new Map<number, string>();
  types = new Map<number, ColType>();
  edited = new Map<number, string>();
  deleted = new Set<number>();
  valuePid = -1;
  invalid: number[] = [];
  invalidCount = 0;
  validated = false;

  private pidFor(key: string): number {
    let p = this.keyPid.get(key);
    if (p === undefined) {
      p = this.keys.length;
      this.keys.push(key);
      this.keyPid.set(key, p);
      this.colMap.push(p);
      this.columnsChanged = true;
    }
    return p;
  }

  private valueCol(): number {
    if (this.valuePid < 0) {
      this.valuePid = this.keys.length;
      this.keys.push('\u0000value');
      this.colMap.push(this.valuePid);
      this.names.set(this.valuePid, VALUE_KEY_NAME);
      this.columnsChanged = true;
    }
    return this.valuePid;
  }

  colType(key: number): ColType {
    return this.types.get(key) ?? 'string';
  }

  buildColumns(): void {
    this.columns = this.colMap.map((pid) => ({ key: pid, name: this.names.get(pid) ?? this.keys[pid], type: this.types.get(pid) ?? 'string' }));
    this.columnsChanged = true;
  }

  lineText(id: number, text?: string): string {
    return this.edited.get(id) ?? text ?? (id < ADDED_BASE ? this.rows.text(id) : '{}');
  }

  /** Does the file escape non-ASCII characters (\uXXXX)? Then raw-text prefiltering is unsafe for such queries. */
  unicodeEscapes = false;

  hasEdits(): boolean {
    return this.edited.size > 0 || this.deleted.size > 0;
  }
  isEdited(id: number): boolean {
    return this.edited.has(id);
  }

  /** Display values of the given keys for one row (search); undefined = missing/null. */
  valuesOf(id: number, text: string, keys: number[]): (string | undefined)[] {
    const s = this.lineText(id, text);
    const out: (string | undefined)[] = new Array(keys.length).fill(undefined);
    const m = scanObject(s);
    if (m) {
      for (const mm of m) {
        const pid = this.keyPid.get(mm.key);
        if (pid === undefined) continue;
        const k = keys.indexOf(pid);
        if (k >= 0 && mm.kind !== 'z') out[k] = displayValue(s.slice(mm.vs, mm.ve), mm.kind);
      }
    } else {
      const k = keys.indexOf(this.valuePid);
      if (k >= 0) out[k] = s.trim();
    }
    return out;
  }

  /** Discover keys and infer types from a sample of rows. */
  async setup(): Promise<void> {
    const n = this.rows.count();
    const ids: number[] = [];
    for (let i = 0; i < Math.min(n, 1000); i++) ids.push(i);
    await this.sampleTypes(ids);
  }

  async sampleTypes(ids: number[]): Promise<void> {
    ids = ids.filter((id) => id < this.rows.count());
    const texts = await this.rows.texts(ids);
    const kinds = new Map<number, string[]>();
    const vals = new Map<number, string[]>();
    const add = (pid: number, k: string, v: string) => {
      (kinds.get(pid) ?? kinds.set(pid, []).get(pid)!).push(k);
      (vals.get(pid) ?? vals.set(pid, []).get(pid)!).push(v);
    };
    for (let t = 0; t < ids.length; t++) {
      const s = this.lineText(ids[t], texts[t]);
      if (!this.unicodeEscapes && s.includes('\\u')) this.unicodeEscapes = true;
      const m = scanObject(s);
      if (m) for (const mm of m) add(this.pidFor(mm.key), mm.kind, displayValue(s.slice(mm.vs, mm.ve), mm.kind));
      else if (s.trim()) {
        const p = this.valueCol();
        try {
          JSON.parse(s);
          const k = kindOf(s, s.search(/\S/));
          add(p, k, displayValue(s.trim(), k));
        } catch {
          add(p, 's', s);
        }
      }
    }
    for (const pid of this.colMap) {
      const k = kinds.get(pid);
      if (k) this.types.set(pid, inferJsonType(k, vals.get(pid)!));
    }
    this.buildColumns();
  }

  /** Background pass: validate every line and discover all keys. */
  async validate(slicer: Slicer, onProgress: (frac: number) => void): Promise<void> {
    const invalid: number[] = [];
    let count = 0;
    const n = this.rows.count();
    let last = performance.now();
    await this.rows.forEach(0, n, slicer, (i, s) => {
      let v: unknown;
      try {
        v = JSON.parse(s);
      } catch {
        count++;
        if (invalid.length < 100000) invalid.push(i);
        return;
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const k in v as object) if (!this.keyPid.has(k)) this.pidFor(k);
      } else this.valueCol();
      if ((i & 4095) === 0) {
        const now = performance.now();
        if (now - last > 200) {
          onProgress(i / n);
          last = now;
        }
      }
    });
    this.invalid = invalid;
    this.invalidCount = count;
    this.validated = true;
    if (this.columnsChanged) {
      const spread: number[] = [];
      for (let k = 0; k < 2000 && n; k++) spread.push(Math.floor((n * k) / 2000));
      await this.sampleTypes(spread);
    }
  }

  isInvalid(id: number): boolean {
    if (!this.validated) return false;
    // binary search (invalid is sorted)
    let lo = 0;
    let hi = this.invalid.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.invalid[mid];
      if (v === id) return true;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  private cellsOf(id: number, s: string, full: boolean): RowData {
    const c: string[] = new Array(this.colMap.length).fill('');
    const kinds: string[] = new Array(this.colMap.length).fill('u');
    let tr: number[] | undefined;
    let flags = this.edited.has(id) ? 2 : 0;
    const m = scanObject(s);
    const put = (pid: number, v: string, k: string) => {
      const li = this.colMap.indexOf(pid);
      if (li < 0) return;
      while (c.length <= li) {
        c.push('');
        kinds.push('u');
      }
      if (!full && v.length > CELL_MAX) {
        v = v.slice(0, CELL_MAX);
        (tr ??= []).push(li);
      }
      c[li] = v;
      kinds[li] = k;
    };
    if (m) {
      for (const mm of m) {
        const pid = this.pidFor(mm.key);
        put(pid, displayValue(s.slice(mm.vs, mm.ve), mm.kind), mm.kind);
      }
    } else if (s.trim()) {
      const pid = this.valueCol();
      let ok = true;
      try {
        JSON.parse(s);
      } catch {
        ok = false;
      }
      if (ok) {
        const k = kindOf(s, s.search(/\S/));
        put(pid, displayValue(s.trim(), k), k);
      } else {
        put(pid, s, 's');
        flags |= 1;
      }
    }
    // columns discovered while parsing this row
    while (c.length < this.colMap.length) {
      c.push('');
      kinds.push('u');
    }
    const row: RowData = { id, ln: this.lineNo(id), c, k: kinds.join('') };
    if (tr) row.tr = tr;
    if (flags || this.isInvalid(id)) row.f = flags | (this.isInvalid(id) ? 1 : 0);
    return row;
  }

  async getRows(ids: ArrayLike<number>, full: boolean): Promise<RowData[]> {
    const src: number[] = [];
    for (let k = 0; k < ids.length; k++) if (ids[k] < ADDED_BASE && !this.edited.has(ids[k])) src.push(ids[k]);
    const texts = new Map<number, string>();
    const t = await this.rows.texts(src);
    src.forEach((id, k) => texts.set(id, t[k]));
    const before = this.colMap.length;
    const out: RowData[] = [];
    for (let k = 0; k < ids.length; k++) out.push(this.cellsOf(ids[k], this.lineText(ids[k], texts.get(ids[k])), full));
    if (this.colMap.length !== before) {
      for (const r of out) while (r.c.length < this.colMap.length) (r.c.push(''), (r.k += 'u'));
      this.buildColumns();
    }
    return out;
  }

  async scan(ids: ArrayLike<number>, keys: number[], slicer: Slicer, cb: (pos: number, id: number, vals: (string | undefined)[]) => void, identity = false): Promise<void> {
    const names = keys.map((k) => this.keys[k]);
    const vals: (string | undefined)[] = new Array(keys.length);
    // once every line is known to parse, stop scanning a line at the last wanted key (duplicate keys: first wins)
    const want = this.validated && this.invalidCount === this.invalid.length ? new Set(names.filter((x) => x !== undefined)) : undefined;
    const visit = (pos: number, id: number, s: string) => {
      vals.fill(undefined);
      const m = scanObject(s, want && !this.edited.has(id) && !this.isInvalid(id) ? want : undefined);
      if (m) {
        for (const mm of m) {
          const k = names.indexOf(mm.key);
          if (k >= 0 && mm.kind !== 'z') vals[k] = displayValue(s.slice(mm.vs, mm.ve), mm.kind);
        }
      } else {
        const k = keys.indexOf(this.valuePid);
        if (k >= 0 && s.trim()) vals[k] = s.trim();
      }
      cb(pos, id, vals);
    };
    if (!this.rows.resident) {
      if (identity) await this.rows.forEach(0, ids.length, slicer, (i, s) => visit(i, i, s));
      else
        for (let p = 0; p < ids.length; p++) {
          visit(p, ids[p], await this.rows.textAsync(ids[p]));
          if (slicer.due()) await slicer.yieldNow();
        }
      return;
    }
    for (let p = 0; p < ids.length; p++) {
      visit(p, ids[p], this.lineText(ids[p]));
      if (slicer.due()) await slicer.yieldNow();
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Editing

  private setLines(m: Map<number, string | undefined>): void {
    for (const [id, s] of m) {
      if (s === undefined) this.edited.delete(id);
      else this.edited.set(id, s);
    }
  }

  setCells(sets: CellSet[], label = 'Edit Cell'): Change {
    const ids = [...new Set(sets.map((s) => s.id))];
    const before = new Map<number, string | undefined>(ids.map((id) => [id, this.edited.get(id)]));
    for (const id of ids) {
      const line = this.lineText(id);
      let members: Member[] | null = scanObject(line);
      let base = line;
      if (!members) {
        // a non-object line becomes an object only through the (value) column
        const vs = sets.find((s) => s.id === id && s.key === this.valuePid);
        if (vs) {
          this.edited.set(id, vs.value);
          continue;
        }
        base = '{}';
        members = [];
      }
      const set = new Map<string, string | undefined>();
      for (const s of sets) {
        if (s.id !== id || s.key === this.valuePid) continue;
        const key = this.keys[s.key];
        const m = members.find((mm) => mm.key === key);
        const numeric = this.colType(s.key) === 'int' || this.colType(s.key) === 'float';
        set.set(key, s.value === '' && !m ? undefined : inputToRaw(s.value, m ? m.kind : 'u', numeric));
      }
      for (const [k, v] of set) if (v === undefined) set.delete(k);
      this.edited.set(id, rewriteLine(base, members, { set }));
    }
    const after = new Map<number, string | undefined>(ids.map((id) => [id, this.edited.get(id)]));
    return { label, undo: () => this.setLines(before), redo: () => this.setLines(after) };
  }

  insertRowsAfter(afterId: number | null, count: number): { ids: number[]; change: Change } {
    return this.insertRows(
      afterId,
      count,
      (id) => this.edited.set(id, '{}'),
      (id) => this.edited.delete(id),
    );
  }

  insertCol(at: number, name: string): Change {
    const pid = this.pidFor(name);
    const was = this.colMap.indexOf(pid);
    if (was >= 0) this.colMap.splice(was, 1);
    const apply = () => {
      const p = this.colMap.indexOf(pid);
      if (p >= 0) this.colMap.splice(p, 1);
      this.colMap.splice(Math.min(at, this.colMap.length), 0, pid);
      this.deleted.delete(pid);
      this.types.set(pid, this.types.get(pid) ?? 'empty');
      this.buildColumns();
    };
    apply();
    return {
      label: 'Insert Column',
      undo: () => {
        const p = this.colMap.indexOf(pid);
        if (p >= 0) this.colMap.splice(p, 1);
        if (was < 0) this.deleted.add(pid);
        this.buildColumns();
      },
      redo: apply,
    };
  }

  renameCol(key: number, name: string): Change {
    const prev = this.names.get(key);
    const apply = (n: string | undefined) => {
      if (n === undefined || n === this.keys[key]) this.names.delete(key);
      else this.names.set(key, n);
      this.buildColumns();
    };
    apply(name);
    return { label: 'Rename Column', undo: () => apply(prev), redo: () => apply(name) };
  }

  deleteCol(key: number): Change {
    const pos = this.colMap.indexOf(key);
    const apply = () => {
      const p = this.colMap.indexOf(key);
      if (p >= 0) this.colMap.splice(p, 1);
      this.deleted.add(key);
      this.buildColumns();
    };
    apply();
    return {
      label: 'Delete Column',
      undo: () => {
        this.colMap.splice(pos, 0, key);
        this.deleted.delete(key);
        this.buildColumns();
      },
      redo: apply,
    };
  }

  serialize(eol: string): Buffer {
    return joinParts(this.serializeParts(eol));
  }

  /** As CsvModel.serializeParts: unchanged runs are slices of the loaded bytes. */
  serializeParts(eol: string): Buffer[] {
    const r = this.rows;
    const parts: Buffer[] = [];
    const rename = new Map<string, string>();
    for (const [pid, n] of this.names) if (pid !== this.valuePid) rename.set(this.keys[pid], n);
    const drop = new Set<string>();
    for (const pid of this.deleted) drop.add(this.keys[pid]);
    const transform = rename.size > 0 || drop.size > 0;
    const order = this.orderArray();
    let runS = -1;
    let runE = -1;
    const flush = () => {
      if (runS >= 0) parts.push(r.buf.subarray(runS, runE));
      runS = runE = -1;
    };
    for (let k = 0; k < order.length; k++) {
      const id = order[k];
      if (!transform && id < ADDED_BASE && !this.edited.has(id)) {
        const [s, e] = r.rawWithEol(id);
        // rawWithEol of a row followed by skipped blank lines spans them; cut at the row end + its EOL
        const end = Math.min(e, r.idx.ends[id] + (r.buf[r.idx.ends[id]] === 13 ? 2 : 1));
        if (runS >= 0 && s === runE && end === e) runE = e;
        else {
          flush();
          runS = s;
          runE = end;
        }
        if (end >= r.size && r.buf[end - 1] !== 10) {
          flush();
          parts.push(Buffer.from(eol));
        }
        continue;
      }
      flush();
      let line = this.lineText(id);
      if (transform) {
        const m = scanObject(line);
        if (m) {
          const set = new Map<string, string | undefined>();
          for (const mm of m) if (drop.has(mm.key)) set.set(mm.key, undefined);
          line = rewriteLine(line, m, { set, rename });
        }
      }
      parts.push(Buffer.from(line + eol));
    }
    flush();
    return r.trailingEol ? parts : trimFinalEol(parts);
  }

  /** Raw JSON for a cell (detail panel pretty printing). */
  rawValue(id: number, key: number): string | undefined {
    const s = this.lineText(id);
    const m = scanObject(s);
    if (!m) return key === this.valuePid ? s : undefined;
    const mm = m.find((x) => x.key === this.keys[key]);
    return mm ? compactJson(s.slice(mm.vs, mm.ve)) : undefined;
  }
}

export { objectLine };

// =================================================================================================================
// Logs

export class LogModel extends TextModel implements TableModel {
  readonly kind = 'log' as const;
  columns: ColMeta[] = [{ key: 0, name: 'Message', type: 'string' }];
  levels = new Uint8Array(1 << 16);
  counts = [0, 0, 0, 0, 0, 0, 0];
  private prev = 0;

  /** Levels are known for all indexed lines (streamed files compute them in a second pass). */
  levelsReady = true;
  private levelHook: RowHook;

  constructor(rows: TextRows) {
    super(rows);
    rows.hook = this.levelHook = (i, s, e, buf, base) => {
      const end = Math.min(e, s + 240);
      const head = (buf as Buffer).toString('latin1', s - base, end - base);
      const lv = levelOfRaw(head, this.prev);
      this.prev = lv;
      if (i >= this.levels.length) {
        const nl = new Uint8Array(Math.max(i + 1, this.levels.length * 2));
        nl.set(this.levels);
        this.levels = nl;
      }
      // a re-scanned partial line replaces its old level
      if (i < this.indexed) this.counts[this.levels[i]]--;
      else this.indexed = i + 1;
      this.levels[i] = lv;
      this.counts[lv]++;
    };
  }
  private indexed = 0;

  /** Streamed logs: index line offsets first (fast), then detect levels in a second pass. */
  deferLevels(): void {
    this.rows.hook = undefined;
    this.levelsReady = false;
  }

  async levelPass(token: Token, onProgress: () => void): Promise<void> {
    this.prev = 0;
    await this.rows.replay(this.levelHook, token, onProgress);
    this.rows.hook = this.levelHook;
    this.levelsReady = true;
  }

  colType(): ColType {
    return 'string';
  }

  async getRows(ids: ArrayLike<number>): Promise<RowData[]> {
    const texts = await this.rows.texts(ids);
    const out: RowData[] = [];
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const raw = texts[k].length > 20000 ? texts[k].slice(0, 20000) : texts[k];
      const { text, log } = analyzeLine(raw, this.levels[id] ?? 0);
      log.lv = this.levels[id] ?? log.lv;
      out.push({ id, ln: id + 1, c: [text], log });
    }
    return out;
  }

  async scan(ids: ArrayLike<number>, _keys: number[], slicer: Slicer, cb: (pos: number, id: number, vals: (string | undefined)[]) => void, identity = false): Promise<void> {
    const vals: (string | undefined)[] = [undefined];
    if (!this.rows.resident && identity) {
      await this.rows.forEach(0, ids.length, slicer, (i, s) => {
        vals[0] = s;
        cb(i, i, vals);
      });
      return;
    }
    if (!this.rows.resident) {
      for (let p = 0; p < ids.length; p++) {
        vals[0] = await this.rows.textAsync(ids[p]);
        cb(p, ids[p], vals);
        if (slicer.due()) await slicer.yieldNow();
      }
      return;
    }
    for (let p = 0; p < ids.length; p++) {
      vals[0] = this.rows.text(ids[p]);
      cb(p, ids[p], vals);
      if (slicer.due()) await slicer.yieldNow();
    }
  }
}
