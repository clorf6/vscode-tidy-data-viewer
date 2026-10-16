// Compact node store shared by every format. Nodes are kept in depth-first pre-order in typed arrays, so a 50 MB JSON
// file (≈2 M nodes) costs ~70 MB instead of the ~500 MB a JS object tree would. Children of node i are the nodes
// i+1 … last[i], walked with c = last[c] + 1. JSON keys and values are decoded lazily from the source text; other
// formats store their key/value strings in side arrays.
import { Kind, KeyKind } from './protocol';

export type Seg = string | number;
export type Path = Seg[];

export interface Meta {
  tag?: string;
  anchor?: string;
  /** YAML alias: target node id */
  alias?: number;
  comment?: string;
  /** node cannot be edited in place */
  ro?: boolean;
  /** XML: element name for leaf elements etc. */
  flavor?: string;
  /** YAML scalar style, TOML/INI quoting, … */
  style?: string;
  /** INI: 1-based source line */
  line?: number;
}

export class Store {
  n = 0;
  kind!: Uint8Array;
  kk!: Uint8Array;
  depth!: Uint16Array;
  parent!: Int32Array;
  last!: Int32Array;
  count!: Int32Array;
  pos!: Int32Array;
  vs!: Int32Array;
  ve!: Int32Array;
  ks!: Int32Array;
  ke!: Int32Array;
  /** explicit key text (non-JSON formats) */
  keys?: (string | undefined)[];
  /** explicit primitive value text (non-JSON formats) */
  vals?: (string | undefined)[];
  meta = new Map<number, Meta>();

  constructor(public src: string) {}

  firstChild(i: number): number {
    return this.count[i] > 0 ? i + 1 : -1;
  }

  nextSibling(c: number): number {
    const p = this.parent[c];
    const nx = this.last[c] + 1;
    return p >= 0 && nx <= this.last[p] ? nx : -1;
  }

  children(i: number): number[] {
    const out: number[] = [];
    for (let c = this.firstChild(i); c >= 0; c = this.nextSibling(c)) out.push(c);
    return out;
  }

  /** The k-th child (k < count). Linear in k but only hops over siblings. */
  child(i: number, k: number): number {
    let c = this.firstChild(i);
    while (c >= 0 && k-- > 0) c = this.nextSibling(c);
    return c;
  }

  isContainer(i: number): boolean {
    return this.kind[i] === Kind.Obj || this.kind[i] === Kind.Arr;
  }

  /** Key as shown: property name, array position, or undefined at the root. */
  key(i: number): string | number | undefined {
    const kk = this.kk[i];
    if (kk === KeyKind.Index || kk === KeyKind.Doc) return this.pos[i];
    if (kk === KeyKind.None) return undefined;
    const k = this.keys?.[i];
    if (k !== undefined) return k;
    return this.ks[i] >= 0 ? decodeJsonString(this.src, this.ks[i], this.ke[i]) : undefined;
  }

  /** Key as a path segment: string for named members, number for positions. */
  seg(i: number): Seg {
    const k = this.key(i);
    return k === undefined ? '' : k;
  }

  /** Primitive value text: decoded string for strings, source text for numbers etc. */
  text(i: number, max = Infinity): string {
    const v = this.vals?.[i];
    if (v !== undefined) return v.length > max ? v.slice(0, max) : v;
    switch (this.kind[i]) {
      case Kind.Str:
        return decodeJsonString(this.src, this.vs[i], this.ve[i], max);
      case Kind.True:
        return 'true';
      case Kind.False:
        return 'false';
      case Kind.Null:
        return 'null';
      default: {
        const s = this.vs[i] >= 0 ? this.src.slice(this.vs[i], Math.min(this.ve[i], this.vs[i] + (max === Infinity ? this.ve[i] : max))) : '';
        return s;
      }
    }
  }

  /** Length of the primitive value text without decoding a huge string just to measure it. */
  textLength(i: number): number {
    const v = this.vals?.[i];
    if (v !== undefined) return v.length;
    if (this.kind[i] === Kind.Str) {
      const raw = this.ve[i] - this.vs[i] - 2;
      if (raw < 4096) return decodeJsonString(this.src, this.vs[i], this.ve[i]).length;
      return raw; // close enough for huge strings (escapes make it a little shorter)
    }
    return this.text(i).length;
  }

  path(i: number): Path {
    const out: Path = [];
    for (let c = i; c > 0 && this.parent[c] >= 0; c = this.parent[c]) out.push(this.seg(c));
    return out.reverse();
  }

  ancestors(i: number): number[] {
    const out: number[] = [];
    for (let c = this.parent[i]; c >= 0; c = this.parent[c]) out.push(c);
    return out.reverse();
  }

  /** Resolve a path back to a node id (first match for duplicate keys), or -1. */
  find(path: Path): number {
    if (!this.n) return -1;
    let cur = 0;
    for (const seg of path) {
      const fk = this.kk[this.firstChild(cur)];
      if (typeof seg === 'number' && (fk === KeyKind.Index || fk === KeyKind.Doc)) {
        if (seg >= this.count[cur]) return -1;
        cur = this.child(cur, seg);
      } else {
        let found = -1;
        for (let c = this.firstChild(cur); c >= 0; c = this.nextSibling(c)) {
          if (this.seg(c) === seg) {
            found = c;
            break;
          }
        }
        if (found < 0) return -1;
        cur = found;
      }
      if (cur < 0) return -1;
    }
    return cur;
  }

  /** JS value of a subtree (for copying and converting). */
  toValue(i: number, maxNodes = 5_000_000): unknown {
    let budget = maxNodes;
    const rec = (j: number): unknown => {
      if (--budget < 0) throw new Error('too large');
      const k = this.kind[j];
      if (k === Kind.Obj) {
        const o: Record<string, unknown> = {};
        const rep = new Set<string>();
        for (let c = this.firstChild(j); c >= 0; c = this.nextSibling(c)) {
          let key = String(this.key(c) ?? '');
          if (this.kk[c] === KeyKind.Attr) key = '@' + key;
          const v = rec(c);
          if (key in o && (this.kk[c] === KeyKind.Elem || this.kk[c] === KeyKind.Text)) {
            // repeated XML element names (and text runs) become arrays
            if (!rep.has(key)) {
              o[key] = [o[key]];
              rep.add(key);
            }
            (o[key] as unknown[]).push(v);
          } else o[key] = v;
        }
        return o;
      }
      if (k === Kind.Arr) {
        const a: unknown[] = [];
        for (let c = this.firstChild(j); c >= 0; c = this.nextSibling(c)) a.push(rec(c));
        return a;
      }
      return this.primitive(j);
    };
    return rec(i);
  }

  primitive(i: number): unknown {
    switch (this.kind[i]) {
      case Kind.Str:
      case Kind.Date:
      case Kind.Comment:
        return this.text(i);
      case Kind.Num: {
        const t = this.text(i);
        const n = Number(t.replace(/_/g, ''));
        return Number.isFinite(n) && !/^0[xob]/i.test(t) ? n : /^[-+]?(inf|\.inf)$/i.test(t) ? (t.startsWith('-') ? -Infinity : Infinity) : Number.isNaN(n) && /nan/i.test(t) ? NaN : n;
      }
      case Kind.True:
        return true;
      case Kind.False:
        return false;
      case Kind.Null:
        return null;
      case Kind.Alias:
        return '*' + this.text(i);
      default:
        return this.text(i);
    }
  }
}

/** Decode the JSON string token src[s, e) (quotes included). Invalid escapes fall back to the raw text. */
export function decodeJsonString(src: string, s: number, e: number, max = Infinity): string {
  if (s < 0) return '';
  let a = s + 1;
  let b = e - 1;
  if (src.charCodeAt(s) !== 34) {
    a = s;
    b = e;
  } else if (src.charCodeAt(e - 1) !== 34 || e - s < 2) b = e;
  let truncated = false;
  // an escape is at most 6 source characters for one decoded character
  if (max !== Infinity && b - a > max * 6 + 16) {
    b = a + max * 6 + 8;
    truncated = true;
  }
  const bs = src.indexOf('\\', a);
  let out: string;
  if (bs < 0 || bs >= b) out = src.slice(a, b);
  else {
    let raw = src.slice(a, b);
    if (truncated) {
      // don't cut an escape sequence in half
      const cut = raw.lastIndexOf('\\');
      if (cut >= raw.length - 6) raw = raw.slice(0, cut);
      // an odd run of backslashes at the end would escape the closing quote
      let k = raw.length;
      while (k > 0 && raw.charCodeAt(k - 1) === 92) k--;
      if ((raw.length - k) % 2) raw = raw.slice(0, -1);
    }
    try {
      out = JSON.parse('"' + raw.replace(/[\u0000-\u001f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"') as string;
    } catch {
      out = raw;
    }
  }
  return out.length > max ? out.slice(0, max) : out;
}

/** Growable builder for a Store. */
export class Builder {
  private cap: number;
  readonly st: Store;
  private stack: number[] = [];
  private explicit: boolean;

  constructor(src: string, estimate: number, explicit = false) {
    this.st = new Store(src);
    this.explicit = explicit;
    this.cap = Math.max(64, estimate | 0);
    const st = this.st;
    st.kind = new Uint8Array(this.cap);
    st.kk = new Uint8Array(this.cap);
    st.depth = new Uint16Array(this.cap);
    st.parent = new Int32Array(this.cap);
    st.last = new Int32Array(this.cap);
    st.count = new Int32Array(this.cap);
    st.pos = new Int32Array(this.cap);
    st.vs = new Int32Array(this.cap);
    st.ve = new Int32Array(this.cap);
    st.ks = new Int32Array(this.cap);
    st.ke = new Int32Array(this.cap);
    if (explicit) {
      st.keys = [];
      st.vals = [];
    }
  }

  get depth(): number {
    return this.stack.length;
  }

  /** Id of the innermost open container, or -1. */
  get top(): number {
    return this.stack.length ? this.stack[this.stack.length - 1] : -1;
  }

  private grow(): void {
    const cap = Math.ceil(this.cap * 1.6) + 64;
    const st = this.st;
    const g = <T extends Uint8Array | Uint16Array | Int32Array>(a: T): T => {
      const b = new (a.constructor as { new (n: number): T })(cap);
      b.set(a);
      return b;
    };
    st.kind = g(st.kind);
    st.kk = g(st.kk);
    st.depth = g(st.depth);
    st.parent = g(st.parent);
    st.last = g(st.last);
    st.count = g(st.count);
    st.pos = g(st.pos);
    st.vs = g(st.vs);
    st.ve = g(st.ve);
    st.ks = g(st.ks);
    st.ke = g(st.ke);
    this.cap = cap;
  }

  private add(kind: Kind, kk: KeyKind, ks: number, ke: number, vs: number, ve: number, key?: string, val?: string): number {
    const st = this.st;
    if (st.n >= this.cap) this.grow();
    const i = st.n++;
    const p = this.top;
    st.kind[i] = kind;
    st.kk[i] = kk;
    st.depth[i] = this.stack.length;
    st.parent[i] = p;
    st.last[i] = i;
    st.count[i] = 0;
    st.pos[i] = p >= 0 ? st.count[p]++ : 0;
    st.vs[i] = vs;
    st.ve[i] = ve;
    st.ks[i] = ks;
    st.ke[i] = ke;
    if (this.explicit) {
      if (key !== undefined) st.keys![i] = key;
      if (val !== undefined) st.vals![i] = val;
    }
    return i;
  }

  open(kind: Kind.Obj | Kind.Arr, kk: KeyKind, ks: number, ke: number, vs: number, key?: string): number {
    const i = this.add(kind, kk, ks, ke, vs, -1, key);
    this.stack.push(i);
    return i;
  }

  close(ve: number): number {
    const i = this.stack.pop()!;
    const st = this.st;
    st.ve[i] = ve;
    st.last[i] = st.n - 1;
    return i;
  }

  leaf(kind: Kind, kk: KeyKind, ks: number, ke: number, vs: number, ve: number, key?: string, val?: string): number {
    return this.add(kind, kk, ks, ke, vs, ve, key, val);
  }

  /** Close everything still open (error recovery) at offset `ve`. */
  closeAll(ve: number): void {
    while (this.stack.length) this.close(ve);
  }

  setMeta(i: number, m: Meta): void {
    const cur = this.st.meta.get(i);
    this.st.meta.set(i, cur ? { ...cur, ...m } : m);
  }

  finish(): Store {
    this.closeAll(this.st.src.length);
    const st = this.st;
    const n = st.n;
    // Copy into right-sized arrays only when the estimate was far too generous; otherwise views (no copy).
    const trim = this.cap > n * 1.5 + 1024;
    const fit = <T extends Uint8Array | Uint16Array | Int32Array>(a: T): T => (trim ? (a.slice(0, n) as T) : (a.subarray(0, n) as T));
    st.kind = fit(st.kind);
    st.kk = fit(st.kk);
    st.depth = fit(st.depth);
    st.parent = fit(st.parent);
    st.last = fit(st.last);
    st.count = fit(st.count);
    st.pos = fit(st.pos);
    st.vs = fit(st.vs);
    st.ve = fit(st.ve);
    st.ks = fit(st.ks);
    st.ke = fit(st.ke);
    return st;
  }
}

/** Offset → 1-based line/column, with a cached line-start index. */
export class LineIndex {
  private starts: Int32Array;
  constructor(text: string) {
    let n = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
    this.starts = new Int32Array(n);
    let k = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.starts[k++] = i + 1;
  }
  get lines(): number {
    return this.starts.length;
  }
  pos(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo] + 1 };
  }
  offset(line: number, col = 1): number {
    const l = Math.max(1, Math.min(line, this.starts.length));
    return this.starts[l - 1] + col - 1;
  }
  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))];
  }
}

/** Single replacement that turns `a` into `b` (common prefix/suffix trimmed). */
export function minimalEdit(a: string, b: string): TextEdit | undefined {
  if (a === b) return undefined;
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Apply offset edits (any order, non-overlapping) to a string. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((x, y) => y.start - x.start || y.end - x.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Indentation (spaces/tabs) of the line containing `offset`. */
export function lineIndent(text: string, offset: number): string {
  const ls = text.lastIndexOf('\n', offset - 1) + 1;
  let e = ls;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(ls, e);
}

export function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** Offset just past the end of the line containing `offset` (after its newline). */
export function lineEndAfter(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl < 0 ? text.length : nl + 1;
}

export function detectEol(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}
