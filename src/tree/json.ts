// JSON / JSONC: a fast, resumable structure parser that fills the compact Store (comments and trailing commas
// tolerated), plus offset-precise edits that leave everything else in the file untouched.
// The UMD build (package "main") uses dynamic requires esbuild cannot bundle; the ESM build bundles cleanly.
import * as jsonc from 'jsonc-parser/lib/esm/main.js';
import { Builder, Store, TextEdit, lineIndent, minimalEdit } from './model';
import { Kind, KeyKind } from './protocol';

export interface RawError {
  offset: number;
  length: number;
  /** stable code for localisation */
  code: string;
  message: string;
}

export interface JsonResult {
  store: Store;
  errors: RawError[];
  comments: boolean;
  trailingCommas: boolean;
  /** the tree stops at the first error */
  partial: boolean;
}

const enum S {
  Value,
  ObjFirst,
  ObjKey,
  Colon,
  ObjNext,
  ArrFirst,
  ArrNext,
  ArrValue,
  End,
  Done,
}

const MESSAGES: Record<string, string> = {
  InvalidSymbol: 'Invalid symbol',
  InvalidNumberFormat: 'Invalid number format',
  PropertyNameExpected: 'Property name expected',
  ValueExpected: 'Value expected',
  ColonExpected: 'Colon expected',
  CommaExpected: 'Comma expected',
  CloseBraceExpected: 'Closing brace expected',
  CloseBracketExpected: 'Closing bracket expected',
  EndOfFileExpected: 'End of file expected',
  InvalidCommentToken: 'Invalid comment',
  UnexpectedEndOfComment: 'Unterminated comment',
  UnexpectedEndOfString: 'Unterminated string',
  UnexpectedEndOfNumber: 'Unexpected end of number',
  InvalidUnicode: 'Invalid unicode sequence',
  InvalidEscapeCharacter: 'Invalid escape character',
  InvalidCharacter: 'Invalid character',
};

export function errorMessage(code: string): string {
  return MESSAGES[code] ?? code;
}

/**
 * Resumable parser: call step(budgetMs) until it returns true. Roughly 4–5× faster than jsonc-parser's visitor and
 * never builds per-node objects.
 */
export class JsonParser {
  private b: Builder;
  private p = 0;
  private state = S.Value;
  private ks = -1;
  private ke = -1;
  private errors: RawError[] = [];
  private comments = false;
  private trailing = false;
  private partial = false;
  readonly length: number;

  constructor(private text: string) {
    this.length = text.length;
    this.b = new Builder(text, Math.min(text.length / 20 + 64, 50_000_000));
    if (text.charCodeAt(0) === 0xfeff) this.p = 1;
  }

  get progress(): number {
    return this.length ? this.p / this.length : 1;
  }

  private fail(code: string, offset: number, length = 1): void {
    this.errors.push({ offset, length, code, message: errorMessage(code) });
    this.partial = true;
    this.state = S.Done;
  }

  /** Next backslash / newline at or after a position (cached: most strings contain neither). */
  private nextBs = -1;
  private nextNl = -1;

  /** Scan a string starting at the quote at p; returns the offset after the closing quote or -1. */
  private scanString(p: number): number {
    const t = this.text;
    let q = p + 1;
    // short strings: a plain loop beats indexOf's call overhead
    const lim = Math.min(this.length, q + 24);
    for (; q < lim; q++) {
      const c = t.charCodeAt(q);
      if (c === 34) return q + 1;
      if (c === 92 || c === 10 || c === 13) break;
    }
    for (;;) {
      const e = t.indexOf('"', q);
      if (e < 0) return -1;
      if (this.nextNl < q) {
        const nl = t.indexOf('\n', q);
        this.nextNl = nl < 0 ? Infinity : nl;
      }
      if (this.nextNl < e) return -1;
      if (this.nextBs < q) {
        const bs = t.indexOf('\\', q);
        this.nextBs = bs < 0 ? Infinity : bs;
      }
      if (this.nextBs > e) return e + 1;
      // an escape comes first: step over it and look again
      q = this.nextBs + 2;
    }
  }

  step(budgetMs = 1e9): boolean {
    const t = this.text;
    const n = this.length;
    const b = this.b;
    const st = b.st;
    const deadline = performance.now() + budgetMs;
    let p = this.p;
    let state = this.state;
    let iter = 0;
    // kind of the innermost open container: 0 none, 1 object, 2 array
    let top = b.top < 0 ? 0 : st.kind[b.top] === Kind.Obj ? 1 : 2;
    const after = () => {
      const tp = b.top;
      top = tp < 0 ? 0 : st.kind[tp] === Kind.Obj ? 1 : 2;
      state = top === 0 ? S.End : top === 1 ? S.ObjNext : S.ArrNext;
    };
    const fail = (code: string, at: number, len = 1) => {
      this.fail(code, at, len);
      state = S.Done;
    };
    while (state !== S.Done) {
      if ((++iter & 0x3fff) === 0 && performance.now() > deadline) {
        this.p = p;
        this.state = state;
        return false;
      }
      // trivia
      let c = t.charCodeAt(p);
      while (c === 32 || c === 10 || c === 13 || c === 9 || c === 47) {
        if (c === 47) {
          const d = t.charCodeAt(p + 1);
          if (d === 47) {
            const e = t.indexOf('\n', p);
            p = e < 0 ? n : e;
            this.comments = true;
          } else if (d === 42) {
            const e = t.indexOf('*/', p + 2);
            if (e < 0) {
              fail('UnexpectedEndOfComment', p, n - p);
              break;
            }
            p = e + 2;
            this.comments = true;
          } else break;
        } else p++;
        c = t.charCodeAt(p);
      }
      if ((state as S) === S.Done) break;
      if (p >= n) {
        if (state === S.End || (state === S.Value && st.n === 0)) state = S.Done;
        else fail(top === 1 ? (state === S.Colon ? 'ColonExpected' : state === S.ObjNext ? 'CloseBraceExpected' : 'PropertyNameExpected') : top === 2 ? 'CloseBracketExpected' : 'ValueExpected', n, 0);
        break;
      }
      switch (state) {
        case S.ObjFirst:
        case S.ObjKey:
          if (c === 34) {
            const e = this.scanString(p);
            if (e < 0) {
              fail('UnexpectedEndOfString', p, 1);
              break;
            }
            this.ks = p;
            this.ke = e;
            p = e;
            state = S.Colon;
          } else if (c === 125) {
            if (state === S.ObjKey) this.trailing = true;
            b.close(p + 1);
            p++;
            after();
          } else fail('PropertyNameExpected', p);
          break;
        case S.Colon:
          if (c === 58) {
            p++;
            state = S.Value;
          } else fail('ColonExpected', p);
          break;
        case S.ObjNext:
          if (c === 44) {
            p++;
            state = S.ObjKey;
          } else if (c === 125) {
            b.close(p + 1);
            p++;
            after();
          } else fail('CommaExpected', p);
          break;
        case S.ArrNext:
          if (c === 44) {
            p++;
            state = S.ArrValue;
          } else if (c === 93) {
            b.close(p + 1);
            p++;
            after();
          } else fail('CommaExpected', p);
          break;
        case S.End:
          fail('EndOfFileExpected', p, n - p);
          break;
        default: {
          // S.Value, S.ArrFirst, S.ArrValue
          if (c === 93 && state !== S.Value) {
            if (state === S.ArrValue) this.trailing = true;
            b.close(p + 1);
            p++;
            after();
            break;
          }
          const kk = top === 1 ? KeyKind.Prop : top === 2 ? KeyKind.Index : KeyKind.None;
          const ks = top === 1 ? this.ks : -1;
          const ke = top === 1 ? this.ke : -1;
          const next = top === 0 ? S.End : top === 1 ? S.ObjNext : S.ArrNext;
          if (c === 34) {
            const e = this.scanString(p);
            if (e < 0) {
              fail('UnexpectedEndOfString', p, 1);
              break;
            }
            b.leaf(Kind.Str, kk, ks, ke, p, e);
            p = e;
            state = next;
          } else if (c === 123) {
            b.open(Kind.Obj, kk, ks, ke, p);
            p++;
            top = 1;
            state = S.ObjFirst;
          } else if (c === 91) {
            b.open(Kind.Arr, kk, ks, ke, p);
            p++;
            top = 2;
            state = S.ArrFirst;
          } else if (c === 45 || (c >= 48 && c <= 57)) {
            let q = p + 1;
            for (let d = t.charCodeAt(q); (d >= 48 && d <= 57) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45; d = t.charCodeAt(++q));
            const last = t.charCodeAt(q - 1);
            if (!(last >= 48 && last <= 57)) {
              fail('InvalidNumberFormat', p, q - p);
              break;
            }
            b.leaf(Kind.Num, kk, ks, ke, p, q);
            p = q;
            state = next;
          } else if (c === 116 && t.startsWith('true', p)) {
            b.leaf(Kind.True, kk, ks, ke, p, p + 4);
            p += 4;
            state = next;
          } else if (c === 102 && t.startsWith('false', p)) {
            b.leaf(Kind.False, kk, ks, ke, p, p + 5);
            p += 5;
            state = next;
          } else if (c === 110 && t.startsWith('null', p)) {
            b.leaf(Kind.Null, kk, ks, ke, p, p + 4);
            p += 4;
            state = next;
          } else fail(c === 44 || c === 125 || c === 93 ? 'ValueExpected' : 'InvalidSymbol', p);
          break;
        }
      }
    }
    this.p = p;
    this.state = S.Done;
    return true;
  }

  result(): JsonResult {
    const errs = this.errors;
    this.b.closeAll(errs.length ? errs[0].offset : this.length);
    return { store: this.b.finish(), errors: errs, comments: this.comments, trailingCommas: this.trailing, partial: this.partial };
  }
}

export function parseJson(text: string): JsonResult {
  const p = new JsonParser(text);
  p.step();
  return p.result();
}

/** All syntax errors (jsonc-parser recovers and keeps going, so this lists more than the first). */
export function allJsonErrors(text: string): RawError[] {
  const errs: jsonc.ParseError[] = [];
  jsonc.parse(text, errs, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
  return errs.map((e) => {
    const code = jsonc.printParseErrorCode(e.error);
    return { offset: e.offset, length: e.length, code, message: errorMessage(code) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Edits

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

const NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export class EditError extends Error {}

/** JSON literal for a typed value; throws EditError when the text doesn't fit the type. */
export function jsonLiteral(value: string, type: ValueType): string {
  switch (type) {
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      const v = value.trim();
      if (!NUM_RE.test(v)) throw new EditError('Not a valid number');
      return v;
    }
    case 'boolean': {
      const v = value.trim().toLowerCase();
      if (v !== 'true' && v !== 'false') throw new EditError('Expected true or false');
      return v;
    }
    case 'null':
      return 'null';
    case 'object':
      return '{}';
    case 'array':
      return '[]';
  }
}

function memberStart(st: Store, i: number): number {
  return st.ks[i] >= 0 ? st.ks[i] : st.vs[i];
}

function prevSibling(st: Store, i: number): number {
  const p = st.parent[i];
  if (p < 0) return -1;
  let prev = -1;
  for (let c = st.firstChild(p); c >= 0 && c !== i; c = st.nextSibling(c)) prev = c;
  return prev;
}

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Offset of the comma following value end `e` (whitespace only in between), or -1. */
function commaAfter(src: string, e: number): number {
  let k = e;
  while (k < src.length && isWs(src[k])) k++;
  return src[k] === ',' ? k : -1;
}

/** If the rest of the line after `k` is a // comment, the offset of that line's end; else -1. */
function trailingLineComment(src: string, k: number): number {
  let j = k;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  if (src[j] === '/' && src[j + 1] === '/') {
    const nl = src.indexOf('\n', j);
    return nl < 0 ? src.length : nl;
  }
  if (src[j] === '/' && src[j + 1] === '*') {
    const end = src.indexOf('*/', j + 2);
    if (end >= 0 && src.slice(j, end).indexOf('\n') < 0) return trailingLineComment(src, end + 2) >= 0 ? trailingLineComment(src, end + 2) : end + 2;
  }
  return -1;
}

function multiline(st: Store, container: number): boolean {
  const s = st.vs[container];
  const first = st.firstChild(container);
  const e = first >= 0 ? memberStart(st, first) : st.ve[container];
  return st.src.slice(s, e).includes('\n') || (first < 0 && st.src.slice(s, st.ve[container]).includes('\n'));
}

export interface JsonEditOptions {
  /** indentation unit, e.g. '  ' */
  unit: string;
  eol: string;
}

/** Insert `member` (already serialised) as a new sibling right after node `a`. */
function insertAfter(st: Store, a: number, member: string, o: JsonEditOptions): TextEdit[] {
  const src = st.src;
  const p = st.parent[a];
  const ml = multiline(st, p);
  const comma = commaAfter(src, st.ve[a]);
  if (!ml) {
    if (comma >= 0) return [{ start: comma + 1, end: comma + 1, text: ' ' + member + ',' }];
    return [{ start: st.ve[a], end: st.ve[a], text: ', ' + member }];
  }
  const ind = lineIndent(src, memberStart(st, a));
  if (comma >= 0) {
    const lc = trailingLineComment(src, comma + 1);
    const at = lc >= 0 ? lc : comma + 1;
    // inserted after the separator: keep a separator after the new member when something (or a trailing comma) follows
    return [{ start: at, end: at, text: o.eol + ind + member + ',' }];
  }
  const lc = trailingLineComment(src, st.ve[a]);
  if (lc >= 0) return [{ start: st.ve[a], end: st.ve[a], text: ',' }, { start: lc, end: lc, text: o.eol + ind + member }];
  return [{ start: st.ve[a], end: st.ve[a], text: ',' + o.eol + ind + member }];
}

function addTo(st: Store, p: number, member: string, after: number | undefined, o: JsonEditOptions): TextEdit[] {
  const src = st.src;
  if (st.count[p] === 0) {
    const ind = lineIndent(src, memberStart(st, p));
    return [{ start: st.vs[p] + 1, end: st.ve[p] - 1, text: o.eol + ind + o.unit + member + o.eol + ind }];
  }
  let a = after !== undefined && after >= 0 && st.parent[after] === p ? after : -1;
  if (a < 0) a = st.children(p).pop()!;
  return insertAfter(st, a, member, o);
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

export type JsonOp =
  | { op: 'set'; id: number; value: string; type: ValueType }
  | { op: 'rename'; id: number; key: string }
  | { op: 'delete'; id: number }
  | { op: 'add'; id: number; key?: string; value: string; type: ValueType; after?: number }
  | { op: 'duplicate'; id: number }
  | { op: 'move'; id: number; dir: -1 | 1 };

/** Text edits for one operation on a store parsed from exactly `st.src`. */
export function jsonEdit(st: Store, e: JsonOp, o: JsonEditOptions): TextEdit[] {
  const src = st.src;
  const i = e.id;
  if (i < 0 || i >= st.n) throw new EditError('Node not found');
  switch (e.op) {
    case 'set':
      // the value's own token range: everything around it (key, comments, commas) stays as written
      return [{ start: st.vs[i], end: st.ve[i], text: jsonLiteral(e.value, e.type) }];
    case 'rename': {
      if (st.kk[i] !== KeyKind.Prop || st.ks[i] < 0) throw new EditError('Only object members can be renamed');
      return [{ start: st.ks[i], end: st.ke[i], text: JSON.stringify(e.key) }];
    }
    case 'delete': {
      const p = st.parent[i];
      if (p < 0) throw new EditError('The root cannot be deleted');
      const s = memberStart(st, i);
      const next = st.nextSibling(i);
      if (next >= 0) {
        const comma = commaAfter(src, st.ve[i]);
        let k = comma >= 0 ? comma + 1 : st.ve[i];
        const lc = trailingLineComment(src, k);
        if (lc >= 0) k = lc;
        while (k < src.length && isWs(src[k])) k++;
        return [{ start: s, end: k, text: '' }];
      }
      const prev = prevSibling(st, i);
      if (prev >= 0) {
        const comma = commaAfter(src, st.ve[prev]);
        let k = s;
        while (k > 0 && isWs(src[k - 1])) k--;
        if (comma >= 0 && comma < k) return [{ start: comma, end: comma + 1, text: '' }, { start: k, end: st.ve[i], text: '' }];
        return [{ start: st.ve[prev], end: st.ve[i], text: '' }];
      }
      return [{ start: st.vs[p] + 1, end: st.ve[p] - 1, text: '' }];
    }
    case 'add': {
      const isObj = st.kind[i] === Kind.Obj;
      if (!st.isContainer(i)) throw new EditError('Can only add to an object or array');
      if (isObj && !e.key) throw new EditError('A key is required');
      const lit = jsonLiteral(e.value, e.type);
      const member = (isObj ? JSON.stringify(e.key) + ': ' : '') + lit;
      return addTo(st, i, member, e.after, o);
    }
    case 'duplicate': {
      const p = st.parent[i];
      if (p < 0) throw new EditError('The root cannot be duplicated');
      let member: string;
      if (st.kind[p] === Kind.Obj) member = JSON.stringify(uniqueKey(st, p, String(st.key(i)))) + src.slice(st.ke[i], st.ve[i]);
      else member = src.slice(st.vs[i], st.ve[i]);
      return insertAfter(st, i, member, o);
    }
    case 'move': {
      const j = e.dir < 0 ? prevSibling(st, i) : st.nextSibling(i);
      if (j < 0) throw new EditError('Nothing to swap with');
      const a = e.dir < 0 ? j : i;
      const b = e.dir < 0 ? i : j;
      const ta = src.slice(memberStart(st, a), st.ve[a]);
      const tb = src.slice(memberStart(st, b), st.ve[b]);
      return [{ start: memberStart(st, a), end: st.ve[b], text: tb + src.slice(st.ve[a], memberStart(st, b)) + ta }];
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Whole-document operations

export function jsonFormat(text: string, indent: number, eol: string): TextEdit[] {
  const edits = jsonc.format(text, undefined, { tabSize: indent, insertSpaces: true, eol, insertFinalNewline: text.endsWith('\n'), keepLines: false });
  return edits.map((e) => ({ start: e.offset, end: e.offset + e.length, text: e.content }));
}

/** Drop all whitespace and comments. */
export function jsonMinify(text: string): string {
  const sc = jsonc.createScanner(text, false);
  const parts: string[] = [];
  for (let k = sc.scan(); k !== jsonc.SyntaxKind.EOF; k = sc.scan()) {
    if (k === jsonc.SyntaxKind.Trivia || k === jsonc.SyntaxKind.LineBreakTrivia || k === jsonc.SyntaxKind.LineCommentTrivia || k === jsonc.SyntaxKind.BlockCommentTrivia) continue;
    parts.push(text.substr(sc.getTokenOffset(), sc.getTokenLength()));
  }
  return parts.join('') + (text.endsWith('\n') ? '\n' : '');
}

export const keyCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string) => collator.compare(a, b) || keyCompare(a, b);

/**
 * Recursively sort object members by key. Rebuilt from the source: separators, comments and the formatting inside
 * each member are kept; only member order changes.
 */
export function jsonSortKeys(st: Store): TextEdit | undefined {
  if (!st.n) return undefined;
  const src = st.src;
  const rebuild = (i: number): string => {
    const k = st.kind[i];
    if ((k !== Kind.Obj && k !== Kind.Arr) || st.count[i] === 0) return src.slice(st.vs[i], st.ve[i]);
    const kids = st.children(i);
    const starts = kids.map((c) => memberStart(st, c));
    const lead = src.slice(st.vs[i], starts[0]);
    const gaps: string[] = [];
    for (let j = 0; j < kids.length - 1; j++) gaps.push(src.slice(st.ve[kids[j]], starts[j + 1]));
    const tail = src.slice(st.ve[kids[kids.length - 1]], st.ve[i]);
    const order = k === Kind.Obj ? [...kids.keys()].sort((x, y) => naturalCompare(String(st.key(kids[x])), String(st.key(kids[y]))) || x - y) : [...kids.keys()];
    let out = lead;
    order.forEach((j, idx) => {
      const c = kids[j];
      out += src.slice(starts[j], st.vs[c]) + rebuild(c);
      if (idx < gaps.length) out += gaps[idx];
    });
    return out + tail;
  };
  const next = src.slice(0, st.vs[0]) + rebuild(0) + src.slice(st.ve[0]);
  return minimalEdit(src, next);
}
