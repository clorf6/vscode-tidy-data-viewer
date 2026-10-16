// Row renderers: tree rows, table header/rows, pretty text lines (JSON / YAML / XML) and the INI/.env table look.
// All file content goes in through textContent.
import { h, icon, nf, t } from '../shared/vscode';
import { Kind, KeyKind, RowKind } from '../../src/tree/protocol';
import type { Cell, Row, Syntax } from '../../src/tree/protocol';
import { colorOf, epochTime, isoTime, isUrl, timeTooltip } from './hints';

export const IND = 16;

export interface Ctx {
  mode: 'tree' | 'pretty';
  syntax: Syntax;
  layout: 'tree' | 'ini';
  sel: number;
  focused: boolean;
  re?: RegExp;
  keyWidth: number;
  /** pretty mode indentation unit (characters) */
  indent: number;
  /** px per monospace character */
  ch: number;
  /** first row and depth of the selected container's subtree (active indent guide) */
  guide?: { from: number; to: number; depth: number };
  gutter: number;
  readOnly: boolean;
}

const KIND_CLASS: Record<number, string> = {
  [Kind.Str]: 'v-str',
  [Kind.Num]: 'v-num',
  [Kind.True]: 'v-bool',
  [Kind.False]: 'v-bool',
  [Kind.Null]: 'v-null',
  [Kind.Alias]: 'v-alias',
  [Kind.Comment]: 'v-comment',
  [Kind.Date]: 'v-date',
};

/** Text with search hits wrapped in <mark>. */
export function hl(text: string, re: RegExp | undefined, cls?: string): HTMLElement {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  if (!re || !text) {
    span.textContent = text;
    return span;
  }
  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 200) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) span.append(text.slice(last, m.index));
    const mark = document.createElement('mark');
    mark.className = 'dv-hit';
    mark.textContent = m[0];
    span.append(mark);
    last = m.index + m[0].length;
  }
  if (last < text.length) span.append(text.slice(last));
  return span;
}

/** Display text for a string value: control characters made visible. */
function visible(s: string): string {
  return s.replace(/\r\n|\n|\r/g, '↵').replace(/\t/g, '→');
}

function chevron(row: Row): HTMLElement {
  const tw = h('span', { class: 'tw' });
  if ((row.t === Kind.Obj || row.t === Kind.Arr) && row.n) {
    tw.append(icon('chevronRight', 14));
    tw.classList.add('can');
    if (row.x) tw.classList.add('open');
  }
  return tw;
}

function indent(d: number, ctx: Ctx, r: number): HTMLElement {
  const ind = h('span', { class: 'ind' });
  ind.style.width = d * IND + 'px';
  const g = ctx.guide;
  if (g && r > g.from && r <= g.to && d > g.depth) {
    const a = h('span', { class: 'ag' });
    a.style.left = g.depth * IND + 7.5 + 'px';
    ind.append(a);
  }
  return ind;
}

export function keyLabel(row: Row): string {
  const k = row.k;
  switch (row.kk) {
    case KeyKind.Index:
      return String(k);
    case KeyKind.Doc:
      return t('Document {0}', Number(k) + 1);
    default:
      return k === undefined ? '' : String(k);
  }
}

function keyEl(row: Row, ctx: Ctx): HTMLElement | null {
  if (row.kk === KeyKind.None) return null;
  const label = keyLabel(row);
  switch (row.kk) {
    case KeyKind.Index:
      return h('span', { class: 'k k-idx' }, label);
    case KeyKind.Doc:
      return h('span', { class: 'k k-doc' }, '--- ', label);
    case KeyKind.Attr:
      return h('span', { class: 'k k-attr' }, h('span', { class: 'pn' }, '@'), hl(label, ctx.re));
    case KeyKind.Elem:
      return h('span', { class: 'k k-elem' }, h('span', { class: 'pn' }, '<'), hl(label, ctx.re), h('span', { class: 'pn' }, '>'));
    case KeyKind.Text:
    case KeyKind.Decl:
      return h('span', { class: 'k k-text' }, label);
    case KeyKind.Section:
      return h('span', { class: 'k k-sec' }, hl(label, ctx.re));
    default:
      return hl(label, ctx.re, 'k k-prop');
  }
}

/** Value element with hints (link, colour swatch, timestamp). */
export function valueEl(row: Pick<Row, 't' | 'v' | 'tr' | 'k' | 'id' | 'alias'>, ctx: Ctx, quoted = true): HTMLElement {
  const v = row.v ?? '';
  const wrap = h('span', { class: 'val' });
  switch (row.t) {
    case Kind.Str: {
      const color = colorOf(v);
      if (color) {
        const sw = h('span', { class: 'sw' });
        sw.style.background = color;
        wrap.append(sw);
      }
      const url = isUrl(v);
      const s = hl(visible(v), ctx.re, 'v-str' + (url ? ' link' : '') + (quoted ? ' q' : ''));
      if (url) {
        s.dataset.url = v;
        s.title = t('Ctrl+Click to open');
      }
      wrap.append(s);
      const time = isoTime(v);
      if (time) {
        wrap.title = timeTooltip(time);
        wrap.append(h('span', { class: 'hint-ic' }, icon('calendar', 12)));
      }
      if (row.tr) wrap.append(h('button', { class: 'more', 'data-full': String(row.id), title: t('Show full value') }, t('+{0} chars', nf.format(row.tr - v.length))));
      if (url) wrap.append(h('button', { class: 'go', 'data-url': v, title: t('Open link') }, icon('link', 12)));
      return wrap;
    }
    case Kind.Num: {
      wrap.append(hl(v, ctx.re, 'v-num'));
      const time = epochTime(v, row.k);
      if (time) {
        wrap.title = timeTooltip(time);
        wrap.append(h('span', { class: 'hint' }, time.date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')));
      }
      return wrap;
    }
    case Kind.Alias: {
      const a = h('span', { class: 'v-alias link' }, '*' + v);
      if (row.alias !== undefined) a.dataset.alias = String(row.alias);
      a.title = t('Go to anchor');
      wrap.append(a);
      return wrap;
    }
    case Kind.Date: {
      wrap.append(hl(v, ctx.re, 'v-date'));
      const time = isoTime(v);
      if (time) wrap.title = timeTooltip(time);
      wrap.append(h('span', { class: 'hint-ic' }, icon('calendar', 12)));
      return wrap;
    }
    case Kind.Comment:
      wrap.append(hl(visible(v), ctx.re, 'v-comment'));
      if (row.tr) wrap.append(h('button', { class: 'more', 'data-full': String(row.id), title: t('Show full value') }, t('+{0} chars', nf.format(row.tr - v.length))));
      return wrap;
    default:
      wrap.append(hl(v, ctx.re, KIND_CLASS[row.t] ?? ''));
      return wrap;
  }
}

/** Collapsed container summary: { id: 1, name: "x", … } */
function preview(row: Row, re?: RegExp): HTMLElement {
  const isArr = row.t === Kind.Arr;
  const pv = h('span', { class: 'pv' });
  pv.append(h('span', { class: 'pn' }, isArr ? '[' : '{ '));
  (row.pv ?? []).forEach(([k, kind, s], i) => {
    if (i) pv.append(h('span', { class: 'pn' }, ', '));
    if (k !== null && !isArr) pv.append(hl(String(k), re, 'pk'), h('span', { class: 'pn' }, ': '));
    if (kind === Kind.Obj) pv.append(h('span', { class: 'pn' }, '{…}'));
    else if (kind === Kind.Arr) pv.append(h('span', { class: 'pn' }, '[…]'));
    else pv.append(hl(kind === Kind.Str ? visible(s) : kind === Kind.Alias ? '*' + s : s, re, (KIND_CLASS[kind] ?? '') + (kind === Kind.Str ? ' q' : '')));
  });
  if (row.pm) pv.append(h('span', { class: 'pn' }, ', …'));
  pv.append(h('span', { class: 'pn' }, isArr ? ']' : ' }'));
  return pv;
}

function count(row: Row): HTMLElement {
  const isArr = row.t === Kind.Arr;
  return h('span', { class: 'cnt', title: t(isArr ? '{0} items' : '{0} keys', nf.format(row.n ?? 0)) }, isArr ? '[' : '{', h('b', null, nf.format(row.n ?? 0)), isArr ? ']' : '}');
}

function badges(row: Row, el: HTMLElement): void {
  if (row.anchor) el.append(h('span', { class: 'badge anchor', title: t('Anchor') }, '&' + row.anchor));
  if (row.tag) el.append(h('span', { class: 'badge tagb', title: t('Tag') }, row.tag));
}

function rowBase(el: HTMLElement, cls: string, r: number, ctx: Ctx, row?: Row): void {
  el.className = cls;
  el.id = 'r' + r;
  el.dataset.r = String(r);
  el.removeAttribute('title');
  if (r === ctx.sel) {
    el.classList.add('sel');
  }
  if (row?.m && row.m & 7) {
    el.classList.add('hit');
    if (row.m & 4) el.classList.add('cur');
  }
  el.setAttribute('aria-selected', r === ctx.sel ? 'true' : 'false');
}

export function renderPlaceholder(el: HTMLElement, r: number, ctx: Ctx): void {
  rowBase(el, 'row ph', r, ctx);
  el.setAttribute('role', 'treeitem');
  el.replaceChildren(h('span', { class: 'ph-bar' }));
}

// ---------------------------------------------------------------------------------------------------------------
// Tree

export function renderTree(el: HTMLElement, row: Row, r: number, ctx: Ctx): void {
  if (row.r === RowKind.TableHead) return renderTableHead(el, row, r, ctx);
  if (row.r === RowKind.TableRow) return renderTableRow(el, row, r, ctx);
  rowBase(el, 'row tr', r, ctx, row);
  el.setAttribute('role', 'treeitem');
  el.setAttribute('aria-level', String(row.d + 1));
  const isC = row.t === Kind.Obj || row.t === Kind.Arr;
  if (isC && row.n) el.setAttribute('aria-expanded', row.x ? 'true' : 'false');
  else el.removeAttribute('aria-expanded');
  const parts: (Node | null)[] = [indent(row.d, ctx, r), chevron(row)];
  const k = keyEl(row, ctx);
  const leafElem = row.kk === KeyKind.Elem && !isC;
  if (k) {
    parts.push(k);
    if (row.kk !== KeyKind.Elem && row.kk !== KeyKind.Text && row.kk !== KeyKind.Doc && row.kk !== KeyKind.Decl) parts.push(h('span', { class: 'colon' }, ':'));
    else parts.push(h('span', { class: 'gap' }));
  }
  const tail = h('span', { class: 'tail' });
  if (isC) {
    if (row.kk === KeyKind.Elem && !row.n) tail.append(h('span', { class: 'pn' }, '∅'));
    else tail.append(count(row));
    if (!row.x && row.n && row.m && row.m & 8) tail.append(h('span', { class: 'anc', title: t('Contains matches') }));
    if (!row.x && row.n) tail.append(preview(row, ctx.re));
    if (row.tb) {
      const b = h('button', { class: 'chip-tb' + (row.tb === 2 ? ' on' : ''), 'data-table': String(row.id), title: row.tb === 2 ? t('Show as tree') : t('Show as table') }, icon('table', 12), t('Table'));
      tail.append(b);
    }
  } else if (row.t === Kind.Null && row.kk === KeyKind.Prop && row.v === '') {
    tail.append(h('span', { class: 'v-null' }, 'null'));
  } else tail.append(valueEl(row, ctx, !leafElem && row.kk !== KeyKind.Text && row.kk !== KeyKind.Decl));
  badges(row, tail);
  if (row.c) tail.append(h('span', { class: 'cmt' }, '# ' + row.c));
  parts.push(tail);
  el.replaceChildren(...(parts.filter(Boolean) as Node[]));
}

// ---------------------------------------------------------------------------------------------------------------
// Tables

export function idxWidth(n: number): number {
  return Math.max(2, String(Math.max(0, n - 1)).length);
}

/** Pixel width of a table (for the horizontal scroll range). */
export function tableWidth(row: Row, ctx: Ctx, n: number): number {
  const cw = row.cw ?? [];
  let w = row.d * IND + 20 + Math.ceil(idxWidth(n) * ctx.ch + 18);
  for (const c of cw) w += Math.ceil(c * ctx.ch + 18);
  return Math.ceil(w + 24);
}

/** Column width from a character count, in px of the monospace font (header and cells use different fonts). */
function colW(el: HTMLElement, chars: number, ch: number): void {
  el.style.width = Math.ceil(chars * ch + 18) + 'px';
}

export function renderTableHead(el: HTMLElement, row: Row, r: number, ctx: Ctx, sticky = false): void {
  rowBase(el, 'row th' + (sticky ? ' sticky' : ''), r, ctx);
  el.setAttribute('role', 'row');
  const cells: Node[] = [indent(row.d, ctx, r), h('span', { class: 'tw' })];
  const ix = h('span', { class: 'c c-idx' }, '#');
  colW(ix, idxWidth(row.n ?? 0), ctx.ch);
  cells.push(ix);
  (row.cols ?? []).forEach((name, i) => {
    const sorted = row.sort && row.sort.col === i;
    const c = h('span', { class: 'c hc' + (sorted ? ' sorted' : ''), 'data-col': String(i), 'data-tid': String(row.id), title: t('Click to sort'), role: 'columnheader' }, name === '' ? h('i', null, t('(value)')) : name);
    if (sorted) c.append(icon(row.sort!.desc ? 'arrowDown' : 'arrowUp', 11));
    colW(c, row.cw?.[i] ?? 8, ctx.ch);
    cells.push(c);
  });
  el.replaceChildren(...cells);
}

function cellEl(c: Cell | null, ctx: Ctx, key: string): HTMLElement {
  const el = h('span', { class: 'c' });
  if (!c) {
    el.classList.add('none');
    return el;
  }
  el.dataset.id = String(c.id);
  if (c.t === Kind.Obj || c.t === Kind.Arr) {
    el.classList.add('nest');
    el.append(h('button', { class: 'cnt cell-open', 'data-open': String(c.id), title: t('Open in tree') }, c.t === Kind.Arr ? '[' : '{', h('b', null, nf.format(c.n ?? 0)), c.t === Kind.Arr ? ']' : '}'));
    return el;
  }
  el.append(valueEl({ t: c.t, v: c.v, tr: c.tr, k: key, id: c.id }, ctx, false));
  return el;
}

export function renderTableRow(el: HTMLElement, row: Row, r: number, ctx: Ctx): void {
  rowBase(el, 'row td' + ((row.ti ?? 0) % 2 ? ' odd' : ''), r, ctx, row);
  el.setAttribute('role', 'row');
  const parts: Node[] = [indent(row.d, ctx, r), h('span', { class: 'tw' })];
  const ix = h('span', { class: 'c c-idx' }, String(row.k ?? row.ti ?? ''));
  colW(ix, idxWidth(ctx.gutter), ctx.ch);
  parts.push(ix);
  const cols = TABLES.get(row.tid ?? -1);
  (row.cells ?? []).forEach((c, i) => {
    const cell = cellEl(c, ctx, cols?.cols?.[i] ?? '');
    colW(cell, cols?.cw?.[i] ?? 8, ctx.ch);
    parts.push(cell);
  });
  el.replaceChildren(...parts);
}

/** Column layout of tables seen so far (header rows), so data rows can size their cells. */
export const TABLES = new Map<number, Row>();

// ---------------------------------------------------------------------------------------------------------------
// Pretty text

const YAML_RESERVED = /^(true|false|null|~|yes|no|on|off|y|n|\.inf|-\.inf|\.nan)$/i;
function yamlStr(s: string): string {
  if (
    !s ||
    s !== s.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /: |\s#|:$|[\u0000-\u001f]/.test(s) ||
    YAML_RESERVED.test(s) ||
    /^[-+]?(\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+)$/i.test(s) ||
    /^\d{4}-\d{2}-\d{2}/.test(s)
  )
    return JSON.stringify(s);
  return s;
}

function tok(cls: string, text: string, ctx?: Ctx): HTMLElement {
  return ctx?.re ? hl(text, ctx.re, cls) : h('span', { class: cls }, text);
}

function prettyValue(row: Row, ctx: Ctx, syntax: Syntax, out: Node[]): void {
  const v = row.v ?? '';
  if (row.t === Kind.Str || row.t === Kind.Date || row.t === Kind.Comment) {
    const shown = syntax === 'json' ? JSON.stringify(v) : syntax === 'yaml' ? yamlStr(v) : v;
    const cls = (row.t === Kind.Date ? 'v-date' : 'v-str') + ' ev';
    const s = tok(cls, shown, ctx);
    if (isUrl(v)) {
      s.classList.add('link');
      s.dataset.url = v;
      s.title = t('Ctrl+Click to open');
    }
    const color = colorOf(v);
    if (color) {
      const sw = h('span', { class: 'sw' });
      sw.style.background = color;
      out.push(sw);
    }
    out.push(s);
    if (row.tr) out.push(h('button', { class: 'more', 'data-full': String(row.id), title: t('Show full value') }, t('+{0} chars', nf.format(row.tr - v.length))));
    return;
  }
  if (row.t === Kind.Alias) {
    const a = tok('v-alias link ev', syntax === 'yaml' ? '*' + v : JSON.stringify('*' + v), ctx);
    if (row.alias !== undefined) a.dataset.alias = String(row.alias);
    out.push(a);
    return;
  }
  if (row.t === Kind.Null && v === '' && syntax !== 'yaml') return void out.push(tok('v-null ev', 'null'));
  if (row.t === Kind.Null && syntax === 'json') return void out.push(tok('v-null ev', 'null'));
  out.push(tok((KIND_CLASS[row.t] ?? '') + ' ev', v, ctx));
}

function fold(row: Row): HTMLElement {
  return h('button', { class: 'fold-pill', 'data-unfold': String(row.id), title: t('{0} items', nf.format(row.n ?? 0)) }, '…', nf.format(row.n ?? 0));
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPretty(el: HTMLElement, row: Row, r: number, ctx: Ctx): void {
  rowBase(el, 'row pl', r, ctx, row);
  el.setAttribute('role', 'treeitem');
  const syn = ctx.syntax;
  const isC = (row.t === Kind.Obj || row.t === Kind.Arr) && row.r !== RowKind.Close;
  const foldable = isC && !!row.n;
  if (foldable) el.setAttribute('aria-expanded', row.x ? 'true' : 'false');
  else el.removeAttribute('aria-expanded');
  const gut = h('span', { class: 'gut' }, h('span', { class: 'ln' }, row.ln ? String(row.ln) : ''));
  const ft = h('span', { class: 'ft' });
  if (foldable) {
    ft.classList.add('can');
    if (row.x) ft.classList.add('open');
    ft.append(icon('chevronRight', 12));
  }
  gut.append(ft);
  const code: Node[] = [];
  const unit = syn === 'yaml' ? 2 : ctx.indent;
  const depth = syn === 'yaml' ? row.d - (row.dash ?? 0) : row.d;
  const ind = h('span', { class: 'ind pind' });
  ind.style.width = Math.max(0, depth) * unit + 'ch';
  ind.style.backgroundSize = unit + 'ch 100%';
  code.push(ind);
  const p = (s: string) => h('span', { class: 'pn' }, s);
  if (syn === 'json') {
    const comma = row.last ? '' : ',';
    if (row.r === RowKind.Close) {
      code.push(p((row.t === Kind.Arr ? ']' : '}') + comma));
    } else {
      if (row.kk !== KeyKind.None && row.kk !== KeyKind.Index && row.kk !== KeyKind.Doc) code.push(tok('k-prop', JSON.stringify(row.kk === KeyKind.Attr ? '@' + row.k : String(row.k ?? '')), ctx), p(': '));
      if (isC) {
        const [o, c] = row.t === Kind.Arr ? ['[', ']'] : ['{', '}'];
        if (!row.n) code.push(p(o + c + comma));
        else if (row.x) code.push(p(o));
        else code.push(p(o), fold(row), p(c + comma));
      } else {
        prettyValue(row, ctx, 'json', code);
        if (comma) code.push(p(comma));
      }
    }
  } else if (syn === 'yaml') {
    if (row.dash) code.push(p('- '.repeat(row.dash)));
    if (row.kk === KeyKind.Doc) {
      code.push(p('---'));
      if (!isC) code.push(p(' '));
    } else if (row.kk === KeyKind.Index) code.push(p('- '));
    else if (row.kk !== KeyKind.None) code.push(tok('k-prop', yamlStr(row.kk === KeyKind.Attr ? '@' + row.k : String(row.k ?? '')), ctx), p(':'));
    const needSpace = row.kk !== KeyKind.Index && row.kk !== KeyKind.None && row.kk !== KeyKind.Doc;
    if (row.anchor) code.push(p(needSpace ? ' ' : ''), h('span', { class: 'v-anchor' }, '&' + row.anchor));
    if (row.tag && row.tag !== 'export') code.push(p(needSpace || row.anchor ? ' ' : ''), h('span', { class: 'v-tag' }, row.tag));
    const sp = needSpace || row.anchor || (row.tag && row.tag !== 'export') ? ' ' : '';
    if (isC) {
      const [o, c] = row.t === Kind.Arr ? ['[', ']'] : ['{', '}'];
      if (!row.n) code.push(p(sp + o + c));
      else if (!row.x) code.push(p(sp), fold(row));
      else if (row.kk === KeyKind.Doc) code.push(h('span', { class: 'cmt' }, ' # ' + t('Document {0}', Number(row.k) + 1)));
    } else {
      if (!(row.t === Kind.Null && row.v === '')) code.push(p(sp));
      if (row.t === Kind.Null && row.v === '') {
        /* empty value */
      } else prettyValue(row, ctx, 'yaml', code);
    }
    if (row.c) code.push(h('span', { class: 'cmt' }, '  # ' + row.c));
  } else {
    // XML
    const tag = String(row.k ?? '');
    if (row.r === RowKind.Close) code.push(p('</'), h('span', { class: 'x-tag' }, tag), p('>'));
    else if (row.kk === KeyKind.Elem) {
      const open: Node[] = [p('<'), tok('x-tag', tag, ctx)];
      for (const [a, v] of row.attrs ?? []) open.push(p(' '), tok('x-attr', a, ctx), p('='), tok('v-str', '"' + v.replace(/"/g, '&quot;') + '"', ctx));
      code.push(...open);
      if (isC && row.v !== undefined) code.push(p('>'), tok('x-text', xmlEsc(row.v), ctx), p('</'), h('span', { class: 'x-tag' }, tag), p('>'));
      else if (isC) {
        if (!row.n) code.push(p('/>'));
        else if (row.x) code.push(p('>'));
        else code.push(p('>'), fold(row), p('</'), h('span', { class: 'x-tag' }, tag), p('>'));
      } else {
        code.push(p('>'), tok('x-text', xmlEsc(row.v ?? ''), ctx), p('</'), h('span', { class: 'x-tag' }, tag), p('>'));
      }
    } else if (row.kk === KeyKind.Decl) code.push(p('<'), h('span', { class: 'x-tag' }, tag), p(' '), tok('x-attr', row.v ?? '', ctx), p('?>'));
    else if (row.k === '#comment') code.push(tok('cmt', '<!-- ' + (row.v ?? '') + ' -->', ctx));
    else if (row.k === '#cdata') code.push(p('<![CDATA['), tok('v-str', row.v ?? '', ctx), p(']]>'));
    else code.push(tok('x-text', xmlEsc(row.v ?? ''), ctx));
    if (row.tr) code.push(h('button', { class: 'more', 'data-full': String(row.id), title: t('Show full value') }, t('+{0} chars', nf.format(row.tr - (row.v ?? '').length))));
  }
  el.replaceChildren(gut, h('span', { class: 'code' }, ...code));
}

// ---------------------------------------------------------------------------------------------------------------
// INI / .env

export function renderIni(el: HTMLElement, row: Row, r: number, ctx: Ctx): void {
  if (row.kk === KeyKind.Section) {
    rowBase(el, 'row ini-sec', r, ctx, row);
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', '1');
    if (row.n) el.setAttribute('aria-expanded', row.x ? 'true' : 'false');
    el.replaceChildren(chevron(row), h('span', { class: 'pn' }, '['), hl(String(row.k ?? ''), ctx.re, 'k-sec'), h('span', { class: 'pn' }, ']'), h('span', { class: 'sec-n' }, t('{0} keys', nf.format(row.n ?? 0))), ...(row.c ? [h('span', { class: 'cmt' }, row.c)] : []));
    return;
  }
  rowBase(el, 'row ini-kv' + (row.d > 0 ? ' in' : ''), r, ctx, row);
  el.setAttribute('role', 'treeitem');
  el.setAttribute('aria-level', String(row.d + 1));
  el.removeAttribute('aria-expanded');
  const k = hl(String(row.k ?? ''), ctx.re, 'ini-k');
  k.style.width = Math.min(Math.max(ctx.keyWidth, 6), 36) + 1 + 'ch';
  const v = row.v === '' ? h('span', { class: 'val' }, h('span', { class: 'v-empty' }, row.t === Kind.Null ? '—' : '""')) : valueEl(row, ctx, false);
  v.classList.add('ini-v');
  const exp = row.tag === 'export' ? [h('span', { class: 'badge exp' }, 'export')] : [];
  el.replaceChildren(h('span', { class: 'ini-ln' }, row.line ? String(row.line) : ''), ...exp, k, h('span', { class: 'pn eq' }, '='), v, ...(row.c ? [h('span', { class: 'cmt', title: row.c }, row.c)] : []));
}
