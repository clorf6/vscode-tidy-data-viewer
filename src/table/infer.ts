// Column type inference and typed comparison keys.
import type { ColType } from './protocol';

const INT = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$|^[-+]?(?:inf|Infinity)$/i;
const DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?: ?(?:Z|[+-]\d{2}:?\d{2}|UTC))?)?$|^\d{4}\/\d{1,2}\/\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;
const BOOL = /^(?:true|false)$/i;
const PLACEHOLDER = /^(?:na|n\/a|nan|null|none|nil|-|—|\?)$/i;

export function isPlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v);
}

export function matchesType(v: string, t: ColType): boolean {
  switch (t) {
    case 'int':
      return INT.test(v);
    case 'float':
      return INT.test(v) || FLOAT.test(v);
    case 'date':
      return DATE.test(v) && !isNaN(Date.parse(v.replace(' ', 'T').replace(/ ?UTC$/, 'Z')));
    case 'bool':
      return BOOL.test(v);
    case 'json': {
      const c = v.charCodeAt(0);
      const e = v.charCodeAt(v.length - 1);
      return (c === 123 && e === 125) || (c === 91 && e === 93);
    }
    default:
      return true;
  }
}

/** Infer a column type from sample values: every non-empty, non-placeholder value must match. */
export function inferType(values: ArrayLike<string | undefined>): ColType {
  let n = 0;
  let int = 0;
  let float = 0;
  let date = 0;
  let bool = 0;
  let json = 0;
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (raw === undefined) continue;
    const v = raw.trim();
    if (v === '' || PLACEHOLDER.test(v)) continue;
    n++;
    if (INT.test(v)) int++;
    else if (FLOAT.test(v)) float++;
    else if (BOOL.test(v)) bool++;
    else if (matchesType(v, 'date')) date++;
    else if (matchesType(v, 'json')) json++;
    else return 'string';
  }
  if (n === 0) return 'empty';
  if (int === n) return 'int';
  if (int + float === n) return 'float';
  if (bool === n) return 'bool';
  if (date === n) return 'date';
  if (json === n) return 'json';
  return 'string';
}

/** Infer from JSON kinds (s n b z o a u) plus string values. */
export function inferJsonType(kinds: string[], values: string[]): ColType {
  let n = 0;
  let num = 0;
  let int = 0;
  let bool = 0;
  let obj = 0;
  let str = 0;
  const strs: string[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    if (k === 'z' || k === 'u') continue;
    n++;
    if (k === 'n') {
      num++;
      if (INT.test(values[i])) int++;
    } else if (k === 'b') bool++;
    else if (k === 'o' || k === 'a') obj++;
    else {
      str++;
      strs.push(values[i]);
    }
  }
  if (!n) return 'empty';
  if (num === n) return int === n ? 'int' : 'float';
  if (bool === n) return 'bool';
  if (obj === n) return 'json';
  if (str === n) {
    const t = inferType(strs);
    return t === 'date' ? 'date' : 'string';
  }
  return 'string';
}

export function toNumber(v: string | undefined): number {
  if (v === undefined || v === '') return NaN;
  const n = +v;
  if (n === n) return n !== 0 || /\d/.test(v) ? n : NaN;
  const s = v.trim();
  if (/^[-+]?inf$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  return NaN;
}

const d2 = (s: string, i: number) => (s.charCodeAt(i) - 48) * 10 + s.charCodeAt(i + 1) - 48;

/** Epoch ms for ISO-like dates (fast path: YYYY-MM-DD[ T]hh:mm[:ss[.fff]][Z|±hh:mm], read as UTC), else Date.parse. */
export function toDate(v: string | undefined): number {
  if (v === undefined) return NaN;
  const s = v.length && (v.charCodeAt(0) === 32 || v.charCodeAt(v.length - 1) === 32) ? v.trim() : v;
  if (!s) return NaN;
  const n = s.length;
  if (n >= 10 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45) {
    const y = d2(s, 0) * 100 + d2(s, 2);
    const mo = d2(s, 5);
    const day = d2(s, 8);
    let h = 0;
    let mi = 0;
    let sec = 0;
    let ms = 0;
    let i = 10;
    if (n > 10 && (s[10] === 'T' || s[10] === ' ') && n >= 16) {
      h = d2(s, 11);
      mi = d2(s, 14);
      i = 16;
      if (s[16] === ':') {
        sec = d2(s, 17);
        i = 19;
        if (s[19] === '.' || s[19] === ',') {
          let j = 20;
          let f = 0;
          let scale = 100;
          while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
            if (scale >= 1) f += (s.charCodeAt(j) - 48) * scale;
            scale /= 10;
            j++;
          }
          ms = f;
          i = j;
        }
      }
    }
    let off = 0;
    if (i < n) {
      const rest = s.slice(i).trim();
      if (rest === 'Z' || rest === 'UTC' || rest === '') off = 0;
      else {
        const m = /^([+-])(\d{2}):?(\d{2})$/.exec(rest);
        if (!m) return Date.parse(s);
        off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
      }
    }
    const t = Date.UTC(y, mo - 1, day, h, mi, sec, ms) - off * 60000;
    return t === t && mo >= 1 && mo <= 12 && day >= 1 && day <= 31 ? t : Date.parse(s);
  }
  return Date.parse(s.replace(/^(\d{4}\/\d{1,2}\/\d{1,2}) /, '$1T'));
}

export function isNumericType(t: ColType): boolean {
  return t === 'int' || t === 'float';
}

/** Numeric sort key for typed columns, NaN when not comparable as a number. */
export function numericKey(v: string | undefined, t: ColType): number {
  if (t === 'int' || t === 'float') return toNumber(v);
  if (t === 'date') return toDate(v);
  if (t === 'bool') {
    if (v === undefined) return NaN;
    const s = v.trim().toLowerCase();
    return s === 'true' ? 1 : s === 'false' ? 0 : NaN;
  }
  return NaN;
}
