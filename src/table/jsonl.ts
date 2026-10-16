// JSON Lines: a lenient top-level object scanner that keeps raw value text (big integers and formatting survive),
// compact display of nested values, and in-place line rewriting for edits.

export interface Member {
  key: string;
  /** key token range (including quotes) */
  ks: number;
  ke: number;
  /** raw value range */
  vs: number;
  ve: number;
  /** s n b z o a */
  kind: string;
}

function skipWs(s: string, i: number): number {
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
    else return i;
  }
}

function skipString(s: string, i: number): number {
  // s[i] === '"'
  for (let j = i + 1; ; ) {
    const q = s.indexOf('"', j);
    if (q < 0) return -1;
    let bs = 0;
    for (let k = q - 1; k > i && s.charCodeAt(k) === 92; k--) bs++;
    if (bs % 2 === 0) return q + 1;
    j = q + 1;
  }
}

/** End of the JSON value starting at i (lenient). */
function skipValue(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === 34) return skipString(s, i);
  if (c === 123 || c === 91) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s.charCodeAt(j);
      if (d === 34) {
        j = skipString(s, j) - 1;
        if (j < 0) return -1;
      } else if (d === 123 || d === 91) depth++;
      else if (d === 125 || d === 93) {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d === 44 || d === 125 || d === 93 || d === 32 || d === 9 || d === 13 || d === 10) break;
    j++;
  }
  return j > i ? j : -1;
}

export function kindOf(s: string, i: number): string {
  const c = s.charCodeAt(i);
  if (c === 34) return 's';
  if (c === 123) return 'o';
  if (c === 91) return 'a';
  if (c === 116 || c === 102) return 'b';
  if (c === 110) return 'z';
  return 'n';
}

/**
 * Members of a top-level object, or null when the line is not an object (or is malformed). With `want`, stops as soon
 * as every wanted key was seen (only for lines known to be valid JSON — a partial scan cannot spot later errors).
 */
export function scanObject(s: string, want?: Set<string>): Member[] | null {
  let need = want ? want.size : 0;
  const seen = want && new Set<string>();
  let i = skipWs(s, 0);
  if (s.charCodeAt(i) !== 123) return null;
  i = skipWs(s, i + 1);
  const out: Member[] = [];
  if (s.charCodeAt(i) === 125) return skipWs(s, i + 1) >= s.length ? out : null;
  for (;;) {
    if (s.charCodeAt(i) !== 34) return null;
    const ke = skipString(s, i);
    if (ke < 0) return null;
    let key: string;
    const raw = s.slice(i + 1, ke - 1);
    if (raw.indexOf('\\') < 0) key = raw;
    else
      try {
        key = JSON.parse(s.slice(i, ke));
      } catch {
        return null;
      }
    let j = skipWs(s, ke);
    if (s.charCodeAt(j) !== 58) return null;
    j = skipWs(s, j + 1);
    const ve = skipValue(s, j);
    if (ve < 0) return null;
    out.push({ key, ks: i, ke, vs: j, ve, kind: kindOf(s, j) });
    if (seen && want!.has(key) && !seen.has(key)) {
      seen.add(key);
      if (--need === 0) return out;
    }
    j = skipWs(s, ve);
    const c = s.charCodeAt(j);
    if (c === 44) {
      i = skipWs(s, j + 1);
      continue;
    }
    if (c === 125) return skipWs(s, j + 1) >= s.length ? out : null;
    return null;
  }
}

/** Remove insignificant whitespace (outside strings). */
export function compactJson(raw: string): string {
  if (!/\s/.test(raw)) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 34) {
      const e = skipString(raw, i);
      const end = e < 0 ? raw.length : e;
      out += raw.slice(i, end);
      i = end - 1;
    } else if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    else out += raw[i];
  }
  return out;
}

/** Display text of a raw JSON value. */
export function displayValue(raw: string, kind: string): string {
  if (kind === 's') {
    if (raw.indexOf('\\') < 0) return raw.slice(1, -1);
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (kind === 'o' || kind === 'a') return compactJson(raw);
  return raw;
}

/** Pretty-printed JSON for the detail panel (keeps big integers by working on the raw text). */
export function prettyJson(raw: string, indent = 2): string {
  let out = '';
  let depth = 0;
  const nl = () => '\n' + ' '.repeat(depth * indent);
  const s = compactJson(raw);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      const e = skipString(s, i);
      const end = e < 0 ? s.length : e;
      out += s.slice(i, end);
      i = end - 1;
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      if (s[i + 1] === close) {
        out += c + close;
        i++;
        continue;
      }
      depth++;
      out += c + nl();
    } else if (c === '}' || c === ']') {
      depth--;
      out += nl() + c;
    } else if (c === ',') out += ',' + nl();
    else if (c === ':') out += ': ';
    else out += c;
  }
  return out;
}

const NUM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** Turn user input into raw JSON, guided by the previous kind of the value (and the column type). */
export function inputToRaw(text: string, prevKind: string, numericCol = false): string {
  const t = text.trim();
  if (prevKind === 'o' || prevKind === 'a') {
    try {
      JSON.parse(t);
      return compactJson(t);
    } catch {
      return JSON.stringify(text);
    }
  }
  if (prevKind === 'n' || prevKind === 'z' || (prevKind === 'u' && numericCol)) {
    if (NUM.test(t)) return t;
    if (prevKind !== 'u' && (t === '' || t === 'null')) return 'null';
  }
  if (prevKind === 'b' || prevKind === 'z' || prevKind === 'n') {
    if (t === 'true' || t === 'false') return t;
  }
  if (prevKind === 'z' && t === 'null') return 'null';
  return JSON.stringify(text);
}

export interface LineChange {
  /** key → new raw value (undefined = delete the member) */
  set?: Map<string, string | undefined>;
  /** key → new key name */
  rename?: Map<string, string>;
}

/** Rewrite one object line. Value/key replacements keep the formatting of everything else; deletions and
 * additions rebuild the object with the line's own separator style. */
export function rewriteLine(line: string, members: Member[], ch: LineChange): string {
  const structural = ch.set && [...ch.set].some(([k, v]) => v === undefined || !members.some((m) => m.key === k));
  if (!structural) {
    const edits: [number, number, string][] = [];
    for (const m of members) {
      if (ch.set?.has(m.key)) edits.push([m.vs, m.ve, ch.set.get(m.key)!]);
      const nk = ch.rename?.get(m.key);
      if (nk !== undefined) edits.push([m.ks, m.ke, JSON.stringify(nk)]);
    }
    edits.sort((a, b) => b[0] - a[0]);
    let out = line;
    for (const [s, e, r] of edits) out = out.slice(0, s) + r + out.slice(e);
    return out;
  }
  const sepComma = members.length > 1 && /,\s/.test(line.slice(members[0].ve, members[1].ks)) ? ', ' : ',';
  const colon = members[0] && line.slice(members[0].ke, members[0].vs).includes(' ') ? ': ' : ':';
  const pad = /^\s*\{\s/.test(line) ? ' ' : '';
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    seen.add(m.key);
    const nv = ch.set?.has(m.key) ? ch.set.get(m.key) : line.slice(m.vs, m.ve);
    if (nv === undefined) continue;
    const nk = ch.rename?.get(m.key);
    parts.push((nk !== undefined ? JSON.stringify(nk) : line.slice(m.ks, m.ke)) + colon + nv);
  }
  if (ch.set) for (const [k, v] of ch.set) if (!seen.has(k) && v !== undefined) parts.push(JSON.stringify(ch.rename?.get(k) ?? k) + colon + v);
  return parts.length ? '{' + pad + parts.join(sepComma) + pad + '}' : '{}';
}

/** Build a line for a new object. */
export function objectLine(pairs: [string, string][]): string {
  return '{' + pairs.map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}';
}
