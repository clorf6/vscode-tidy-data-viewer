// Delimited text: RFC 4180 field parsing (lenient), delimiter sniffing, header detection, serialization.

import { inferType, isPlaceholder, matchesType } from './infer';

/**
 * Split one record (without its line ending) into fields. Quotes are only special at the start of a field; `""`
 * inside a quoted field is an escaped quote; text after a closing quote is kept (lenient, like most readers).
 * If `quoted` is given it receives, per field, whether the field was quoted.
 */
export function parseRow(s: string, delim: string, quoted?: boolean[]): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  for (;;) {
    if (s.charCodeAt(i) === 34) {
      let val = '';
      let j = i + 1;
      for (;;) {
        const q = s.indexOf('"', j);
        if (q < 0) {
          val += s.slice(j);
          i = n;
          break;
        }
        if (s.charCodeAt(q + 1) === 34) {
          val += s.slice(j, q + 1);
          j = q + 2;
          continue;
        }
        val += s.slice(j, q);
        i = q + 1;
        break;
      }
      const d = s.indexOf(delim, i);
      if (d < 0) {
        if (i < n) val += s.slice(i);
        out.push(val);
        quoted?.push(true);
        return out;
      }
      if (d > i) val += s.slice(i, d);
      out.push(val);
      quoted?.push(true);
      i = d + 1;
    } else {
      const d = s.indexOf(delim, i);
      if (d < 0) {
        out.push(i <= n ? s.slice(i) : '');
        quoted?.push(false);
        return out;
      }
      out.push(s.slice(i, d));
      quoted?.push(false);
      i = d + 1;
    }
  }
}

/** Fields up to and including index `upTo` (cheaper for filters/sort on early columns). */
export function parseRowPrefix(s: string, delim: string, upTo: number): string[] {
  if (s.indexOf('"') < 0) {
    const out: string[] = [];
    let i = 0;
    for (let k = 0; k <= upTo; k++) {
      const d = s.indexOf(delim, i);
      if (d < 0) {
        out.push(s.slice(i));
        break;
      }
      out.push(s.slice(i, d));
      i = d + 1;
    }
    return out;
  }
  return parseRow(s, delim);
}

export function needsQuote(v: string, delim: string): boolean {
  return v.includes(delim) || v.includes('"') || v.includes('\n') || v.includes('\r');
}

export function quoteField(v: string, delim: string, force = false): string {
  if (force || needsQuote(v, delim)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function serializeRow(fields: string[], delim: string, quoted?: (boolean | undefined)[]): string {
  let s = '';
  for (let i = 0; i < fields.length; i++) {
    if (i) s += delim;
    s += quoteField(fields[i] ?? '', delim, !!quoted?.[i]);
  }
  return s;
}

/** Split text into records (quote-aware). The last record is dropped if `dropPartial` (it may be cut off). */
export function splitRecords(text: string, max: number, dropPartial: boolean): string[] {
  const out: string[] = [];
  let start = 0;
  let inQ = false;
  for (let i = 0; i < text.length && out.length < max; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) inQ = !inQ;
    else if (c === 10 && !inQ) {
      let e = i;
      if (e > start && text.charCodeAt(e - 1) === 13) e--;
      out.push(text.slice(start, e));
      start = i + 1;
    }
  }
  if (out.length < max && start < text.length && !dropPartial) out.push(text.slice(start).replace(/\r$/, ''));
  return out;
}

export const DELIMS = [',', '\t', ';', '|'];

/** Pick the delimiter that splits the sample into the most consistent number of fields. */
export function sniffDelimiter(sample: string, fallback = ','): string {
  const recs = splitRecords(sample, 60, sample.length >= 65536).filter((r) => r.length > 0);
  if (!recs.length) return fallback;
  let best = fallback;
  let bestScore = 0;
  for (const d of DELIMS) {
    const counts = new Map<number, number>();
    for (const r of recs) {
      const n = parseRow(r, d).length;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    let mode = 1;
    let freq = 0;
    for (const [n, f] of counts) if (f > freq || (f === freq && n > mode)) (mode = n), (freq = f);
    if (mode < 2) continue;
    const consistency = freq / recs.length;
    const score = consistency * (1 + Math.min(Math.log2(mode), 6) / 6) + (d === fallback ? 0.01 : 0);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Delimiter implied by the file name; `undefined` → sniff. */
export function delimiterForName(name: string): string | undefined {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'tsv' || ext === 'tab') return '\t';
  if (ext === 'psv') return '|';
  return undefined;
}

/**
 * Does the first record look like a header? Votes per column: typed data (numbers, dates, bools) under a header cell
 * that is not of that type → header; a first cell of the same type as the data → not a header.
 */
export function detectHeader(rows: string[][]): boolean {
  if (!rows.length) return false;
  const first = rows[0];
  const data = rows.slice(1);
  const nonEmpty = first.filter((v) => v.trim() !== '');
  if (!nonEmpty.length) return false;
  if (!data.length) return first.every((v) => !matchesType(v.trim(), 'float'));
  let votes = 0;
  for (let c = 0; c < first.length; c++) {
    const col = data.map((r) => r[c] ?? '');
    const type = inferType(col);
    const h = (first[c] ?? '').trim();
    if (type === 'int' || type === 'float' || type === 'date' || type === 'bool') {
      if (h === '' || isPlaceholder(h)) continue;
      votes += matchesType(h, type) ? -1 : 1;
    } else if (type === 'string' && h !== '') {
      // header cells rarely repeat a value of their own column
      if (col.includes(first[c])) votes -= 0.5;
    }
  }
  if (votes > 0) return true;
  if (votes < 0) return false;
  // All-text table: header unless the first row has empties/duplicates or numbers.
  if (nonEmpty.length < first.length) return false;
  if (new Set(first).size < first.length) return false;
  if (first.some((v) => matchesType(v.trim(), 'float'))) return false;
  return true;
}

/** Column names for a table without header: A, B, …, Z, AA, … */
export function letterName(i: number): string {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** Dominant line ending of a sample. */
export function detectEol(sample: Uint8Array): '\n' | '\r\n' {
  let lf = 0;
  let crlf = 0;
  const n = Math.min(sample.length, 1 << 20);
  for (let i = 0; i < n; i++)
    if (sample[i] === 10) {
      if (i > 0 && sample[i - 1] === 13) crlf++;
      else lf++;
    }
  return crlf > lf ? '\r\n' : '\n';
}

export function delimiterLabel(d: string): string {
  return d === '\t' ? 'Tab' : d === ',' ? 'Comma' : d === ';' ? 'Semicolon' : d === '|' ? 'Pipe' : d;
}

// ------------------------------------------------------------------------------------------------------------------
// Export / copy formats

export function toMarkdown(header: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = ['| ' + header.map(esc).join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
  for (const r of rows) lines.push('| ' + header.map((_, i) => esc(r[i] ?? '')).join(' | ') + ' |');
  return lines.join('\n') + '\n';
}

export function tsvField(v: string): string {
  return /[\t\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
