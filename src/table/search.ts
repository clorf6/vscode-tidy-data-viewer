// Fast find over the whole file. For resident text files in document order, large byte ranges are decoded at once
// and a global regex runs over them (native speed); only rows with a raw match are parsed and checked cell by cell.
// Everything else (sorted views, streamed files, Parquet) falls back to a per-row scan. Chunked and cancellable.
import type { TableModel } from './models';
import { CsvModel, JsonlModel, LogModel } from './models';
import { Slicer } from './sched';
import { ANSI_LINES, collapseCR, parseAnsi } from './log';

export interface MatchSpec {
  q: string;
  regex: boolean;
  matchCase: boolean;
  word: boolean;
}

export interface Compiled {
  /** Test one cell value. */
  test: (s: string) => boolean;
  /** Global prefilter over raw text decoded as Latin-1 (byte = char), for literal queries. */
  bytes?: RegExp;
  /** Global prefilter over raw text (UTF-16 strings); undefined when prefiltering is not safe. */
  raw?: RegExp;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

/**
 * Raw-text equivalents of one character: how it can appear in the file. CSV doubles quotes; JSON escapes quotes,
 * backslashes, slashes and (often) non-ASCII characters as \uXXXX.
 */
function rawForms(ch: string, kind: string, unicodeEscapes: boolean): string[] {
  const forms = [ch];
  if (kind === 'csv' && ch === '"') forms.push('""');
  if (kind === 'jsonl') {
    if (ch === '"' || ch === '\\' || ch === '/') forms.push('\\' + ch);
    if (ch === '\t') forms.push('\\t');
    if (unicodeEscapes && ch.charCodeAt(0) > 0x7e) {
      let u = '';
      for (let i = 0; i < ch.length; i++) u += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
      forms.push(u, u.toUpperCase().replace(/\\U/g, '\\u'));
    }
  }
  return forms;
}

function caseForms(ch: string, matchCase: boolean): string[] {
  if (matchCase) return [ch];
  return [...new Set([ch, ch.toLowerCase(), ch.toUpperCase()])].filter((c) => [...c].length === 1);
}

/** Literal query → prefilter pattern; `bytes` builds it over UTF-8 bytes seen as Latin-1 chars. */
function literalPattern(q: string, kind: string, matchCase: boolean, unicodeEscapes: boolean, bytes: boolean): string {
  let out = '';
  for (const ch of q) {
    const alts = new Set<string>();
    for (const c of caseForms(ch, matchCase)) for (const f of rawForms(c, kind, unicodeEscapes)) alts.add(bytes ? latin1(f) : f);
    if (!matchCase && kind === 'jsonl' && unicodeEscapes && ch.charCodeAt(0) > 0x7e)
      for (const c of caseForms(ch, false)) for (const f of rawForms(c, kind, true)) alts.add(bytes ? latin1(f) : f);
    const list = [...alts].map(esc);
    out += list.length === 1 ? list[0] : `(?:${list.join('|')})`;
  }
  return out;
}

/** Compile a search spec; returns an error message for an invalid regex. */
export function compileSpec(spec: MatchSpec, kind: string, unicodeEscapes = false): Compiled | { error: string } | undefined {
  if (!spec.q) return undefined;
  let src = spec.regex ? spec.q : esc(spec.q);
  if (spec.word) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  const flags = (spec.matchCase ? '' : 'i') + (spec.word ? 'u' : '');
  let re: RegExp;
  try {
    re = new RegExp(src, flags);
  } catch (e) {
    return { error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e) };
  }
  const out: Compiled = { test: (s) => re.test(s) };
  if (kind === 'parquet') return out;
  if (!spec.regex) {
    // literal: exact superset prefilters (case folding done per character, raw escapes included)
    // ASCII queries fold case with the regex engine (no Latin-1 character folds to ASCII, so this stays exact)
    const ascii = /^[\x00-\x7f]*$/.test(spec.q);
    const fold = ascii && !spec.matchCase;
    out.bytes = new RegExp(literalPattern(spec.q, kind, spec.matchCase || fold, unicodeEscapes, true), fold ? 'gi' : 'g');
    out.raw = new RegExp(literalPattern(spec.q, kind, spec.matchCase || fold, unicodeEscapes, false), fold ? 'gi' : 'g');
    return out;
  }
  // a user regex can prefilter raw text unless it is anchored, looks behind, or involves escaped characters
  const unsafe = /[\^$]|\(\?<[=!]/.test(spec.q) || (kind === 'csv' && spec.q.includes('"')) || (kind === 'jsonl' && (/["\\/]/.test(spec.q.replace(/\\[dDwWsSbB.]/g, '')) || unicodeEscapes));
  if (!unsafe) {
    try {
      out.raw = new RegExp(spec.q, (spec.matchCase ? '' : 'i') + 'g');
    } catch {
      /* no prefilter */
    }
  }
  return out;
}

export interface SearchScope {
  /** Visible ids in view order; null = the document order. */
  view: Uint32Array | null;
  /** The view is an ascending subset of the document order (filter without sort). */
  ascending: boolean;
}

export interface SearchOptions {
  keys: number[];
  /** Start at this view position and wrap around. */
  from: number;
  /** Extra row condition (log levels). */
  accept?: (id: number) => boolean;
  /** Called for each matching row with the logical column indices that match. Return false to stop. */
  onRow: (pos: number, id: number, cols: number[]) => boolean | void;
}

const CHUNK = 1 << 20;

function upperBound(a: Uint32Array, n: number, lo: number, hi: number, v: number): number {
  // first index in [lo, hi) with a[i] > v
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  void n;
  return lo;
}

function lowerBound(a: Uint32Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Logical column indices of `keys` whose value in this row matches. */
export function cellsMatching(model: TableModel, id: number, text: string, keys: number[], test: (s: string) => boolean): number[] {
  const out: number[] = [];
  if (model instanceof LogModel) {
    const s = parseAnsi(collapseCR(text)).text; // as displayed (also drops stray control characters)
    if (test(s)) out.push(0);
    return out;
  }
  if (model instanceof CsvModel) {
    const vals = model.valuesOf(id, text, keys);
    for (let k = 0; k < keys.length; k++) {
      const v = vals[k];
      if (v && test(v)) out.push(model.colMap.indexOf(keys[k]));
    }
    return out;
  }
  if (model instanceof JsonlModel) {
    const vals = model.valuesOf(id, text, keys);
    for (let k = 0; k < keys.length; k++) {
      const v = vals[k];
      if (v !== undefined && v !== '' && test(v)) out.push(model.colMap.indexOf(keys[k]));
    }
    return out;
  }
  return out;
}

/** Latin-1 view of resident bytes (byte offsets = char offsets; much faster to decode than UTF-8). */
function latin1Of(buf: Buffer, s: number, e: number): string {
  return (buf as unknown as { latin1Slice(s: number, e: number): string }).latin1Slice(s, e);
}

const HIGH = /[\x80-\xff]/;

/**
 * Find rows/cells matching `c`. Positions are view positions. Returns which path was used ('fast' = chunked raw
 * prefilter over document order, 'rows' = per-row scan).
 */
export async function searchRows(model: TableModel, scope: SearchScope, c: Compiled, o: SearchOptions, slicer: Slicer): Promise<'fast' | 'rows'> {
  const n = scope.view ? scope.view.length : model.count();
  if (!n) return 'rows';
  const from = Math.max(0, Math.min(n - 1, o.from));
  const text = model instanceof CsvModel || model instanceof JsonlModel || model instanceof LogModel ? model : undefined;
  const fast = !!text && !!(c.bytes || c.raw) && text.rows.resident && text.isIdentity() && !text.hasEdits() && (!scope.view || scope.ascending);
  if (fast) {
    await fastSearch(text!, scope, c, o, from, slicer);
    return 'fast';
  }
  // per-row scan in view order, starting at `from`
  const idsAt = (p: number) => (scope.view ? scope.view[p] : model.idAt(p));
  const segs: [number, number][] = from > 0 ? [[from, n], [0, from]] : [[0, n]];
  if (model instanceof CsvModel || model instanceof JsonlModel || model instanceof LogModel) {
    const r = model.rows;
    // logs: prefilter on the text without ANSI codes / control characters (they can split a displayed match)
    const pre = model instanceof LogModel ? (t: string) => t.replace(ANSI_LINES, '') : (t: string) => t;
    for (const [s, e] of segs) {
      if (!r.resident && !scope.view) {
        // streamed file in document order: sequential chunked reads
        let stop = false;
        const f = model.first();
        await r.forEach(f + s, f + e, slicer, (i, t) => {
          if (stop) return;
          if (o.accept && !o.accept(i)) return;
          if (c.raw) {
            c.raw.lastIndex = 0;
            if (!c.raw.test(pre(t))) return;
          }
          const cols = cellsMatching(model, i, t, o.keys, c.test);
          if (cols.length && o.onRow(i - f, i, cols) === false) stop = true;
        });
        if (stop) return 'rows';
        continue;
      }
      for (let p = s; p < e; p++) {
        if (slicer.due()) await slicer.yieldNow();
        const id = idsAt(p);
        if (o.accept && !o.accept(id)) continue;
        const edited = id >= 0x40000000 || model.isEdited(id);
        if (r.resident && !edited) {
          // cheap Latin-1 prefilter before decoding the row
          if (c.bytes) {
            c.bytes.lastIndex = 0;
            if (!c.bytes.test(pre(latin1Of(r.buf, r.idx.starts[id], r.idx.ends[id])))) continue;
          } else if (c.raw) {
            const l = pre(latin1Of(r.buf, r.idx.starts[id], r.idx.ends[id]));
            c.raw.lastIndex = 0;
            if (!HIGH.test(l) && !c.raw.test(l)) continue;
          }
        }
        const t = id >= 0x40000000 ? '' : await r.textAsync(id);
        if (!r.resident && c.raw && !edited) {
          c.raw.lastIndex = 0;
          if (!c.raw.test(pre(t))) continue;
        }
        const cols = cellsMatching(model, id, t, o.keys, c.test);
        if (cols.length && o.onRow(p, id, cols) === false) return 'rows';
      }
    }
    return 'rows';
  }
  // Parquet (and anything else): column scan. For a reordered view the scan reports rows in document order, so
  // collect the hits and replay them in view order from `from`.
  const keys = o.keys;
  const view = scope.view ?? model.orderArray();
  const colIdx = keys.map((k) => model.columns.findIndex((col) => col.key === k));
  let stopped = false;
  const later: [number, number, number[]][] | undefined = scope.view && !scope.ascending ? [] : undefined;
  await model.scan(
    view,
    keys,
    slicer,
    (pos, id, vals) => {
      if (stopped) return;
      const cols: number[] = [];
      for (let k = 0; k < vals.length; k++) {
        const v = vals[k];
        if (v !== undefined && v !== '' && c.test(v)) cols.push(colIdx[k]);
      }
      if (!cols.length) return;
      if (later) later.push([pos, id, cols]);
      else if (o.onRow(pos, id, cols) === false) stopped = true;
    },
    !scope.view,
  );
  if (later) {
    later.sort((a, b) => a[0] - b[0]);
    const k0 = later.findIndex((h) => h[0] >= from);
    const ordered = k0 <= 0 ? later : [...later.slice(k0), ...later.slice(0, k0)];
    for (let i = 0; i < ordered.length; i++) {
      const [pos, id, cols] = ordered[i];
      if (o.onRow(pos, id, cols) === false) break;
      if ((i & 4095) === 4095) await slicer.maybe();
    }
  }
  return 'rows';
}

async function fastSearch(model: CsvModel | JsonlModel | LogModel, scope: SearchScope, c: Compiled, o: SearchOptions, from: number, slicer: Slicer): Promise<void> {
  const r = model.rows;
  const starts = r.idx.starts;
  const ends = r.idx.ends;
  const first = model.first();
  const total = r.idx.n;
  const view = scope.view;
  // document-row ranges to scan, starting where the view position `from` is
  const startId = view ? view[from] : first + from;
  const segs: [number, number][] = startId > first ? [[startId, total], [first, startId]] : [[first, total]];
  const isLog = model instanceof LogModel;
  const visit = (row: number): boolean => {
    if (o.accept && !o.accept(row)) return true;
    let pos: number;
    if (view) {
      const k = lowerBound(view, row);
      if (k >= view.length || view[k] !== row) return true;
      pos = k;
    } else pos = row - first;
    const cols = cellsMatching(model, row, r.text(row), o.keys, c.test);
    return !cols.length || o.onRow(pos, row, cols) !== false;
  };
  for (const [s0, e0] of segs) {
    let i0 = s0;
    while (i0 < e0) {
      // a chunk of whole rows, about CHUNK bytes
      const target = starts[i0] + CHUNK;
      let i1 = upperBound(starts, total, i0 + 1, e0, target);
      if (i1 <= i0) i1 = i0 + 1;
      const b0 = starts[i0];
      const b1 = ends[i1 - 1];
      const L = latin1Of(r.buf, b0, b1);
      if (isLog && L.indexOf('\x1b') >= 0) {
        // ANSI codes can split a match in the raw text: search the chunk with the codes stripped (line breaks are
        // kept, so the n-th line is row i0 + n) — a superset of the per-row display text; visit() checks exactly
        const g = c.bytes ?? c.raw!;
        const S = (c.bytes || !HIGH.test(L) ? L : r.buf.toString('utf8', b0, b1)).replace(ANSI_LINES, '');
        g.lastIndex = 0;
        let row = i0;
        let nlPos = 0;
        let guard = 0;
        for (let m = g.exec(S); m; m = g.exec(S)) {
          if (m[0] === '') {
            g.lastIndex++;
            if (++guard > 1e6) break;
            continue;
          }
          for (let nl = S.indexOf('\n', nlPos); nl >= 0 && nl < m.index; nl = S.indexOf('\n', nlPos)) {
            row++;
            nlPos = nl + 1;
          }
          if (row >= i1) break;
          if (!visit(row)) return;
          const nl = S.indexOf('\n', m.index);
          if (nl < 0) break;
          g.lastIndex = nl + 1;
          if (slicer.due()) await slicer.yieldNow();
        }
      } else {
        // byte-offset matches on the Latin-1 view; a regex over non-ASCII text needs the real (UTF-16) string
        let g = c.bytes;
        let S = L;
        let utf16 = false;
        if (!g) {
          g = c.raw!;
          if (HIGH.test(L)) {
            S = r.buf.toString('utf8', b0, b1);
            utf16 = true;
          }
        }
        g.lastIndex = 0;
        let lastChar = 0;
        let lastByte = b0;
        let lastRow = -1;
        let guard = 0;
        for (let m = g.exec(S); m; m = g.exec(S)) {
          if (m[0] === '') {
            g.lastIndex++;
            if (++guard > 1e6) break;
            continue;
          }
          let byte: number;
          if (!utf16) byte = b0 + m.index;
          else {
            byte = lastByte + Buffer.byteLength(S.slice(lastChar, m.index));
            lastChar = m.index;
            lastByte = byte;
          }
          const row = upperBound(starts, total, i0, i1, byte) - 1;
          if (row !== lastRow && row >= i0) {
            lastRow = row;
            if (!visit(row)) return;
            if (slicer.due()) await slicer.yieldNow();
          }
          // continue after the end of this line
          if (!utf16) g.lastIndex = Math.max(g.lastIndex, ends[row] - b0);
          else {
            const nl = S.indexOf('\n', m.index);
            g.lastIndex = nl < 0 ? S.length : nl + 1;
          }
        }
      }
      i0 = i1;
      await slicer.maybe();
    }
  }
}
