// XML (read-only tree): elements with their attributes (@attr), text, CDATA and comments, in document order.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Builder, LineIndex, Store } from './model';
import { Kind, KeyKind } from './protocol';

export interface XmlError {
  offset: number;
  line: number;
  col: number;
  message: string;
}

export interface XmlResult {
  store: Store;
  errors: XmlError[];
}

type XNode = Record<string, unknown>;

/** Offsets of start tags in document order (the k-th element of the tree is the k-th start tag). */
function startTags(text: string): number[] {
  const out: number[] = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|<([A-Za-z_][\w.:-]*)/g;
  for (let m; (m = re.exec(text)); ) if (m[1]) out.push(m.index);
  return out;
}

export function parseXml(text: string): XmlResult {
  const errors: XmlError[] = [];
  const v = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (v !== true) {
    const li = new LineIndex(text);
    const off = li.offset(v.err.line, v.err.col);
    errors.push({ offset: off, line: v.err.line, col: v.err.col, message: v.err.msg });
  }
  let doc: XNode[] = [];
  try {
    const p = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      allowBooleanAttributes: true,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      commentPropName: '#comment',
      cdataPropName: '#cdata',
      processEntities: true,
      ignoreDeclaration: false,
      ignorePiTags: false,
    });
    doc = p.parse(text) as XNode[];
  } catch (err) {
    if (!errors.length) errors.push({ offset: 0, line: 1, col: 1, message: String((err as Error).message ?? err) });
    doc = [];
  }
  const tags = errors.length ? [] : startTags(text);
  let tagIdx = 0;
  const b = new Builder(text, 256, true);
  b.open(Kind.Obj, KeyKind.None, -1, -1, 0);

  const textOf = (arr: unknown): string => (Array.isArray(arr) ? arr.map((x) => String((x as XNode)['#text'] ?? '')).join('') : '');

  const emit = (n: XNode) => {
    const attrs = (n[':@'] ?? {}) as Record<string, unknown>;
    const name = Object.keys(n).find((k) => k !== ':@')!;
    const body = n[name];
    if (name === '#text') {
      b.leaf(Kind.Str, KeyKind.Text, -1, -1, -1, -1, '#text', String(body));
      return;
    }
    if (name === '#comment') {
      b.leaf(Kind.Comment, KeyKind.Text, -1, -1, -1, -1, '#comment', textOf(body).trim());
      return;
    }
    if (name === '#cdata') {
      const id = b.leaf(Kind.Str, KeyKind.Text, -1, -1, -1, -1, '#cdata', textOf(body));
      b.setMeta(id, { flavor: 'cdata' });
      return;
    }
    if (name.startsWith('?')) {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${String(v)}"`)
        .join(' ');
      b.leaf(Kind.Str, KeyKind.Decl, -1, -1, -1, -1, name, a);
      return;
    }
    const pos = tags[tagIdx++] ?? -1;
    const kids = Array.isArray(body) ? (body as XNode[]) : [];
    const attrList = Object.entries(attrs);
    // <title>Text</title> collapses to a leaf
    if (!attrList.length && kids.length === 1 && '#text' in kids[0]) {
      const id = b.leaf(Kind.Str, KeyKind.Elem, pos, pos, pos, pos, name, String(kids[0]['#text']));
      b.setMeta(id, { flavor: 'leaf', ro: true });
      return;
    }
    const id = b.open(Kind.Obj, KeyKind.Elem, pos, pos, pos, name);
    b.setMeta(id, { flavor: 'elem', ro: true });
    for (const [k, val] of attrList) b.leaf(val === true ? Kind.True : Kind.Str, KeyKind.Attr, -1, -1, -1, -1, k, val === true ? 'true' : String(val));
    for (const c of kids) emit(c);
    b.close(pos);
  };
  for (const n of doc) emit(n);
  const store = b.finish();
  return { store, errors };
}

const esc = (s: string, attr = false) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(attr ? /"/g : /(?!)/g, '&quot;');

/** Serialise a subtree back to (indented) XML for "Copy as XML". */
export function toXml(st: Store, id: number, indent = 2): string {
  const pad = (d: number) => ' '.repeat(d * indent);
  const out: string[] = [];
  const rec = (i: number, d: number) => {
    const kk = st.kk[i];
    const key = String(st.key(i) ?? '');
    if (kk === KeyKind.None) {
      for (let c = st.firstChild(i); c >= 0; c = st.nextSibling(c)) rec(c, d);
      return;
    }
    if (kk === KeyKind.Attr) return;
    if (kk === KeyKind.Decl) return void out.push(`${pad(d)}<${key} ${st.text(i)}?>`);
    if (kk === KeyKind.Text) {
      if (key === '#comment') out.push(`${pad(d)}<!-- ${st.text(i)} -->`);
      else if (key === '#cdata') out.push(`${pad(d)}<![CDATA[${st.text(i)}]]>`);
      else out.push(pad(d) + esc(st.text(i)));
      return;
    }
    if (!st.isContainer(i)) return void out.push(`${pad(d)}<${key}>${esc(st.text(i))}</${key}>`);
    const attrs: number[] = [];
    const kids: number[] = [];
    for (let c = st.firstChild(i); c >= 0; c = st.nextSibling(c)) (st.kk[c] === KeyKind.Attr ? attrs : kids).push(c);
    const a = attrs.map((c) => ` ${String(st.key(c))}="${esc(st.text(c), true)}"`).join('');
    if (!kids.length) return void out.push(`${pad(d)}<${key}${a}/>`);
    out.push(`${pad(d)}<${key}${a}>`);
    for (const c of kids) rec(c, d + 1);
    out.push(`${pad(d)}</${key}>`);
  };
  rec(id, 0);
  return out.join('\n');
}
