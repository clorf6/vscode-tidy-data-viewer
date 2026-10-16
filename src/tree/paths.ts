// Path formatting: JSONPath, JavaScript accessors, jq filters, JSON Pointer and (for XML) XPath.
import { Store, Path } from './model';
import { KeyKind, PathStyle } from './protocol';

const JS_IDENT = /^[A-Za-z_$][\w$]*$/;
const JQ_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function jsonPath(path: Path): string {
  let out = '$';
  for (const s of path) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (JS_IDENT.test(s)) out += '.' + s;
    else out += `['${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  return out;
}

export function jsPath(path: Path): string {
  let out = '';
  for (const s of path) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (JS_IDENT.test(s)) out += (out ? '.' : '') + s;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

export function jqPath(path: Path): string {
  let out = '';
  for (const s of path) {
    if (typeof s === 'number') out += (out ? '' : '.') + `[${s}]`;
    else if (JQ_IDENT.test(s)) out += '.' + s;
    else out += '.' + JSON.stringify(s);
  }
  return out || '.';
}

export function jsonPointer(path: Path): string {
  return path.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/** XPath of an XML node: /root/child[2]/@attr, /root/text(). */
export function xPath(st: Store, id: number): string {
  const parts: string[] = [];
  for (let c = id; c > 0 && st.parent[c] >= 0; c = st.parent[c]) {
    const kk = st.kk[c];
    const key = String(st.key(c) ?? '');
    if (kk === KeyKind.Attr) parts.push('@' + key);
    else if (kk === KeyKind.Elem) {
      const p = st.parent[c];
      let n = 0;
      let idx = 0;
      for (let s = st.firstChild(p); s >= 0; s = st.nextSibling(s)) {
        if (st.kk[s] === KeyKind.Elem && String(st.key(s)) === key) {
          n++;
          if (s === c) idx = n;
        }
      }
      parts.push(n > 1 ? `${key}[${idx}]` : key);
    } else if (kk === KeyKind.Text) parts.push(key === '#comment' ? 'comment()' : 'text()');
    else if (kk === KeyKind.Decl) parts.push('processing-instruction()');
    else parts.push(key);
  }
  return '/' + parts.reverse().join('/');
}

export function formatPath(st: Store, id: number, style: PathStyle): string {
  if (style === 'xpath') return xPath(st, id);
  const path = st.path(id);
  switch (style) {
    case 'jsonpath':
      return jsonPath(path);
    case 'js':
      return jsPath(path);
    case 'jq':
      return jqPath(path);
    case 'pointer':
      return jsonPointer(path);
  }
}
