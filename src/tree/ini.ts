// INI and .env: a small line-based parser that keeps the position of every section, key, value and comment, so edits
// are line-level replacements that leave the rest of the file alone.
import { Builder, Store, TextEdit, lineEndAfter } from './model';
import { EditError, ValueType } from './json';
import { Kind, KeyKind } from './protocol';

export interface IniError {
  offset: number;
  line: number;
  message: string;
}

export interface IniEntry {
  /** statement range: line start … after the last line's newline */
  s: number;
  e: number;
  /** value text range (inside quotes for quoted values) and the full raw value range (with quotes) */
  qs: number;
  qe: number;
  /** quoting: '"', "'", '`' or '' */
  quote: string;
  /** separator text including surrounding spaces, e.g. ' = ' or '=' */
  sep: string;
  /** `export ` prefix (.env) */
  exp: boolean;
  /** key without any value or separator (INI) */
  bare?: boolean;
  multiline?: boolean;
  line: number;
}

export interface IniResult {
  store: Store;
  errors: IniError[];
  entries: (IniEntry | undefined)[];
  /** section id → [header line start, section end] */
  sections: Map<number, { s: number; e: number; insertAt: number }>;
  env: boolean;
  /** insertion point for new global keys */
  globalInsert: number;
  keyWidth: number;
}

interface RawLine {
  s: number;
  e: number; // after newline
  text: string; // without the newline
}

function lines(text: string): RawLine[] {
  const out: RawLine[] = [];
  let s = 0;
  while (s < text.length) {
    const nl = text.indexOf('\n', s);
    const e = nl < 0 ? text.length : nl + 1;
    let body = text.slice(s, nl < 0 ? text.length : nl);
    if (body.endsWith('\r')) body = body.slice(0, -1);
    out.push({ s, e, text: body });
    s = e;
  }
  return out;
}

function inferKind(v: string, quoted: boolean): Kind {
  if (quoted) return Kind.Str;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Kind.Num;
  const l = v.toLowerCase();
  if (l === 'true') return Kind.True;
  if (l === 'false') return Kind.False;
  return Kind.Str;
}

function unescapeDq(s: string): string {
  return s.replace(/\\([nrt"\\$`])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c as 'n'] ?? c);
}

export function parseIni(text: string, env: boolean): IniResult {
  const b = new Builder(text, 128, true);
  const entries: (IniEntry | undefined)[] = [];
  const sections = new Map<number, { s: number; e: number; insertAt: number }>();
  const errors: IniError[] = [];
  const ls = lines(text);
  b.open(Kind.Obj, KeyKind.None, -1, -1, 0);
  let section = -1;
  let pending: string[] = [];
  let lastEntry = -1;
  let globalInsert = -1;
  let firstSectionStart = -1;
  let keyWidth = 0;
  for (let li = 0; li < ls.length; li++) {
    const L = ls[li];
    const t = L.text;
    const trimmed = t.trim();
    if (!trimmed) {
      pending = [];
      continue;
    }
    if (trimmed[0] === '#' || (!env && trimmed[0] === ';')) {
      pending.push(trimmed.replace(/^[#;]+\s?/, ''));
      continue;
    }
    if (!env) {
      const m = /^(\s*)\[([^\]]*)\]\s*([;#].*)?$/.exec(t);
      if (m) {
        if (section >= 0) {
          const sec = sections.get(section)!;
          sec.e = L.s;
          b.close(L.s);
        }
        if (firstSectionStart < 0) firstSectionStart = L.s;
        const nameStart = L.s + m[1].length + 1;
        const name = m[2].trim();
        const ks = nameStart + (m[2].length - m[2].trimStart().length);
        section = b.open(Kind.Obj, KeyKind.Section, ks, ks + name.length, L.s + m[1].length, name);
        sections.set(section, { s: L.s, e: text.length, insertAt: L.e });
        const c = [...pending, ...(m[3] ? [m[3].replace(/^[;#]+\s?/, '')] : [])];
        b.setMeta(section, { line: li + 1, ...(c.length ? { comment: c.join(' · ') } : {}) });
        pending = [];
        lastEntry = -1;
        continue;
      }
      // continuation line (configparser style): indented, follows an entry, no separator
      if (/^\s/.test(t) && lastEntry >= 0 && !/[=:]/.test(trimmed)) {
        const en = entries[lastEntry]!;
        en.e = L.e;
        en.multiline = true;
        b.st.vals![lastEntry] = (b.st.vals![lastEntry] ?? '') + '\n' + trimmed;
        b.setMeta(lastEntry, { ro: true });
        if (section >= 0) sections.get(section)!.insertAt = L.e;
        else globalInsert = L.e;
        continue;
      }
    }
    // key/value
    let p = 0;
    while (p < t.length && /\s/.test(t[p])) p++;
    let exp = false;
    if (env && /^export\s+/.test(t.slice(p))) {
      exp = true;
      p += /^export\s+/.exec(t.slice(p))![0].length;
    }
    const sepRe = env ? /=/ : /[=:]/;
    const rest = t.slice(p);
    const sm = sepRe.exec(rest);
    if (!sm) {
      if (env) {
        errors.push({ offset: L.s, line: li + 1, message: 'Expected KEY=value' });
        continue;
      }
      // INI key without a value
      const key = rest.trim();
      const ks = L.s + p;
      const id = b.leaf(Kind.Null, KeyKind.Prop, ks, ks + key.length, ks + key.length, ks + key.length, key, '');
      entries[id] = { s: L.s, e: L.e, qs: ks + key.length, qe: ks + key.length, quote: '', sep: '', exp, bare: true, line: li + 1 };
      b.setMeta(id, { line: li + 1, ...(pending.length ? { comment: pending.join(' · ') } : {}) });
      keyWidth = Math.max(keyWidth, key.length);
      pending = [];
      lastEntry = id;
      if (section >= 0) sections.get(section)!.insertAt = L.e;
      else globalInsert = L.e;
      continue;
    }
    const rawKey = rest.slice(0, sm.index);
    const key = rawKey.trim();
    const ks = L.s + p + (rawKey.length - rawKey.trimStart().length);
    const ke = ks + key.length;
    let q = p + sm.index + 1;
    while (q < t.length && (t[q] === ' ' || t[q] === '\t')) q++;
    const sep = t.slice(p + rawKey.trimEnd().length, q);
    let value: string;
    let quote = '';
    let qs: number;
    let qe: number;
    let end = L.e;
    let comment: string | undefined;
    let multiline = false;
    const c0 = t[q];
    if (c0 === '"' || c0 === "'" || (env && c0 === '`')) {
      quote = c0;
      // find the closing quote, possibly on a later line (.env multi-line values)
      const abs = L.s + q;
      let k = abs + 1;
      let close = -1;
      while (k < text.length) {
        const ch = text[k];
        if (ch === '\\' && quote === '"') k += 2;
        else if (ch === quote) {
          close = k;
          break;
        } else if (ch === '\n' && !env) break;
        else k++;
      }
      if (close < 0) {
        errors.push({ offset: abs, line: li + 1, message: 'Unterminated quoted value' });
        qs = abs + 1;
        qe = L.s + t.length;
        value = text.slice(qs, qe);
      } else {
        qs = abs + 1;
        qe = close;
        value = text.slice(qs, qe);
        if (value.includes('\n')) {
          multiline = true;
          // advance the line cursor past the value
          while (li + 1 < ls.length && ls[li].e <= close) li++;
          end = ls[li].e;
        }
        const after = text.slice(close + 1, lineEndAfter(text, close)).trim();
        if (after.startsWith('#') || (!env && after.startsWith(';'))) comment = after.replace(/^[#;]+\s?/, '');
      }
      if (quote === '"' && env) value = unescapeDq(value);
    } else {
      // plain: up to an inline comment (whitespace + # / ;)
      const body = t.slice(q);
      const cm = (env ? /\s#/ : /\s[;#]/).exec(body);
      const raw = (cm ? body.slice(0, cm.index) : body).trimEnd();
      if (cm) comment = body.slice(cm.index).trim().replace(/^[#;]+\s?/, '');
      qs = L.s + q;
      qe = qs + raw.length;
      value = raw;
    }
    const kind = inferKind(value, !!quote);
    const id = b.leaf(kind, KeyKind.Prop, ks, ke, quote ? qs - 1 : qs, quote ? qe + 1 : qe, key, value);
    entries[id] = { s: L.s, e: end, qs, qe, quote, sep, exp, multiline, line: li + 1 };
    const c = [...pending, ...(comment ? [comment] : [])];
    b.setMeta(id, { line: li + 1, style: quote, ...(c.length ? { comment: c.join(' · ') } : {}), ...(exp ? { tag: 'export' } : {}) });
    keyWidth = Math.max(keyWidth, key.length);
    pending = [];
    lastEntry = id;
    if (section >= 0) sections.get(section)!.insertAt = end;
    else globalInsert = end;
  }
  if (section >= 0) b.close(text.length);
  b.close(text.length);
  const store = b.finish();
  if (globalInsert < 0) globalInsert = firstSectionStart >= 0 ? firstSectionStart : text.length;
  return { store, errors, entries, sections, env, globalInsert, keyWidth };
}

// ---------------------------------------------------------------------------------------------------------------
// Edits

export type IniOp =
  | { op: 'set'; id: number; value: string; type: ValueType }
  | { op: 'rename'; id: number; key: string }
  | { op: 'delete'; id: number }
  | { op: 'add'; id: number; key?: string; value: string; type: ValueType; after?: number }
  | { op: 'duplicate'; id: number }
  | { op: 'move'; id: number; dir: -1 | 1 };

function needsQuotes(v: string, env: boolean): boolean {
  return v !== v.trim() || /[\n\r]/.test(v) || /^["'`]/.test(v) || (env ? /\s#/.test(v) : /\s[;#]/.test(v)) || (!env && /^[;#]/.test(v)) || (env && /^#/.test(v));
}

function quoteValue(v: string, quote: string, env: boolean): string {
  if (quote === "'" && !v.includes("'") && (env || !v.includes('\n'))) return "'" + v + "'";
  if (quote === '`' && !v.includes('`')) return '`' + v + '`';
  if (quote === '"' || needsQuotes(v, env)) return '"' + (env ? v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') : v.replace(/"/g, '\\"')) + '"';
  return v;
}

function checkKey(k: string, env: boolean): string {
  const key = k.trim();
  if (!key) throw new EditError('A key is required');
  if (/[=\n\r]/.test(key) || (!env && /[:[\]]/.test(key)) || (env && /[\s#]/.test(key))) throw new EditError('Invalid key name');
  return key;
}

function valueText(e: { value: string; type: ValueType }): string {
  if (e.type === 'null') return '';
  if (e.type === 'boolean') {
    const v = e.value.trim().toLowerCase();
    if (v !== 'true' && v !== 'false') throw new EditError('Expected true or false');
    return v;
  }
  if (e.type === 'number' && !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(e.value.trim())) throw new EditError('Not a valid number');
  if (e.type === 'object' || e.type === 'array') throw new EditError('Only text values are supported here');
  return e.type === 'number' ? e.value.trim() : e.value;
}

function siblingEntries(r: IniResult, p: number): number[] {
  return r.store.children(p).filter((c) => r.entries[c]);
}

export function iniEdit(r: IniResult, e: IniOp, eol: string): TextEdit[] {
  const st = r.store;
  const src = st.src;
  const i = e.id;
  if (i < 0 || i >= st.n) throw new EditError('Node not found');
  const en = r.entries[i];
  switch (e.op) {
    case 'set': {
      if (!en) throw new EditError('Only values can be edited');
      const v = valueText(e);
      if (en.bare) return [{ start: st.ke[i], end: st.ke[i], text: ' = ' + quoteValue(v, '', r.env) }];
      if (en.quote) {
        const q = quoteValue(v, en.quote, r.env);
        return [{ start: en.qs - 1, end: en.qe + 1, text: q }];
      }
      return [{ start: en.qs, end: en.qe, text: quoteValue(v, '', r.env) }];
    }
    case 'rename': {
      if (st.kk[i] === KeyKind.Section) {
        const name = e.key.trim();
        if (!name || /[\]\n\r]/.test(name)) throw new EditError('Invalid section name');
        return [{ start: st.ks[i], end: st.ke[i], text: name }];
      }
      if (!en) throw new EditError('Only keys can be renamed');
      return [{ start: st.ks[i], end: st.ke[i], text: checkKey(e.key, r.env) }];
    }
    case 'delete': {
      if (st.kk[i] === KeyKind.Section) {
        const sec = r.sections.get(i)!;
        return [{ start: sec.s, end: sec.e, text: '' }];
      }
      if (!en) throw new EditError('Only entries can be deleted');
      return [{ start: en.s, end: en.e, text: '' }];
    }
    case 'add': {
      const p = i;
      if (st.kk[p] !== KeyKind.Section && st.kk[p] !== KeyKind.None) throw new EditError('Add entries to a section');
      if (st.kk[p] === KeyKind.None && (e.type === 'object' || e.type === 'array')) {
        if (r.env) throw new EditError('.env files have no sections');
        const name = (e.key ?? '').trim();
        if (!name || /[\]\n\r]/.test(name)) throw new EditError('Invalid section name');
        const pre = src.length && !src.endsWith('\n') ? eol : '';
        const blank = src.trim().length ? eol : '';
        return [{ start: src.length, end: src.length, text: pre + blank + '[' + name + ']' + eol }];
      }
      const key = checkKey(e.key ?? '', r.env);
      const v = valueText(e);
      // copy the style of a neighbouring entry
      const sibs = siblingEntries(r, p);
      const ref = e.after !== undefined && r.entries[e.after] ? r.entries[e.after]! : sibs.length ? r.entries[sibs[sibs.length - 1]]! : undefined;
      const sep = ref && !ref.bare ? ref.sep : r.env ? '=' : ' = ';
      const ind = ref ? (/^\s*/.exec(src.slice(ref.s, st.ks[sibs[sibs.length - 1]] ?? ref.s))?.[0] ?? '').replace(/export\s+$/, '') : '';
      const exp = ref?.exp ? 'export ' : '';
      const line = ind + exp + key + sep + quoteValue(v, '', r.env) + eol;
      let at: number;
      if (e.after !== undefined && r.entries[e.after]) at = r.entries[e.after]!.e;
      else if (st.kk[p] === KeyKind.Section) at = r.sections.get(p)!.insertAt;
      else at = r.globalInsert;
      if (at > 0 && src[at - 1] !== '\n') return [{ start: at, end: at, text: eol + line.replace(/\r?\n$/, '') }];
      // inserting right before the first section header: keep a blank line between
      if (st.kk[p] === KeyKind.None && !sibs.length && at < src.length) return [{ start: at, end: at, text: line + eol }];
      return [{ start: at, end: at, text: line }];
    }
    case 'duplicate': {
      if (!en) throw new EditError('Only entries can be duplicated');
      const p = st.parent[i];
      const taken = new Set(st.children(p).map((c) => String(st.key(c))));
      const base = String(st.key(i));
      const suffix = base === base.toUpperCase() && /[A-Z]/.test(base) ? '_COPY' : '_copy';
      let k = base + suffix;
      for (let n = 2; taken.has(k); n++) k = base + suffix + n;
      let copy = src.slice(en.s, en.e);
      copy = copy.slice(0, st.ks[i] - en.s) + k + copy.slice(st.ke[i] - en.s);
      if (!copy.endsWith('\n')) copy = eol + copy;
      return [{ start: en.e, end: en.e, text: copy }];
    }
    case 'move': {
      if (!en) throw new EditError('Only entries can be moved');
      const p = st.parent[i];
      const sibs = siblingEntries(r, p);
      const k = sibs.indexOf(i);
      const j = sibs[k + e.dir];
      if (j === undefined) throw new EditError('Nothing to swap with');
      const a = r.entries[e.dir < 0 ? j : i]!;
      const bb = r.entries[e.dir < 0 ? i : j]!;
      let ta = src.slice(a.s, a.e);
      let tb = src.slice(bb.s, bb.e);
      if (!tb.endsWith('\n')) {
        tb += eol;
        ta = ta.replace(/\r?\n$/, '');
      }
      return [{ start: a.s, end: bb.e, text: tb + src.slice(a.e, bb.s) + ta }];
    }
  }
}

