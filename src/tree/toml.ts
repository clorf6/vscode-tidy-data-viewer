// TOML: values come from smol-toml (authoritative); a small structural scanner locates every key and value in the
// source so primitive values can be edited by precise replacement. A location is only trusted when re-parsing the
// located text yields the same value — anything else stays read-only.
import * as T from 'smol-toml';
import { Builder, Store, TextEdit, lineIndent, lineStartOf } from './model';
import { EditError, ValueType } from './json';
import { Kind, KeyKind } from './protocol';

export interface TomlError {
  offset: number;
  line: number;
  col: number;
  message: string;
}

/** What a node is in the source, for edits. */
export interface TInfo {
  /** kv: `key = value` statement; header: `[table]`; aot: one `[[table]]`; elem: array element; member: inline table member */
  role: 'kv' | 'header' | 'aot' | 'elem' | 'member' | 'implicit' | 'root';
  /** statement range (kv: line start … after newline; header: header line … end of its section) */
  s?: number;
  e?: number;
  /** where a new `key = value` line for this table goes */
  insertAt?: number;
  /** indentation used by the table's statements */
  indent?: string;
  /** key written as part of a dotted key (not renameable on its own) */
  dotted?: boolean;
  style?: string;
}

export interface TomlResult {
  store: Store;
  errors: TomlError[];
  info: (TInfo | undefined)[];
}

// ---------------------------------------------------------------------------------------------------------------
// Scanner

interface SNode {
  kind: 'table' | 'array' | 'value';
  role: TInfo['role'];
  keys: Map<string, SNode>;
  items: SNode[];
  ks: number;
  ke: number;
  vs: number;
  ve: number;
  s?: number;
  e?: number;
  insertAt?: number;
  dotted?: boolean;
  /** array of tables */
  aot?: boolean;
}

const mk = (kind: SNode['kind'], role: SNode['role']): SNode => ({ kind, role, keys: new Map(), items: [], ks: -1, ke: -1, vs: -1, ve: -1 });

class ScanError extends Error {}

class Scanner {
  p = 0;
  constructor(readonly t: string) {}

  ws(): void {
    const t = this.t;
    while (this.p < t.length && (t[this.p] === ' ' || t[this.p] === '\t')) this.p++;
  }

  /** whitespace, newlines and comments */
  wsnl(): void {
    const t = this.t;
    for (;;) {
      while (this.p < t.length && /[ \t\r\n]/.test(t[this.p])) this.p++;
      if (t[this.p] === '#') {
        const nl = t.indexOf('\n', this.p);
        this.p = nl < 0 ? t.length : nl;
      } else return;
    }
  }

  /** rest of line must be blank or a comment */
  eol(): void {
    this.ws();
    const t = this.t;
    if (t[this.p] === '#') {
      const nl = t.indexOf('\n', this.p);
      this.p = nl < 0 ? t.length : nl;
    }
    if (t[this.p] === '\r') this.p++;
    if (this.p < t.length && t[this.p] !== '\n') throw new ScanError('expected end of line');
    if (this.p < t.length) this.p++;
  }

  /** one key segment: returns [text, start, end] */
  keySeg(): [string, number, number] {
    const t = this.t;
    const s = this.p;
    if (t[s] === '"') {
      const e = this.basicEnd(s);
      this.p = e;
      return [Object.keys(T.parse(t.slice(s, e) + ' = 0'))[0], s, e];
    }
    if (t[s] === "'") {
      const e = t.indexOf("'", s + 1);
      if (e < 0) throw new ScanError('unterminated key');
      this.p = e + 1;
      return [t.slice(s + 1, e), s, e + 1];
    }
    let e = s;
    while (e < t.length && /[A-Za-z0-9_-]/.test(t[e])) e++;
    if (e === s) throw new ScanError('expected key');
    this.p = e;
    return [t.slice(s, e), s, e];
  }

  key(): [string, number, number][] {
    const segs = [this.keySeg()];
    for (;;) {
      const save = this.p;
      this.ws();
      if (this.t[this.p] === '.') {
        this.p++;
        this.ws();
        segs.push(this.keySeg());
      } else {
        this.p = save;
        return segs;
      }
    }
  }

  basicEnd(s: number): number {
    const t = this.t;
    let q = s + 1;
    while (q < t.length) {
      const c = t[q];
      if (c === '\\') q += 2;
      else if (c === '"') return q + 1;
      else if (c === '\n') break;
      else q++;
    }
    throw new ScanError('unterminated string');
  }

  mlEnd(s: number, q: string): number {
    const t = this.t;
    let k = s + 3;
    for (;;) {
      const i = t.indexOf(q + q + q, k);
      if (i < 0) throw new ScanError('unterminated string');
      if (q === '"') {
        let bs = 0;
        for (let j = i - 1; j >= 0 && t[j] === '\\'; j--) bs++;
        if (bs % 2) {
          k = i + 1;
          continue;
        }
      }
      let e = i + 3;
      while (t[e] === q && e < i + 5) e++;
      return e;
    }
  }

  value(): SNode {
    const t = this.t;
    const s = this.p;
    const c = t[s];
    if (c === '"' || c === "'") {
      const n = mk('value', 'kv');
      let e: number;
      if (t.startsWith(c + c + c, s)) e = this.mlEnd(s, c);
      else if (c === '"') e = this.basicEnd(s);
      else {
        e = t.indexOf("'", s + 1);
        if (e < 0 || t.slice(s, e).includes('\n')) throw new ScanError('unterminated string');
        e++;
      }
      n.vs = s;
      n.ve = e;
      this.p = e;
      return n;
    }
    if (c === '[') {
      const n = mk('array', 'kv');
      n.vs = s;
      this.p++;
      for (;;) {
        this.wsnl();
        if (t[this.p] === ']') {
          this.p++;
          break;
        }
        const v = this.value();
        v.role = 'elem';
        n.items.push(v);
        this.wsnl();
        if (t[this.p] === ',') this.p++;
        else if (t[this.p] === ']') {
          this.p++;
          break;
        } else throw new ScanError('expected , or ]');
      }
      n.ve = this.p;
      return n;
    }
    if (c === '{') {
      const n = mk('table', 'kv');
      n.vs = s;
      this.p++;
      for (;;) {
        this.wsnl();
        if (t[this.p] === '}') {
          this.p++;
          break;
        }
        const segs = this.key();
        this.ws();
        if (t[this.p] !== '=') throw new ScanError('expected =');
        this.p++;
        this.ws();
        const v = this.value();
        v.role = 'member';
        place(n, segs, v);
        this.wsnl();
        if (t[this.p] === ',') this.p++;
        else if (t[this.p] === '}') {
          this.p++;
          break;
        } else throw new ScanError('expected , or }');
      }
      n.ve = this.p;
      return n;
    }
    // scalar token
    let e = s;
    while (e < t.length && !/[\s,\]}#]/.test(t[e])) e++;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.slice(s, e)) && t[e] === ' ' && /^\d{2}:/.test(t.slice(e + 1, e + 4))) {
      e++;
      while (e < t.length && !/[\s,\]}#]/.test(t[e])) e++;
    }
    if (e === s) throw new ScanError('expected value');
    const n = mk('value', 'kv');
    n.vs = s;
    n.ve = e;
    this.p = e;
    return n;
  }
}

/** Put value `v` at dotted key `segs` under table `into` (creating implicit tables). */
function place(into: SNode, segs: [string, number, number][], v: SNode): void {
  let cur = into;
  for (let k = 0; k < segs.length - 1; k++) {
    const [name, ks, ke] = segs[k];
    let nx = cur.keys.get(name);
    if (!nx) {
      nx = mk('table', 'implicit');
      nx.ks = ks;
      nx.ke = ke;
      nx.dotted = true;
      cur.keys.set(name, nx);
    } else if (nx.kind === 'array' && nx.aot) nx = nx.items[nx.items.length - 1];
    cur = nx;
  }
  const [name, ks, ke] = segs[segs.length - 1];
  v.ks = ks;
  v.ke = ke;
  if (segs.length > 1) v.dotted = true;
  cur.keys.set(name, v);
}

function scanToml(text: string): SNode {
  const sc = new Scanner(text);
  const root = mk('table', 'root');
  root.insertAt = 0;
  let cur = root;
  let curHeader: SNode | undefined;
  const closeSection = (at: number) => {
    if (curHeader) curHeader.e = at;
  };
  let lastStmtEnd = 0;
  let sawStmt = false;
  for (;;) {
    sc.wsnl();
    if (sc.p >= text.length) break;
    const t = text;
    const ls = lineStartOf(t, sc.p);
    if (t[sc.p] === '[') {
      const aot = t[sc.p + 1] === '[';
      if (!sawStmt && cur === root) root.insertAt = ls;
      closeSection(ls);
      sc.p += aot ? 2 : 1;
      sc.ws();
      const segs = sc.key();
      sc.ws();
      if (aot ? !t.startsWith(']]', sc.p) : t[sc.p] !== ']') throw new ScanError('expected ]');
      sc.p += aot ? 2 : 1;
      sc.eol();
      // navigate
      let node = root;
      for (let k = 0; k < segs.length; k++) {
        const [name, ks, ke] = segs[k];
        const lastSeg = k === segs.length - 1;
        let nx = node.keys.get(name);
        if (lastSeg && aot) {
          if (!nx) {
            nx = mk('array', 'implicit');
            nx.aot = true;
            nx.ks = ks;
            nx.ke = ke;
            node.keys.set(name, nx);
          }
          const item = mk('table', 'aot');
          item.ks = ks;
          item.ke = ke;
          nx.items.push(item);
          node = item;
          break;
        }
        if (!nx) {
          nx = mk('table', lastSeg ? 'header' : 'implicit');
          nx.ks = ks;
          nx.ke = ke;
          node.keys.set(name, nx);
        } else if (nx.kind === 'array' && nx.aot) nx = nx.items[nx.items.length - 1];
        else if (lastSeg) nx.role = 'header';
        node = nx;
      }
      node.s = ls;
      node.insertAt = sc.p;
      cur = node;
      curHeader = node;
      lastStmtEnd = sc.p;
      continue;
    }
    const segs = sc.key();
    sc.ws();
    if (t[sc.p] !== '=') throw new ScanError('expected =');
    sc.p++;
    sc.ws();
    const v = sc.value();
    sc.eol();
    v.s = ls;
    v.e = sc.p;
    place(cur, segs, v);
    sawStmt = true;
    lastStmtEnd = sc.p;
    cur.insertAt = lastStmtEnd;
  }
  closeSection(text.length);
  void lastStmtEnd;
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// Build the store

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.toISOString() === b.toISOString();
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return a === b;
}

function verify(text: string, n: SNode, v: unknown): boolean {
  try {
    const got = (T.parse('x = ' + text.slice(n.vs, n.ve)) as { x: unknown }).x;
    return same(got, v);
  } catch {
    return false;
  }
}

export function parseToml(text: string): TomlResult {
  let data: Record<string, unknown>;
  try {
    data = T.parse(text) as Record<string, unknown>;
  } catch (err) {
    const e = err as T.TomlError;
    const line = e.line ?? 1;
    const col = e.column ?? 1;
    let off = 0;
    for (let l = 1; l < line; l++) off = text.indexOf('\n', off) + 1;
    return { store: new Builder(text, 1, true).finish(), errors: [{ offset: off + col - 1, line, col, message: String(e.message).split('\n')[0].replace(/^Invalid TOML document:\s*/, '') }], info: [] };
  }
  let scan: SNode | undefined;
  try {
    scan = scanToml(text);
  } catch {
    scan = undefined;
  }
  const b = new Builder(text, 256, true);
  const info: (TInfo | undefined)[] = [];

  const emit = (v: unknown, s: SNode | undefined, kk: KeyKind, key: string | undefined) => {
    const ks = s ? s.ks : -1;
    const ke = s ? s.ke : -1;
    if (Array.isArray(v)) {
      const id = b.open(Kind.Arr, kk, ks, ke, s && !s.aot ? s.vs : -1, key);
      info[id] = s ? { role: s.aot ? 'implicit' : s.role, s: s.s, e: s.e } : undefined;
      if (s?.aot) b.setMeta(id, { flavor: 'aot' });
      v.forEach((x, k) => emit(x, s && s.kind === 'array' ? s.items[k] : undefined, KeyKind.Index, undefined));
      b.close(s && !s.aot ? s.ve : -1);
      return;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const id = b.open(Kind.Obj, kk, ks, ke, s?.vs ?? -1, key);
      info[id] = s ? { role: s.role, s: s.s, e: s.e, insertAt: s.insertAt, dotted: s.dotted, indent: undefined } : undefined;
      if (s?.role === 'header' || s?.role === 'aot') b.setMeta(id, { flavor: 'table' });
      if (s && s.vs >= 0) b.setMeta(id, { flavor: 'inline' });
      const obj = v as Record<string, unknown>;
      const order = s && s.kind === 'table' ? [...s.keys.keys()].filter((k) => k in obj) : [];
      for (const k of Object.keys(obj)) if (!order.includes(k)) order.push(k);
      for (const k of order) emit(obj[k], s?.kind === 'table' ? s.keys.get(k) : undefined, KeyKind.Prop, k);
      b.close(s?.ve ?? -1);
      return;
    }
    let kind: Kind;
    let val: string;
    if (v instanceof Date) {
      kind = Kind.Date;
      val = s && s.vs >= 0 ? text.slice(s.vs, s.ve) : (v as T.TomlDate).toISOString();
    } else if (typeof v === 'boolean') {
      kind = v ? Kind.True : Kind.False;
      val = String(v);
    } else if (typeof v === 'number' || typeof v === 'bigint') {
      kind = Kind.Num;
      val = s && s.vs >= 0 ? text.slice(s.vs, s.ve) : String(v);
    } else {
      kind = Kind.Str;
      val = String(v);
    }
    const ok = !!s && s.kind === 'value' && s.vs >= 0 && verify(text, s, v);
    const id = b.leaf(kind, kk, ok ? ks : -1, ok ? ke : -1, ok ? s!.vs : -1, ok ? s!.ve : -1, key, val);
    if (ok) {
      const raw = text.slice(s!.vs, s!.vs + 3);
      const style = raw.startsWith('"""') ? 'ml-basic' : raw.startsWith("'''") ? 'ml-literal' : raw[0] === '"' ? 'basic' : raw[0] === "'" ? 'literal' : undefined;
      info[id] = { role: s!.role, s: s!.s, e: s!.e, dotted: s!.dotted, style };
    } else b.setMeta(id, { ro: true });
  };
  emit(data, scan, KeyKind.None, undefined);
  const store = b.finish();
  if (scan) info[0] = { role: 'root', insertAt: scan.insertAt };
  return { store, errors: [], info };
}

// ---------------------------------------------------------------------------------------------------------------
// Edits

const TNUM_RE = /^[-+]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan|(0|[1-9][0-9_]*)(\.[0-9_]+)?([eE][-+]?[0-9_]+)?)$/;

export function tomlScalar(value: string, type: ValueType, style?: string): string {
  switch (type) {
    case 'string':
      if ((style === 'literal' || style === 'ml-literal') && !/['\n\r]/.test(value)) return "'" + value + "'";
      return JSON.stringify(value).replace(/\\u007f/g, '\\u007F');
    case 'number': {
      const v = value.trim();
      if (!TNUM_RE.test(v)) throw new EditError('Not a valid number');
      return v;
    }
    case 'boolean': {
      const v = value.trim().toLowerCase();
      if (v !== 'true' && v !== 'false') throw new EditError('Expected true or false');
      return v;
    }
    case 'null':
      throw new EditError('TOML has no null');
    case 'object':
      return '{}';
    case 'array':
      return '[]';
  }
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

export type TomlOp =
  | { op: 'set'; id: number; value: string; type: ValueType }
  | { op: 'rename'; id: number; key: string }
  | { op: 'delete'; id: number }
  | { op: 'add'; id: number; key?: string; value: string; type: ValueType; after?: number }
  | { op: 'duplicate'; id: number }
  | { op: 'move'; id: number; dir: -1 | 1 };

const SOURCE = 'Edit the source to change this TOML structure';

function prevSibling(st: Store, i: number): number {
  const p = st.parent[i];
  let prev = -1;
  for (let c = st.firstChild(p); c >= 0 && c !== i; c = st.nextSibling(c)) prev = c;
  return prev;
}

export function tomlEdit(r: TomlResult, e: TomlOp, eol: string): TextEdit[] {
  const st = r.store;
  const src = st.src;
  const i = e.id;
  const inf = r.info[i];
  if (i < 0 || i >= st.n) throw new EditError('Node not found');
  const p = st.parent[i];
  switch (e.op) {
    case 'set': {
      if (st.vs[i] < 0 || !inf || st.isContainer(i)) throw new EditError(SOURCE);
      let text: string;
      if (st.kind[i] === Kind.Date && e.type === 'string') {
        try {
          T.parse('x = ' + e.value.trim());
          text = e.value.trim();
        } catch {
          text = tomlScalar(e.value, 'string', inf.style);
        }
      } else text = tomlScalar(e.value, e.type, inf.style);
      return [{ start: st.vs[i], end: st.ve[i], text }];
    }
    case 'rename': {
      if (!inf || inf.dotted || (inf.role !== 'kv' && inf.role !== 'member') || st.ks[i] < 0) throw new EditError(SOURCE);
      return [{ start: st.ks[i], end: st.ke[i], text: tomlKey(e.key) }];
    }
    case 'delete': {
      if (!inf || inf.dotted) throw new EditError(SOURCE);
      if (inf.role === 'kv' && inf.s !== undefined && inf.e !== undefined) return [{ start: inf.s, end: inf.e, text: '' }];
      if (inf.role === 'elem' || inf.role === 'member') {
        const s = st.ks[i] >= 0 ? st.ks[i] : st.vs[i];
        const next = st.nextSibling(i);
        if (next >= 0) {
          let k = st.ve[i];
          while (k < src.length && /\s/.test(src[k])) k++;
          if (src[k] === ',') k++;
          while (k < src.length && /\s/.test(src[k])) k++;
          return [{ start: s, end: k, text: '' }];
        }
        const prev = prevSibling(st, i);
        if (prev >= 0) return [{ start: st.ve[prev], end: st.ve[i], text: '' }];
        return [{ start: st.vs[p] + 1, end: st.ve[p] - 1, text: '' }];
      }
      throw new EditError(SOURCE);
    }
    case 'add': {
      if (!st.isContainer(i)) throw new EditError('Can only add to a table or array');
      if (e.type === 'null') throw new EditError('TOML has no null');
      const val = tomlScalar(e.value, e.type);
      if (st.kind[i] === Kind.Arr) {
        if (!inf || st.vs[i] < 0) throw new EditError(SOURCE);
        if (st.count[i] === 0) return [{ start: st.vs[i] + 1, end: st.ve[i] - 1, text: val }];
        const last = st.children(i).pop()!;
        return [{ start: st.ve[last], end: st.ve[last], text: ', ' + val }];
      }
      if (!e.key) throw new EditError('A key is required');
      if (inf?.role !== 'header' && inf?.role !== 'aot' && inf?.role !== 'root' && !(st.vs[i] >= 0)) throw new EditError(SOURCE);
      if (st.vs[i] >= 0) {
        // inline table
        const member = tomlKey(e.key) + ' = ' + val;
        if (st.count[i] === 0) return [{ start: st.vs[i] + 1, end: st.ve[i] - 1, text: ' ' + member + ' ' }];
        const last = st.children(i).pop()!;
        return [{ start: st.ve[last], end: st.ve[last], text: ', ' + member }];
      }
      const at = inf?.insertAt ?? 0;
      // align with the table's existing statements
      let ind = '';
      for (let c = st.firstChild(i); c >= 0; c = st.nextSibling(c)) {
        const ci = r.info[c];
        if (ci?.role === 'kv' && ci.s !== undefined) {
          ind = lineIndent(src, ci.s);
          break;
        }
      }
      const line = ind + tomlKey(e.key) + ' = ' + val + eol;
      if (at > 0 && src[at - 1] !== '\n') return [{ start: at, end: at, text: eol + line.replace(/\r?\n$/, '') }];
      return [{ start: at, end: at, text: line }];
    }
    case 'duplicate': {
      if (!inf || inf.dotted) throw new EditError(SOURCE);
      if (inf.role === 'kv' && inf.s !== undefined && inf.e !== undefined) {
        const taken = new Set(st.children(p).map((c) => String(st.key(c))));
        let k = String(st.key(i)) + '_copy';
        for (let n = 2; taken.has(k); n++) k = String(st.key(i)) + '_copy' + n;
        let copy = src.slice(inf.s, inf.e);
        copy = copy.slice(0, st.ks[i] - inf.s) + tomlKey(k) + copy.slice(st.ke[i] - inf.s);
        if (!copy.endsWith('\n')) copy = eol + copy;
        return [{ start: inf.e, end: inf.e, text: copy }];
      }
      if (inf.role === 'elem') return [{ start: st.ve[i], end: st.ve[i], text: ', ' + src.slice(st.vs[i], st.ve[i]) }];
      throw new EditError(SOURCE);
    }
    case 'move': {
      const j = e.dir < 0 ? prevSibling(st, i) : st.nextSibling(i);
      if (j < 0) throw new EditError('Nothing to swap with');
      const a = e.dir < 0 ? j : i;
      const bb = e.dir < 0 ? i : j;
      const ia = r.info[a];
      const ib = r.info[bb];
      if (ia?.role === 'elem' && ib?.role === 'elem') {
        const ta = src.slice(st.vs[a], st.ve[a]);
        const tb = src.slice(st.vs[bb], st.ve[bb]);
        return [{ start: st.vs[a], end: st.ve[bb], text: tb + src.slice(st.ve[a], st.vs[bb]) + ta }];
      }
      if (ia?.role === 'kv' && ib?.role === 'kv' && !ia.dotted && !ib.dotted && ia.s !== undefined && ib.s !== undefined && ia.e !== undefined && ib.e !== undefined && ia.e <= ib.s) {
        let ta = src.slice(ia.s, ia.e);
        let tb = src.slice(ib.s, ib.e);
        if (!tb.endsWith('\n')) {
          tb += eol;
          ta = ta.replace(/\r?\n$/, '');
        }
        return [{ start: ia.s, end: ib.e, text: tb + src.slice(ia.e, ib.s) + ta }];
      }
      throw new EditError(SOURCE);
    }
  }
}
