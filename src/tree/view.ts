// The visible-rows engine: expansion state, the flattened list of visible rows (typed arrays, so millions of rows are
// cheap), row payloads for the window the webview asks for, search, arrays shown as tables and the pretty text view.
import { Path, Store } from './model';
import { naturalCompare } from './json';
import { Cell, Format, Kind, KeyKind, Mode, PreviewItem, Row, RowKind, SearchQuery, Syntax } from './protocol';

export const PREVIEW = 300;
const CELL = 120;
const PV_ITEMS = 6;
const PV_TEXT = 40;
const MAX_COLS = 300;

export interface TableState {
  col: number;
  desc: boolean;
}

interface TableInfo {
  cols: string[];
  colIndex: Map<string, number>;
  cw: number[];
  /** column 0 holds non-object elements */
  valueCol: boolean;
  order?: { col: number; desc: boolean; ids: Int32Array };
}

/** Search flags per node */
export const F_KEY = 1;
export const F_VAL = 2;
export const F_ANC = 4;

export interface Snapshot {
  depth: number;
  mode: Mode;
  syntax: Syntax;
  filter: boolean;
  over: [Path, boolean][];
  fold: [Path, boolean][];
  tables: [Path, TableState][];
}

export class View {
  mode: Mode = 'tree';
  syntax: Syntax;
  over = new Map<number, boolean>();
  fold = new Map<number, boolean>();
  tables = new Map<number, TableState>();
  filter = false;
  /** search */
  flags?: Uint8Array;
  matches = new Int32Array(0);
  matchCount = 0;
  current = -1;

  rows = new Int32Array(1024);
  rk = new Uint8Array(1024);
  aux = new Uint8Array(1024);
  len = 0;
  version = 0;

  private tinfo = new Map<number, TableInfo>();
  private eligible = new Map<number, boolean>();
  private lines?: { syntax: Syntax; open: Int32Array; close: Int32Array };

  constructor(
    public st: Store,
    public format: Format,
    public depth: number,
  ) {
    this.syntax = format === 'xml' ? 'xml' : format === 'yaml' ? 'yaml' : 'json';
  }

  /** Root row hidden (its children are the top level). */
  get rootHidden(): boolean {
    if (!this.st.n || !this.st.isContainer(0)) return false;
    return !(this.mode === 'pretty' && this.syntax === 'json');
  }

  get off(): number {
    return this.rootHidden ? 1 : 0;
  }

  /** Multi-document YAML stream (root = virtual list of documents). */
  get docRoot(): boolean {
    return this.st.n > 1 && this.st.kk[0] === KeyKind.None && this.st.kk[1] === KeyKind.Doc;
  }

  /** Display depth of a node's row. */
  dep(id: number): number {
    const d = this.st.depth[id] - this.off;
    // YAML pretty: documents are `---` separators, their contents start at column 0
    if (this.mode === 'pretty' && this.syntax === 'yaml' && this.docRoot && this.st.kk[id] !== KeyKind.Doc) return Math.max(0, d - 1);
    return d;
  }

  isExpanded(i: number): boolean {
    const st = this.st;
    if (!st.isContainer(i)) return false;
    if (i === 0 && this.rootHidden) return true;
    if (this.mode === 'pretty') return this.fold.get(i) ?? true;
    const o = this.over.get(i);
    if (o !== undefined) return o;
    if (this.filter && this.flags && this.flags[i] & F_ANC) return true;
    return st.depth[i] - this.off < this.depth;
  }

  setExpanded(i: number, on: boolean): void {
    if (this.mode === 'pretty') this.fold.set(i, on);
    else this.over.set(i, on);
  }

  /** Expand or collapse a whole subtree. */
  setSubtree(i: number, on: boolean): void {
    const st = this.st;
    const map = this.mode === 'pretty' ? this.fold : this.over;
    for (let c = i; c <= st.last[i]; c++) if (st.isContainer(c)) map.set(c, on);
  }

  expandTo(depth: number): void {
    this.depth = depth;
    this.over.clear();
    if (this.mode === 'pretty') {
      this.fold.clear();
      if (depth < 1e6) {
        const st = this.st;
        for (let i = 0; i < st.n; i++) if (st.isContainer(i) && st.depth[i] - this.off >= depth) this.fold.set(i, false);
      }
    }
  }

  /** Make a node visible: expand its ancestors. */
  reveal(id: number): void {
    const st = this.st;
    for (let a = st.parent[id]; a >= 0; a = st.parent[a]) if (!this.isExpanded(a)) this.setExpanded(a, true);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tables

  canTable(i: number): boolean {
    const st = this.st;
    if (st.kind[i] !== Kind.Arr || st.count[i] < 1) return false;
    const cached = this.eligible.get(i);
    if (cached !== undefined) return cached;
    let objs = 0;
    let seen = 0;
    let fields = 0;
    for (let c = st.firstChild(i); c >= 0 && seen < 100; c = st.nextSibling(c), seen++) {
      if (st.kind[c] === Kind.Obj) {
        objs++;
        fields += st.count[c];
      }
    }
    const ok = objs > 0 && objs >= seen * 0.7 && fields > 0;
    this.eligible.set(i, ok);
    return ok;
  }

  tableInfo(a: number): TableInfo {
    let t = this.tinfo.get(a);
    if (t) return t;
    const st = this.st;
    const cols: string[] = [];
    const colIndex = new Map<string, number>();
    let valueCol = false;
    for (let e = st.firstChild(a); e >= 0; e = st.nextSibling(e)) {
      if (st.kind[e] !== Kind.Obj) {
        valueCol = true;
        continue;
      }
      for (let c = st.firstChild(e); c >= 0; c = st.nextSibling(c)) {
        const k = String(st.key(c));
        if (!colIndex.has(k) && cols.length < MAX_COLS) {
          colIndex.set(k, cols.length);
          cols.push(k);
        }
      }
    }
    if (valueCol) {
      cols.unshift('');
      for (const [k, v] of colIndex) colIndex.set(k, v + 1);
    }
    const cw = cols.map((c) => Math.max(3, Math.min(48, c.length)));
    let sample = 0;
    for (let e = st.firstChild(a); e >= 0 && sample < 400; e = st.nextSibling(e), sample++) {
      if (st.kind[e] !== Kind.Obj) {
        cw[0] = Math.max(cw[0], Math.min(48, this.cellText(e).length));
        continue;
      }
      for (let c = st.firstChild(e); c >= 0; c = st.nextSibling(c)) {
        const k = colIndex.get(String(st.key(c)));
        if (k !== undefined) cw[k] = Math.max(cw[k], Math.min(48, this.cellText(c).length));
      }
    }
    t = { cols, colIndex, cw, valueCol };
    this.tinfo.set(a, t);
    return t;
  }

  /** Text a cell shows, padded for the hint icons some values get (dates, colours). */
  private cellText(c: number): string {
    const st = this.st;
    if (st.kind[c] === Kind.Obj) return `{${st.count[c]}}  `;
    if (st.kind[c] === Kind.Arr) return `[${st.count[c]}]  `;
    const s = st.text(c, 60);
    if (st.kind[c] === Kind.Str && /^(\d{4}-\d{2}-\d{2}|#[0-9a-f]{3,8}$|rgba?\(|hsla?\()/i.test(s)) return s + '   ';
    if (st.kind[c] === Kind.Date) return s + '   ';
    return s;
  }

  /** Element ids of table `a` in display order. */
  private tableOrder(a: number): Int32Array | undefined {
    const ts = this.tables.get(a);
    if (!ts || ts.col < 0) return undefined;
    const info = this.tableInfo(a);
    if (info.order && info.order.col === ts.col && info.order.desc === ts.desc) return info.order.ids;
    const st = this.st;
    const ids = Int32Array.from(st.children(a));
    const key = info.cols[ts.col];
    const vals = new Array<string | number | null>(ids.length);
    ids.forEach((e, k) => {
      let c = -1;
      if (info.valueCol && ts.col === 0) c = st.kind[e] === Kind.Obj ? -1 : e;
      else if (st.kind[e] === Kind.Obj) for (let x = st.firstChild(e); x >= 0; x = st.nextSibling(x)) if (String(st.key(x)) === key) c = x;
      if (c < 0) vals[k] = null;
      else if (st.kind[c] === Kind.Num) vals[k] = Number(st.text(c));
      else if (st.isContainer(c)) vals[k] = st.count[c];
      else vals[k] = st.text(c, 200);
    });
    const idx = [...ids.keys()];
    const dir = ts.desc ? -1 : 1;
    idx.sort((x, y) => {
      const a1 = vals[x];
      const b1 = vals[y];
      if (a1 === null || b1 === null) return a1 === b1 ? x - y : a1 === null ? 1 : -1;
      let r: number;
      if (typeof a1 === 'number' && typeof b1 === 'number') r = a1 - b1;
      else if (typeof a1 === 'number') r = -1;
      else if (typeof b1 === 'number') r = 1;
      else r = naturalCompare(a1, b1);
      return r * dir || x - y;
    });
    const sorted = Int32Array.from(idx.map((k) => ids[k]));
    info.order = { col: ts.col, desc: ts.desc, ids: sorted };
    return sorted;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Flattening

  private push(id: number, kind: RowKind, aux: number): void {
    if (this.len >= this.rows.length) {
      const cap = this.rows.length * 2;
      const r = new Int32Array(cap);
      r.set(this.rows);
      const k = new Uint8Array(cap);
      k.set(this.rk);
      const a = new Uint8Array(cap);
      a.set(this.aux);
      this.rows = r;
      this.rk = k;
      this.aux = a;
    }
    this.rows[this.len] = id;
    this.rk[this.len] = kind;
    this.aux[this.len] = aux;
    this.len++;
  }

  /**
   * Walk the visible structure. `all` ignores folding/tables/filter (used to number pretty lines). With `from`, emit
   * only what an expanded container `from` contributes below its own row (for in-place expansion).
   */
  private walk(all: boolean, emit: (id: number, kind: RowKind, aux: number) => void, from = -1): void {
    const st = this.st;
    if (!st.n) return;
    const pretty = this.mode === 'pretty';
    const syn = pretty ? this.syntax : null;
    const yamlStyle = syn === 'yaml';
    const xmlStyle = syn === 'xml';
    const closeRows = syn === 'json' || syn === 'xml';
    const filter = !all && !pretty && this.filter && !!this.flags;
    const flags = this.flags;
    const tables = !all && !pretty;
    const expanded = all ? (i: number) => st.isContainer(i) : (i: number) => this.isExpanded(i);
    let dash = 0;
    const out = (id: number, kind: RowKind) => {
      emit(id, kind, dash);
      dash = 0;
    };
    const tableRows = (c: number, sub: boolean) => {
      out(c, RowKind.TableHead);
      const order = this.tableOrder(c);
      if (order) {
        for (const e of order) if (!sub || flags![e]) out(e, RowKind.TableRow);
      } else for (let e = st.firstChild(c); e >= 0; e = st.nextSibling(e)) if (!sub || flags![e]) out(e, RowKind.TableRow);
    };
    let base = 0;
    let showRoot = false;
    if (from >= 0) {
      if (tables && st.kind[from] === Kind.Arr && this.tables.has(from)) return tableRows(from, false);
      base = from;
    } else {
      if (!st.isContainer(0)) {
        out(0, RowKind.Node);
        return;
      }
      showRoot = !this.rootHidden;
      if (showRoot) {
        out(0, RowKind.Node);
        if (st.count[0] === 0 || !expanded(0)) return;
      }
    }
    const nextStack: number[] = [];
    const contStack: number[] = [];
    const matchStack: boolean[] = [];
    let inMatch = false;
    let c = st.firstChild(base);
    for (;;) {
      if (c < 0) {
        if (!nextStack.length) break;
        const cont = contStack.pop()!;
        if (closeRows) out(cont, RowKind.Close);
        c = nextStack.pop()!;
        inMatch = matchStack.pop()!;
        continue;
      }
      if (filter && !inMatch && !(flags![c] & (F_KEY | F_VAL | F_ANC))) {
        c = st.nextSibling(c);
        continue;
      }
      if (xmlStyle && st.kk[c] === KeyKind.Attr) {
        c = st.nextSibling(c);
        continue;
      }
      const exp = st.isContainer(c) && st.count[c] > 0 && expanded(c) && !(xmlStyle && (!hasNonAttr(st, c) || simpleText(st, c) !== undefined));
      if (tables && exp && st.kind[c] === Kind.Arr && this.tables.has(c)) {
        out(c, RowKind.Node);
        tableRows(c, filter && !inMatch && !(flags![c] & (F_KEY | F_VAL)));
        c = st.nextSibling(c);
        continue;
      }
      // YAML: a `- ` item that is an expanded collection shares its line with its first child
      if (yamlStyle && exp && st.kk[c] === KeyKind.Index) dash++;
      else out(c, RowKind.Node);
      if (exp) {
        nextStack.push(st.nextSibling(c));
        contStack.push(c);
        matchStack.push(inMatch);
        if (filter && flags![c] & (F_KEY | F_VAL)) inMatch = true;
        c = st.firstChild(c);
        continue;
      }
      // stop at the end of `from`'s subtree
      c = from >= 0 && c === st.last[from] ? -1 : st.nextSibling(c);
    }
    if ((showRoot || from >= 0) && closeRows) out(base, RowKind.Close);
  }

  flatten(): void {
    this.len = 0;
    this.walk(false, (id, kind, aux) => this.push(id, kind, aux));
    this.version++;
  }

  /** Row of node i's own line (not a table row or close line), or -1. */
  private nodeRow(i: number): number {
    const rows = this.rows;
    const rk = this.rk;
    for (let r = 0; r < this.len; r++) if (rows[r] === i && rk[r] === RowKind.Node) return r;
    return -1;
  }

  /**
   * Expand or collapse node i by splicing its rows in or out (no full re-flatten: stays a few ms on million-row
   * views). Falls back to flatten() where rows interact (filter, YAML item lines).
   */
  setExpandedFast(i: number, on: boolean): void {
    const was = this.isExpanded(i);
    this.setExpanded(i, on);
    const now = this.isExpanded(i);
    if (was === now) return;
    const st = this.st;
    const r = this.nodeRow(i);
    const tricky = (this.mode === 'tree' && this.filter && !!this.flags) || (this.mode === 'pretty' && this.syntax === 'yaml') || !st.count[i] || r < 0;
    if (tricky) return this.flatten();
    if (now) {
      const ids: number[] = [];
      const kinds: number[] = [];
      this.walk(false, (id, kind) => {
        ids.push(id);
        kinds.push(kind);
      }, i);
      this.splice(r + 1, 0, ids, kinds);
    } else {
      let e = r + 1;
      const last = st.last[i];
      while (e < this.len && ((this.rows[e] > i && this.rows[e] <= last) || (this.rows[e] === i && this.rk[e] !== RowKind.Node))) e++;
      this.splice(r + 1, e - (r + 1), [], []);
    }
    this.version++;
  }

  /** Expand all collapsed ancestors of `id` with one splice at the topmost collapsed one. */
  revealFast(id: number): void {
    const st = this.st;
    const anc = st.ancestors(id);
    let top = -1;
    for (const a of anc) {
      if (!this.isExpanded(a)) {
        if (top < 0) top = a;
        this.setExpanded(a, true);
      }
    }
    if (top < 0) return;
    // re-collapse the topmost one for a moment so the splice inserts everything below it
    this.setExpanded(top, false);
    this.setExpandedFast(top, true);
  }

  private splice(at: number, remove: number, ids: number[], kinds: number[]): void {
    const add = ids.length;
    const len = this.len;
    const newLen = len - remove + add;
    if (newLen > this.rows.length) {
      let cap = this.rows.length;
      while (cap < newLen) cap *= 2;
      const r = new Int32Array(cap);
      r.set(this.rows.subarray(0, len));
      const k = new Uint8Array(cap);
      k.set(this.rk.subarray(0, len));
      const a = new Uint8Array(cap);
      a.set(this.aux.subarray(0, len));
      this.rows = r;
      this.rk = k;
      this.aux = a;
    }
    if (add !== remove) {
      this.rows.copyWithin(at + add, at + remove, len);
      this.rk.copyWithin(at + add, at + remove, len);
      this.aux.copyWithin(at + add, at + remove, len);
    }
    for (let k = 0; k < add; k++) {
      this.rows[at + k] = ids[k];
      this.rk[at + k] = kinds[k];
      this.aux[at + k] = 0;
    }
    this.len = newLen;
  }

  private ensureLines(): { open: Int32Array; close: Int32Array } {
    if (this.lines && this.lines.syntax === this.syntax) return this.lines;
    const st = this.st;
    const open = new Int32Array(st.n).fill(-1);
    const close = new Int32Array(st.n).fill(-1);
    let n = 0;
    const saveMode = this.mode;
    this.mode = 'pretty';
    this.walk(true, (id, kind) => {
      if (kind === RowKind.Close) close[id] = n;
      else open[id] = n;
      n++;
    });
    // YAML: items merged into their first child's line share its number
    if (this.syntax === 'yaml') for (let i = st.n - 1; i >= 0; i--) if (open[i] < 0 && st.count[i] > 0) open[i] = open[i + 1];
    this.mode = saveMode;
    this.lines = { syntax: this.syntax, open, close };
    return this.lines;
  }

  rowOf(id: number): number {
    const st = this.st;
    if (id < 0 || id >= st.n) return -1;
    let target = id;
    let kind = RowKind.Node;
    if (this.mode === 'tree') {
      for (let c = id, a = st.parent[id]; a >= 0; c = a, a = st.parent[a]) {
        if (this.tables.has(a) && this.isExpanded(a)) {
          target = c;
          kind = RowKind.TableRow;
        }
      }
    }
    const rows = this.rows;
    const rk = this.rk;
    for (let r = 0; r < this.len; r++) if (rows[r] === target && (rk[r] === kind || (kind === RowKind.Node && rk[r] === RowKind.Node))) return r;
    // YAML pretty: merged items → first child's row
    if (this.mode === 'pretty' && st.isContainer(id) && st.count[id] > 0) return this.rowOf(id + 1);
    return -1;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Row payloads

  private previewOf(i: number): [PreviewItem[], boolean] {
    const st = this.st;
    const items: PreviewItem[] = [];
    let chars = 0;
    let c = st.firstChild(i);
    for (; c >= 0 && items.length < PV_ITEMS && chars < 110; c = st.nextSibling(c)) {
      const kk = st.kk[c];
      let key: string | number | null = kk === KeyKind.Index ? null : (st.key(c) ?? null);
      if (typeof key === 'string' && key.length > 30) key = key.slice(0, 30) + '…';
      if (kk === KeyKind.Attr) key = '@' + key;
      const t = st.kind[c] as Kind;
      let s = '';
      if (t === Kind.Obj || t === Kind.Arr) s = String(st.count[c]);
      else {
        s = st.text(c, PV_TEXT + 1);
        if (s.length > PV_TEXT) s = s.slice(0, PV_TEXT) + '…';
      }
      chars += (typeof key === 'string' ? key.length + 2 : 0) + s.length + 2;
      items.push([key, t, s]);
    }
    return [items, c >= 0];
  }

  private cell(c: number): Cell {
    const st = this.st;
    const t = st.kind[c] as Kind;
    if (t === Kind.Obj || t === Kind.Arr) return { id: c, t, n: st.count[c] };
    const v = st.text(c, CELL);
    const cell: Cell = { id: c, t, v };
    if (t === Kind.Str || t === Kind.Comment) {
      const len = st.textLength(c);
      if (len > CELL) cell.tr = len;
    }
    return cell;
  }

  rowData(r: number, ro: boolean): Row {
    const st = this.st;
    const id = this.rows[r];
    const kind = this.rk[r] as RowKind;
    const off = this.off;
    const flags = this.flags;
    const cur = this.current >= 0 ? this.matches[this.current] : -1;
    const pidRaw = st.parent[id];
    const pid = pidRaw === 0 && this.rootHidden ? -1 : pidRaw;
    if (kind === RowKind.Close) {
      const row: Row = { id, r: kind, d: this.dep(id), pid, kk: st.kk[id], t: st.kind[id] };
      if (st.nextSibling(id) < 0) row.last = 1;
      const ln = this.ensureLines().close[id];
      if (ln >= 0) row.ln = ln + 1;
      if (this.syntax === 'xml') row.k = st.key(id);
      return row;
    }
    if (kind === RowKind.TableHead) {
      const info = this.tableInfo(id);
      const ts = this.tables.get(id);
      return { id, r: kind, d: st.depth[id] + 1 - off, pid: id, kk: KeyKind.None, t: Kind.Arr, cols: info.cols, cw: info.cw, sort: ts && ts.col >= 0 ? { col: ts.col, desc: ts.desc } : undefined, n: st.count[id] };
    }
    if (kind === RowKind.TableRow) {
      const a = st.parent[id];
      const info = this.tableInfo(a);
      const cells: (Cell | null)[] = new Array(info.cols.length).fill(null);
      if (st.kind[id] === Kind.Obj) {
        for (let c = st.firstChild(id); c >= 0; c = st.nextSibling(c)) {
          const k = info.colIndex.get(String(st.key(c)));
          if (k !== undefined && !cells[k]) cells[k] = this.cell(c);
        }
      } else if (info.valueCol) cells[0] = this.cell(id);
      const row: Row = { id, r: kind, d: st.depth[id] - off, pid: a, kk: st.kk[id], k: st.key(id), t: st.kind[id], tid: a, ti: st.pos[id], cells };
      if (flags && flags[id]) row.m = (flags[id] & (F_KEY | F_VAL | F_ANC) ? 1 : 0) | (cur >= 0 && (cur === id || (cur > id && cur <= st.last[id])) ? 4 : 0);
      if (ro || st.meta.get(id)?.ro) row.ro = 1;
      return row;
    }
    const t = st.kind[id] as Kind;
    const row: Row = { id, r: kind, d: this.dep(id), pid, kk: st.kk[id], t };
    const key = st.key(id);
    if (key !== undefined) row.k = typeof key === 'string' && key.length > 500 ? key.slice(0, 500) + '…' : key;
    if (t === Kind.Obj || t === Kind.Arr) {
      row.n = st.count[id];
      const exp = st.count[id] > 0 && this.isExpanded(id);
      if (exp) row.x = 1;
      else if (st.count[id] > 0) {
        const [pv, more] = this.previewOf(id);
        row.pv = pv;
        if (more) row.pm = 1;
      }
      if (t === Kind.Arr && this.mode === 'tree' && this.canTable(id)) row.tb = this.tables.has(id) ? 2 : 1;
    } else {
      row.v = st.text(id, PREVIEW);
      if (t === Kind.Str || t === Kind.Comment) {
        const len = row.v.length < PREVIEW ? row.v.length : st.textLength(id);
        if (len > PREVIEW) row.tr = len;
      }
    }
    const m = st.meta.get(id);
    if (m) {
      if (m.tag) row.tag = m.tag;
      if (m.anchor) row.anchor = m.anchor;
      if (m.alias !== undefined && m.alias >= 0) row.alias = m.alias;
      if (m.comment) row.c = m.comment.length > 200 ? m.comment.slice(0, 200) + '…' : m.comment;
      if (m.ro) row.ro = 1;
      if (m.line) row.line = m.line;
      if (m.flavor === 'cdata') row.tag = 'CDATA';
    }
    if (ro) row.ro = 1;
    if (flags) {
      const f = flags[id] & (F_KEY | F_VAL);
      // 8: a collapsed container with matches inside
      const anc = flags[id] & F_ANC && row.x !== 1 ? 8 : 0;
      if (f || anc || cur === id) row.m = f | anc | (cur === id ? 4 : 0);
    }
    if (this.mode === 'pretty') {
      if (st.nextSibling(id) < 0) row.last = 1;
      const ln = this.ensureLines().open[id];
      if (ln >= 0) row.ln = ln + 1;
      const dash = this.aux[r];
      if (dash) row.dash = dash;
      if (this.syntax === 'xml' && st.kk[id] === KeyKind.Elem && st.isContainer(id)) {
        const attrs: [string, string][] = [];
        for (let c = st.firstChild(id); c >= 0 && attrs.length < 64; c = st.nextSibling(c)) if (st.kk[c] === KeyKind.Attr) attrs.push([String(st.key(c)), st.text(c, PREVIEW)]);
        if (attrs.length) row.attrs = attrs;
        const txt = simpleText(st, id);
        if (txt !== undefined) {
          row.v = txt.length > PREVIEW ? txt.slice(0, PREVIEW) : txt;
          if (txt.length > PREVIEW) row.tr = txt.length;
          row.n = 0;
          delete row.x;
        } else if (!hasNonAttr(st, id)) row.n = 0;
      }
    }
    return row;
  }

  rowsData(start: number, end: number, ro: boolean): Row[] {
    const out: Row[] = [];
    const e = Math.min(end, this.len);
    for (let r = Math.max(0, start); r < e; r++) out.push(this.rowData(r, ro));
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Search

  setSearch(res: SearchResult | undefined): void {
    if (!res) {
      this.flags = undefined;
      this.matches = new Int32Array(0);
      this.matchCount = 0;
      this.current = -1;
      return;
    }
    this.flags = res.flags;
    this.matches = res.matches;
    this.matchCount = res.count;
    this.current = res.count ? 0 : -1;
  }

  // -------------------------------------------------------------------------------------------------------------
  // State that survives a re-parse (by path)

  snapshot(): Snapshot {
    const st = this.st;
    const conv = (m: Map<number, boolean>) => {
      const out: [Path, boolean][] = [];
      for (const [id, v] of m) {
        if (out.length > 20000) break;
        if (id < st.n) out.push([st.path(id), v]);
      }
      return out;
    };
    return {
      depth: this.depth,
      mode: this.mode,
      syntax: this.syntax,
      filter: this.filter,
      over: conv(this.over),
      fold: conv(this.fold),
      tables: [...this.tables].filter(([id]) => id < st.n).map(([id, s]) => [st.path(id), s]),
    };
  }

  restore(s: Snapshot): void {
    const st = this.st;
    this.depth = s.depth;
    this.mode = s.mode;
    this.syntax = s.syntax;
    this.filter = s.filter;
    for (const [p, v] of s.over) {
      const id = st.find(p);
      if (id >= 0) this.over.set(id, v);
    }
    for (const [p, v] of s.fold) {
      const id = st.find(p);
      if (id >= 0) this.fold.set(id, v);
    }
    for (const [p, v] of s.tables) {
      const id = st.find(p);
      if (id >= 0 && st.kind[id] === Kind.Arr) this.tables.set(id, v);
    }
  }
}

/** XML element whose only non-attribute child is one text node: shown as <a x="1">text</a> on one line. */
function simpleText(st: Store, i: number): string | undefined {
  let text: string | undefined;
  for (let c = st.firstChild(i); c >= 0; c = st.nextSibling(c)) {
    if (st.kk[c] === KeyKind.Attr) continue;
    if (text !== undefined || st.kk[c] !== KeyKind.Text || st.key(c) !== '#text') return undefined;
    text = st.text(c);
  }
  return text;
}

function hasNonAttr(st: Store, i: number): boolean {
  for (let c = st.firstChild(i); c >= 0; c = st.nextSibling(c)) if (st.kk[c] !== KeyKind.Attr) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Search (resumable so a 2 M node document doesn't block the extension host)

export interface SearchResult {
  flags: Uint8Array;
  matches: Int32Array;
  count: number;
  capped: boolean;
}

const MAX_MATCHES = 1_000_000;

export function compileQuery(q: SearchQuery, global = false): RegExp {
  let src = q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // word boundaries that also work for non-ASCII letters
  if (q.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, (q.caseSensitive ? '' : 'i') + (q.wholeWord ? 'u' : '') + (global ? 'g' : ''));
}

/**
 * Whole-document search over every node (collapsed ones included), in time slices. The scan starts at `from` (the
 * selection) and wraps around, so the first hit after the cursor is found first; results come back in document order.
 */
export class Searcher {
  /** scan position, counted from `from` */
  private k = 0;
  private flags: Uint8Array;
  private after: number[] = [];
  private before: number[] = [];
  private count = 0;
  private keys: boolean;
  private values: boolean;
  private from: number;
  /** first match in scan order (the one to reveal), or -1 */
  first = -1;
  constructor(
    private st: Store,
    private re: RegExp,
    scope: 'all' | 'keys' | 'values' = 'all',
    from = 0,
  ) {
    this.flags = new Uint8Array(st.n);
    this.keys = scope !== 'values';
    this.values = scope !== 'keys';
    this.from = from > 0 && from < st.n ? from : 0;
  }

  get progress(): number {
    return this.st.n ? this.k / this.st.n : 1;
  }

  get done(): boolean {
    return this.k >= this.st.n;
  }

  get found(): number {
    return this.count;
  }

  step(budgetMs = 1e9): boolean {
    const st = this.st;
    const n = st.n;
    const re = this.re;
    const flags = this.flags;
    const keys = this.keys;
    const values = this.values;
    const deadline = performance.now() + budgetMs;
    for (; this.k < n; this.k++) {
      if ((this.k & 0xfff) === 0 && performance.now() > deadline) return false;
      let i = this.from + this.k;
      if (i >= n) i -= n;
      let f = 0;
      if (keys) {
        const kk = st.kk[i];
        if (kk === KeyKind.Prop || kk === KeyKind.Attr || kk === KeyKind.Elem || kk === KeyKind.Section || kk === KeyKind.Decl) {
          const key = st.key(i);
          if (typeof key === 'string' && re.test(key)) f |= F_KEY;
        }
      }
      if (values) {
        const t = st.kind[i];
        if (t !== Kind.Obj && t !== Kind.Arr && re.test(st.text(i))) f |= F_VAL;
      }
      if (f) {
        flags[i] |= f;
        this.count++;
        if (this.first < 0) this.first = i;
        if (this.after.length + this.before.length < MAX_MATCHES) (i >= this.from ? this.after : this.before).push(i);
        for (let a = st.parent[i]; a >= 0 && !(flags[a] & F_ANC); a = st.parent[a]) flags[a] |= F_ANC;
      }
    }
    return true;
  }

  result(): SearchResult {
    const m = new Int32Array(this.before.length + this.after.length);
    m.set(this.before);
    m.set(this.after, this.before.length);
    return { flags: this.flags, matches: m, count: this.count, capped: this.count > m.length };
  }
}

