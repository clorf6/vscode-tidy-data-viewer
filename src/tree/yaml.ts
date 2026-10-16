// YAML: multi-document streams, anchors/aliases, tags and comments. Value edits are surgical replacements of the
// scalar's source range; structural edits work on whole lines of block collections (or like JSON inside flow
// collections), so comments and formatting elsewhere stay byte-for-byte. Odd layouts fall back to the yaml Document
// API with the change reduced to a minimal replacement.
import * as Y from 'yaml';
import { Builder, Store, TextEdit, lineIndent, lineStartOf, minimalEdit } from './model';
import { EditError, ValueType, naturalCompare } from './json';
import { Kind, KeyKind } from './protocol';

export interface YamlError {
  offset: number;
  length: number;
  message: string;
  code: string;
  warning?: boolean;
}

export interface YamlResult {
  store: Store;
  errors: YamlError[];
  docs: Y.Document.Parsed[];
  /** value node per store id */
  nodes: unknown[];
  /** pair per store id (members of maps) */
  pairs: (Y.Pair | undefined)[];
  /** owning document index per store id */
  docOf: Int32Array;
  multi: boolean;
}

const SHORT_TAG = 'tag:yaml.org,2002:';

function cleanMessage(m: string): string {
  return m.split('\n')[0].replace(/\s+at line \d+, column \d+:?\s*$/, '').trim();
}

export function parseYaml(text: string): YamlResult {
  const docs = Y.parseAllDocuments(text, { prettyErrors: false, uniqueKeys: true, strict: false }) as Y.Document.Parsed[] | Y.EmptyStream;
  const list: Y.Document.Parsed[] = Array.isArray(docs) ? docs : [];
  const b = new Builder(text, 256, true);
  const nodes: unknown[] = [];
  const pairs: (Y.Pair | undefined)[] = [];
  const docOf: number[] = [];
  const anchors = new Map<string, number>();
  const errors: YamlError[] = [];
  let curDoc = 0;

  const add = (node: unknown, kk: KeyKind, pair: Y.Pair | undefined, key: string | undefined) => {
    const ks = pair && Y.isNode(pair.key) && pair.key.range ? pair.key.range[0] : -1;
    const ke = pair && Y.isNode(pair.key) && pair.key.range ? pair.key.range[1] : -1;
    let id: number;
    const r = Y.isNode(node) && node.range ? node.range : undefined;
    const vs = r ? r[0] : -1;
    const ve = r ? r[1] : -1;
    if (Y.isMap(node) || Y.isSeq(node)) {
      id = b.open(Y.isMap(node) ? Kind.Obj : Kind.Arr, kk, ks, ke, vs, key);
      nodes[id] = node;
      pairs[id] = pair;
      docOf[id] = curDoc;
      meta(id, node);
      if (Y.isMap(node)) {
        for (const p of node.items as Y.Pair[]) {
          const k = p.key;
          let ktext: string;
          if (k === null || k === undefined) ktext = '';
          else if (Y.isScalar(k)) ktext = k.value === null ? '' : String(k.value);
          else if (Y.isAlias(k)) ktext = '*' + k.source;
          else ktext = String(k);
          add(p.value, KeyKind.Prop, p, ktext);
        }
      } else for (const it of node.items) add(it, KeyKind.Index, undefined, undefined);
      b.close(ve);
      return;
    }
    if (Y.isAlias(node)) {
      id = b.leaf(Kind.Alias, kk, ks, ke, vs, ve, key, node.source);
      const target = anchors.get(node.source);
      b.setMeta(id, { alias: target ?? -1, ro: true });
    } else if (Y.isScalar(node)) {
      const v = node.value;
      let kind: Kind;
      let val: string;
      if (v === null || v === undefined) {
        kind = Kind.Null;
        val = vs >= 0 && ve > vs ? text.slice(vs, ve) : '';
      } else if (typeof v === 'boolean') {
        kind = v ? Kind.True : Kind.False;
        val = text.slice(vs, ve) || String(v);
      } else if (typeof v === 'number' || typeof v === 'bigint') {
        kind = Kind.Num;
        val = node.type === 'PLAIN' && vs >= 0 ? text.slice(vs, ve) : String(v);
      } else if (v instanceof Date) {
        kind = Kind.Date;
        val = vs >= 0 ? text.slice(vs, ve) : v.toISOString();
      } else if (v instanceof Uint8Array) {
        kind = Kind.Str;
        val = vs >= 0 ? text.slice(vs, ve).trim() : '';
      } else {
        kind = Kind.Str;
        val = String(v);
      }
      id = b.leaf(kind, kk, ks, ke, vs, ve, key, val);
      b.setMeta(id, { style: node.type });
    } else {
      // empty value (`key:` with nothing after it)
      id = b.leaf(Kind.Null, kk, ks, ke, vs, ve, key, '');
    }
    nodes[id] = node;
    pairs[id] = pair;
    docOf[id] = curDoc;
    if (Y.isNode(node)) meta(id, node);
  };

  const meta = (id: number, node: Y.Node) => {
    const m: { anchor?: string; tag?: string; comment?: string; style?: string } = {};
    if (node.anchor) {
      m.anchor = node.anchor;
      anchors.set(node.anchor, id);
    }
    if (node.tag) m.tag = node.tag.startsWith(SHORT_TAG) ? '!!' + node.tag.slice(SHORT_TAG.length) : node.tag;
    if (node.comment) m.comment = node.comment.trim();
    if ((Y.isMap(node) || Y.isSeq(node)) && node.flow) m.style = 'flow';
    if (Object.keys(m).length) b.setMeta(id, m);
  };

  const multi = list.length > 1;
  if (multi) {
    b.open(Kind.Arr, KeyKind.None, -1, -1, 0);
    nodes[0] = undefined;
    docOf[0] = -1;
  }
  list.forEach((doc, di) => {
    curDoc = di;
    const kk = multi ? KeyKind.Doc : KeyKind.None;
    const c = doc.contents;
    if (c === null || c === undefined) {
      const id = b.leaf(Kind.Null, kk, -1, -1, doc.range[0], doc.range[0], undefined, '');
      nodes[id] = null;
      docOf[id] = di;
    } else add(c, kk, undefined, undefined);
    for (const e of doc.errors) errors.push({ offset: e.pos[0], length: Math.max(1, e.pos[1] - e.pos[0]), message: cleanMessage(e.message), code: e.code });
    for (const w of doc.warnings) errors.push({ offset: w.pos[0], length: Math.max(1, w.pos[1] - w.pos[0]), message: cleanMessage(w.message), code: w.code, warning: true });
  });
  if (multi) b.close(text.length);
  const store = b.finish();
  if (multi && store.n) store.vs[0] = 0;
  return { store, errors, docs: list, nodes, pairs, docOf: Int32Array.from(docOf), multi };
}

// ---------------------------------------------------------------------------------------------------------------
// Scalars

const YNUM_RE = /^[-+]?(\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN|0x[0-9a-fA-F]+|0o[0-7]+|(0|[1-9][0-9_]*)(\.[0-9_]*)?([eE][-+]?[0-9]+)?|\.[0-9]+([eE][-+]?[0-9]+)?)$/;

function plainSafe(v: string, inFlow: boolean): boolean {
  if (!v || v.trim() !== v) return false;
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return false;
  if (/: |\s#|:$/.test(v)) return false;
  if (inFlow && /[,[\]{}]/.test(v)) return false;
  try {
    return Y.parse(v) === v;
  } catch {
    return false;
  }
}

/** Serialise a scalar for YAML keeping the original quoting style where it still works. */
export function yamlScalar(value: string, type: ValueType, style: string | undefined, inFlow: boolean): string {
  switch (type) {
    case 'null':
      return 'null';
    case 'boolean': {
      const v = value.trim().toLowerCase();
      if (v !== 'true' && v !== 'false') throw new EditError('Expected true or false');
      return v;
    }
    case 'number': {
      const v = value.trim();
      if (!YNUM_RE.test(v)) throw new EditError('Not a valid number');
      return v;
    }
    case 'object':
      return '{}';
    case 'array':
      return '[]';
    case 'string':
      if (style === 'QUOTE_SINGLE' && !/[\n\r]/.test(value)) return "'" + value.replace(/'/g, "''") + "'";
      if (style === 'QUOTE_DOUBLE') return JSON.stringify(value);
      return plainSafe(value, inFlow) ? value : JSON.stringify(value);
  }
}

function blockScalar(value: string, indent: string, folded: boolean): string | undefined {
  if (/^[ \t]/.test(value) || /[\u0000-\u0008\u000b-\u001f]/.test(value)) return undefined;
  const m = /\n*$/.exec(value)!;
  const trailing = m[0].length;
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
  const body = trailing ? value.slice(0, -trailing) : value;
  const lines = body.split('\n').map((l) => (l ? indent + l : ''));
  if (folded) return undefined; // folding rules are subtle; rewrite folded scalars as literal blocks
  return '|' + chomp + '\n' + lines.join('\n') + '\n' + (trailing > 1 ? '\n'.repeat(trailing - 1) : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Edits

export interface YamlEditOptions {
  unit: string;
  eol: string;
}

export type YamlOp =
  | { op: 'set'; id: number; value: string; type: ValueType }
  | { op: 'rename'; id: number; key: string }
  | { op: 'delete'; id: number }
  | { op: 'add'; id: number; key?: string; value: string; type: ValueType; after?: number }
  | { op: 'duplicate'; id: number }
  | { op: 'move'; id: number; dir: -1 | 1 };

function isFlow(r: YamlResult, id: number): boolean {
  return r.store.meta.get(id)?.style === 'flow';
}

/** Inside a flow collection at any level. */
function inFlow(r: YamlResult, id: number): boolean {
  for (let p = r.store.parent[id]; p >= 0; p = r.store.parent[p]) if (isFlow(r, p)) return true;
  return false;
}

/** Start of an item: key for pairs, the `-` indicator for block sequence items. */
function itemStart(r: YamlResult, id: number): number {
  const st = r.store;
  const src = st.src;
  if (st.ks[id] >= 0) return st.ks[id];
  const p = st.parent[id];
  if (p >= 0 && st.kind[p] === Kind.Arr && !isFlow(r, p)) {
    // walk back over anchors/tags/whitespace to the dash
    let k = st.vs[id] - 1;
    while (k >= 0) {
      const ch = src[k];
      if (ch === '-' && (k === 0 || /\s/.test(src[k - 1]))) return k;
      if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
        k--;
        continue;
      }
      // anchor / tag tokens: skip the word
      let j = k;
      while (j >= 0 && !/\s/.test(src[j])) j--;
      const word = src.slice(j + 1, k + 1);
      if (/^[&!]/.test(word)) {
        k = j;
        continue;
      }
      break;
    }
  }
  const m = st.meta.get(id);
  let s = st.vs[id];
  // include an anchor or tag written before the value
  if (m?.anchor || m?.tag) {
    const ls = lineStartOf(src, s);
    const before = src.slice(ls, s);
    const re = /(?:^|\s)([&!][^\s]*\s+)+$/.exec(before);
    if (re) s -= re[0].trimStart().length;
  }
  return s;
}

/** End of an item (after its last line's newline, for block items). */
function itemEnd(r: YamlResult, id: number): number {
  const st = r.store;
  const src = st.src;
  const node = r.nodes[id] as Y.Node | null | undefined;
  let e = Y.isNode(node) && node.range ? node.range[1] : st.ve[id] >= 0 ? st.ve[id] : st.ke[id];
  if (e < 0) e = st.ke[id];
  if (e > 0 && src[e - 1] === '\n') return e;
  // trailing comment / spaces up to the end of the line
  const nl = src.indexOf('\n', e);
  const rest = src.slice(e, nl < 0 ? src.length : nl);
  if (/^\s*(#.*)?\r?$/.test(rest)) return nl < 0 ? src.length : nl + 1;
  return e;
}

function blockItemIndent(r: YamlResult, id: number): string {
  const src = r.store.src;
  const s = itemStart(r, id);
  const ls = lineStartOf(src, s);
  const before = src.slice(ls, s);
  return /^\s*$/.test(before) ? before : ' '.repeat(s - ls);
}

function prevSibling(st: Store, i: number): number {
  const p = st.parent[i];
  if (p < 0) return -1;
  let prev = -1;
  for (let c = st.firstChild(p); c >= 0 && c !== i; c = st.nextSibling(c)) prev = c;
  return prev;
}

function uniqueKey(st: Store, p: number, base: string): string {
  const taken = new Set<string>();
  for (let c = st.firstChild(p); c >= 0; c = st.nextSibling(c)) taken.add(String(st.key(c)));
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const k = `${base}_copy${i > 1 ? i : ''}`;
    if (!taken.has(k)) return k;
  }
}

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function flowCommaAfter(src: string, e: number): number {
  let k = e;
  while (k < src.length && isWs(src[k])) k++;
  return src[k] === ',' ? k : -1;
}

/** Whole-document fallback: mutate the Document, then reduce to a minimal replacement of that document. */
function viaDocument(r: YamlResult, id: number, fn: (doc: Y.Document.Parsed) => void): TextEdit[] {
  const st = r.store;
  const di = r.docOf[id] >= 0 ? r.docOf[id] : 0;
  const doc = r.docs[di];
  if (!doc) throw new EditError('Unsupported edit');
  const before = st.src.slice(doc.range[0], doc.range[2]);
  fn(doc);
  const after = doc.toString({ lineWidth: 0, indent: 2 });
  const e = minimalEdit(before, after);
  return e ? [{ start: e.start + doc.range[0], end: e.end + doc.range[0], text: e.text }] : [];
}

/** Key as stored in the yaml Document (numbers etc. stay typed). */
function yKey(r: YamlResult, id: number): unknown {
  const p = r.pairs[id];
  if (p && Y.isScalar(p.key)) return p.key.value;
  return r.store.key(id);
}

function docPath(r: YamlResult, id: number): unknown[] {
  const st = r.store;
  const out: unknown[] = [];
  for (let c = id; c >= 0 && st.parent[c] >= 0; c = st.parent[c]) {
    if (r.multi && st.parent[c] === 0) break;
    out.push(st.kk[c] === KeyKind.Index ? st.pos[c] : yKey(r, c));
  }
  return out.reverse();
}

function valueNode(doc: Y.Document.Parsed, type: ValueType, value: string): unknown {
  switch (type) {
    case 'object':
      return doc.createNode({});
    case 'array':
      return doc.createNode([]);
    case 'null':
      return null;
    case 'boolean':
      return value.trim().toLowerCase() === 'true';
    case 'number': {
      const n = Number(value.trim());
      if (!Number.isFinite(n)) throw new EditError('Not a valid number');
      return n;
    }
    default:
      return value;
  }
}

export function yamlEdit(r: YamlResult, e: YamlOp, o: YamlEditOptions): TextEdit[] {
  const st = r.store;
  const src = st.src;
  const i = e.id;
  if (i < 0 || i >= st.n) throw new EditError('Node not found');
  if (st.kk[i] === KeyKind.Doc && e.op !== 'set' && e.op !== 'add') throw new EditError('Documents cannot be changed here');
  const p = st.parent[i];
  switch (e.op) {
    case 'set': {
      if (st.isContainer(i)) throw new EditError('Only scalar values can be edited inline');
      if (st.kind[i] === Kind.Alias) throw new EditError('Aliases cannot be edited');
      const style = st.meta.get(i)?.style;
      const vs = st.vs[i];
      const ve = st.ve[i];
      if (vs < 0) throw new EditError('Unsupported edit');
      const flow = inFlow(r, i);
      let text: string;
      if (e.type === 'string' && (style === 'BLOCK_LITERAL' || style === 'BLOCK_FOLDED') && e.value.includes('\n') && !flow) {
        const base = st.ks[i] >= 0 ? lineIndent(src, st.ks[i]) : blockItemIndent(r, i);
        text = blockScalar(e.value, base + o.unit, false) ?? JSON.stringify(e.value);
      } else text = yamlScalar(e.value, e.type, style?.startsWith('BLOCK') ? 'QUOTE_DOUBLE' : style, flow);
      const old = src.slice(vs, ve);
      if (style?.startsWith('BLOCK') && old.endsWith('\n') && !text.endsWith('\n')) text += o.eol;
      // `key:` with no value: keep a space after the colon
      if (vs === ve && vs > 0 && !isWs(src[vs - 1])) text = ' ' + text;
      return [{ start: vs, end: ve, text }];
    }
    case 'rename': {
      if (st.kk[i] !== KeyKind.Prop || st.ks[i] < 0) throw new EditError('Only mapping keys can be renamed');
      const pair = r.pairs[i];
      const style = pair && Y.isScalar(pair.key) ? pair.key.type : undefined;
      return [{ start: st.ks[i], end: st.ke[i], text: yamlScalar(e.key, 'string', style, inFlow(r, i)) }];
    }
    case 'delete': {
      if (p < 0) throw new EditError('The root cannot be deleted');
      if (isFlow(r, p)) {
        const s = itemStart(r, i);
        const next = st.nextSibling(i);
        const end = st.ve[i] >= 0 ? st.ve[i] : st.ke[i];
        if (next >= 0) {
          let k = flowCommaAfter(src, end);
          k = k >= 0 ? k + 1 : end;
          while (k < src.length && isWs(src[k])) k++;
          return [{ start: s, end: k, text: '' }];
        }
        const prev = prevSibling(st, i);
        if (prev >= 0) return [{ start: st.ve[prev], end, text: '' }];
        return [{ start: st.vs[p] + 1, end: st.ve[p] - 1, text: '' }];
      }
      const s = itemStart(r, i);
      const ls = lineStartOf(src, s);
      const own = /^\s*$/.test(src.slice(ls, s));
      const end = itemEnd(r, i);
      const next = st.nextSibling(i);
      if (st.count[p] === 1) {
        // last item: leave an empty flow collection behind (`key: []`) instead of turning the value into null
        return viaDocument(r, i, (doc) => {
          doc.deleteIn(docPath(r, i) as Y.Scalar[]);
        });
      }
      if (own) return [{ start: ls, end, text: '' }];
      if (next >= 0) return [{ start: s, end: itemStart(r, next), text: '' }];
      return viaDocument(r, i, (doc) => {
        doc.deleteIn(docPath(r, i) as Y.Scalar[]);
      });
    }
    case 'add': {
      if (!st.isContainer(i)) throw new EditError('Can only add to a mapping or sequence');
      const isMap = st.kind[i] === Kind.Obj;
      if (isMap && !e.key) throw new EditError('A key is required');
      const flow = isFlow(r, i) || inFlow(r, i);
      const val = yamlScalar(e.value, e.type, undefined, flow);
      const keyText = isMap ? yamlScalar(e.key!, 'string', undefined, flow) : '';
      if (st.count[i] === 0 || st.vs[i] < 0) {
        return viaDocument(r, i, (doc) => {
          const v = valueNode(doc, e.type, e.value);
          const path = docPath(r, i);
          const coll = path.length ? doc.getIn(path, true) : doc.contents;
          if (Y.isMap(coll)) coll.set(doc.createNode(e.key), v);
          else if (Y.isSeq(coll)) coll.add(v);
          else if (isMap) doc.setIn([...path, e.key], v);
          else doc.setIn(path, doc.createNode([v]));
        });
      }
      let a = e.after !== undefined && e.after >= 0 && st.parent[e.after] === i ? e.after : -1;
      if (a < 0) a = st.children(i).pop()!;
      if (isFlow(r, i)) {
        const member = isMap ? keyText + ': ' + val : val;
        const end = st.ve[a];
        const comma = flowCommaAfter(src, end);
        if (comma >= 0) return [{ start: comma + 1, end: comma + 1, text: ' ' + member + ',' }];
        return [{ start: end, end, text: ', ' + member }];
      }
      const ind = blockItemIndent(r, st.firstChild(i));
      const line = ind + (isMap ? keyText + ': ' + val : '- ' + val) + o.eol;
      const at = itemEnd(r, a);
      if (at > 0 && src[at - 1] !== '\n') return [{ start: at, end: at, text: o.eol + line.replace(/\r?\n$/, '') }];
      return [{ start: at, end: at, text: line }];
    }
    case 'duplicate': {
      if (p < 0) throw new EditError('The root cannot be duplicated');
      const s = itemStart(r, i);
      if (isFlow(r, p)) {
        let copy = src.slice(s, st.ve[i]);
        if (st.kind[p] === Kind.Obj && st.ks[i] >= 0) copy = yamlScalar(uniqueKey(st, p, String(st.key(i))), 'string', undefined, true) + src.slice(st.ke[i], st.ve[i]);
        const comma = flowCommaAfter(src, st.ve[i]);
        if (comma >= 0) return [{ start: comma + 1, end: comma + 1, text: ' ' + copy + ',' }];
        return [{ start: st.ve[i], end: st.ve[i], text: ', ' + copy }];
      }
      const end = itemEnd(r, i);
      const ind = blockItemIndent(r, i);
      let copy = src.slice(s, end);
      if (!copy.endsWith('\n')) copy += o.eol;
      if (st.kind[p] === Kind.Obj && st.ks[i] >= 0) {
        const pair = r.pairs[i];
        const style = pair && Y.isScalar(pair.key) ? pair.key.type : undefined;
        copy = yamlScalar(uniqueKey(st, p, String(st.key(i))), 'string', style, false) + copy.slice(st.ke[i] - s);
      }
      const text = ind + copy;
      if (end > 0 && src[end - 1] !== '\n') return [{ start: end, end, text: o.eol + text.replace(/\r?\n$/, '') }];
      return [{ start: end, end, text }];
    }
    case 'move': {
      const j = e.dir < 0 ? prevSibling(st, i) : st.nextSibling(i);
      if (j < 0) throw new EditError('Nothing to swap with');
      const a = e.dir < 0 ? j : i;
      const bb = e.dir < 0 ? i : j;
      if (isFlow(r, p)) {
        const sa = itemStart(r, a);
        const sb = itemStart(r, bb);
        const ta = src.slice(sa, st.ve[a]);
        const tb = src.slice(sb, st.ve[bb]);
        return [{ start: sa, end: st.ve[bb], text: tb + src.slice(st.ve[a], sb) + ta }];
      }
      const sa = itemStart(r, a);
      const sb = itemStart(r, bb);
      const ea = itemEnd(r, a);
      const eb = itemEnd(r, bb);
      let ta = src.slice(sa, ea);
      let tb = src.slice(sb, eb);
      if (!tb.endsWith('\n')) {
        tb += o.eol;
        ta = ta.replace(/\r?\n$/, '');
      }
      // when the first item shares its line with a parent `- `, the swapped-in item must not carry deeper indentation
      return [{ start: sa, end: eb, text: tb + src.slice(ea, sb) + ta }];
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Whole-document operations

/** The whole stream re-serialised (comments between documents belong to the documents, `---` markers too). */
function docsToString(r: YamlResult, opts: Y.ToStringOptions): string {
  return r.docs.map((d) => d.toString(opts)).join('');
}

export function yamlFormat(text: string, indent: number): string {
  const r = parseYaml(text);
  if (r.errors.some((e) => !e.warning)) throw new EditError('Fix the syntax errors first');
  return docsToString(r, { indent, lineWidth: 0, indentSeq: true });
}

export function yamlSortKeys(text: string): string {
  const r = parseYaml(text);
  if (r.errors.some((e) => !e.warning)) throw new EditError('Fix the syntax errors first');
  for (const d of r.docs) {
    Y.visit(d, {
      Map(_k, map) {
        map.items.sort((x, y) => naturalCompare(String(Y.isScalar(x.key) ? x.key.value : x.key), String(Y.isScalar(y.key) ? y.key.value : y.key)));
      },
    });
  }
  return docsToString(r, { lineWidth: 0 });
}

/** YAML text of a JS value (for "Copy as YAML"). */
export function toYaml(v: unknown, indent = 2): string {
  return Y.stringify(v, { indent, lineWidth: 0 });
}
