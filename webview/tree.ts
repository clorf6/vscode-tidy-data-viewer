// Tree / pretty-text / table viewer for JSON, YAML, TOML, INI, .env and XML. All parsing happens on the host; this
// page renders the visible window of rows it is sent and turns clicks and keys into requests.
import { copyText, fmtBytes, getState, h, icon, nf, onMessage, post, rafThrottle, selectionLabel, setState, setStrings, t } from './shared/vscode';
import { Kind, KeyKind, RowKind } from '../src/tree/protocol';
import type { EditOp, HostMsg, Mode, PathStyle, Row, SearchQuery, Status, Syntax, ViewMsg, WebMsg, WebState } from '../src/tree/protocol';
import { VList } from './tree/vlist';
import { Ctx, IND, TABLES, renderIni, renderPlaceholder, renderPretty, renderTableHead, renderTree, tableWidth } from './tree/rows';
import { closeMenu, closePop, MenuItem, popOpen, showMenu, showPop, toast } from './tree/ui';
import { openColorPicker } from './tree/color';
import { copySelection, locate, measure, onSelectionChange, rowText, selectAt, selectedIn, selectionIn, serialize, SerializeOpts } from './shared/selection';

const send = (m: WebMsg) => post(m);
const saved = getState<WebState & { pathStyle?: PathStyle }>() ?? {};

const S = {
  fileName: '',
  format: 'json' as string,
  indent: 2,
  mode: (saved.mode ?? 'tree') as Mode,
  syntax: (saved.syntax ?? 'json') as Syntax,
  layout: 'tree' as 'tree' | 'ini',
  keyWidth: 12,
  version: -1,
  total: 0,
  depth: 2,
  status: undefined as Status | undefined,
  sel: -1,
  selId: -1,
  focused: false,
  search: (saved.search ?? { text: '', regex: false, caseSensitive: false, wholeWord: false, scope: 'all', filter: false }) as SearchQuery,
  count: 0,
  current: -1,
  searchBusy: false,
  searchErr: '',
  pathStyle: saved.pathStyle as PathStyle | undefined,
  path: '',
  ready: false,
  ch: 7.8,
  tableW: 0,
};

let vl!: VList;
let hlRe: RegExp | undefined;

// ---------------------------------------------------------------------------------------------------------------
// Layout

const app = document.getElementById('app')!;
const bar = h('div', { class: 'dv-toolbar tv-bar', role: 'toolbar' });
const crumbs = h('div', { class: 'tv-crumbs' });
const banner = h('div', { class: 'tv-banner', hidden: true });
const main = h('div', { class: 'tv-main' });
const stickyHead = h('div', { class: 'tv-sticky', hidden: true });
const statusBar = h('div', { class: 'dv-status tv-status' });
const busy = h('div', { class: 'tv-busy', hidden: true }, h('div', { class: 'dv-spinner' }), h('span', null));
const empty = h('div', { class: 'dv-empty tv-empty', hidden: true });
app.append(bar, crumbs, banner, main, statusBar);
main.append(stickyHead, empty, busy);

// toolbar controls (labels are set once strings arrive)
const segMode = h('div', { class: 'dv-seg', role: 'tablist' });
const segSyntax = h('div', { class: 'dv-seg tv-syn', role: 'tablist' });
const btnCollapse = h('button', { class: 'dv-iconbtn', onclick: () => send({ type: 'depth', depth: 0 }) }, icon('collapse'));
const btnExpand = h('button', { class: 'dv-iconbtn', onclick: () => send({ type: 'depth', depth: 1e9 }) }, icon('expand'));
const btnDepth = h('button', { class: 'dv-btn tv-depth', onclick: (e: Event) => depthMenu(e.currentTarget as HTMLElement) });
const searchInput = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'search' }) as HTMLInputElement;
const searchCount = h('span', { class: 'dv-count' });
const tgl = (label: string | Node, cls: string, onclick: () => void) => h('button', { class: 'tv-tgl ' + cls, 'aria-pressed': 'false', onclick }, label);
const btnCase = tgl('Aa', 'case', () => setQuery({ caseSensitive: !S.search.caseSensitive }));
const btnWord = tgl(h('span', { class: 'ww' }, 'ab'), 'word', () => setQuery({ wholeWord: !S.search.wholeWord }));
const btnRegex = tgl('.*', 'regex', () => setQuery({ regex: !S.search.regex }));
const btnScope = h('button', { class: 'tv-tgl scope', onclick: (e: Event) => scopeMenu(e.currentTarget as HTMLElement) });
const btnPrev = h('button', { class: 'dv-iconbtn sm', onclick: () => nav(-1) }, icon('arrowUp', 14));
const btnNext = h('button', { class: 'dv-iconbtn sm', onclick: () => nav(1) }, icon('arrowDown', 14));
const btnFilter = h('button', { class: 'dv-iconbtn sm', 'aria-pressed': 'false', onclick: () => setQuery({ filter: !S.search.filter }) }, icon('filter', 14));
const btnClear = h('button', { class: 'dv-iconbtn sm clr', onclick: () => clearSearch(true) }, icon('close', 14));
const searchBox = h('div', { class: 'dv-input tv-search' }, icon('search', 14), searchInput, searchCount, btnCase, btnWord, btnRegex, btnScope, h('span', { class: 'tv-vsep' }), btnPrev, btnNext, btnFilter, btnClear);
const actBtn = (ic: string, onclick: () => void) => {
  const b = h('button', { class: 'dv-btn tv-act', onclick }, icon(ic, 14), h('span', { class: 'lbl' }));
  return b;
};
const btnFormat = actBtn('braces', () => send({ type: 'action', name: 'format' }));
const btnMinify = actBtn('wrap', () => send({ type: 'action', name: 'minify' }));
const btnSort = actBtn('sortAsc', () => send({ type: 'action', name: 'sortKeys' }));
const valid = h('button', { class: 'tv-valid', onclick: (e: Event) => errorsPop(e.currentTarget as HTMLElement) });
const btnText = h('button', { class: 'dv-iconbtn', onclick: () => send({ type: 'action', name: 'openText' }) }, icon('code'));
const barBusy = h('span', { class: 'tv-barbusy', hidden: true }, h('span', { class: 'dv-spinner' }));

function buildToolbar(): void {
  segMode.replaceChildren(
    ...(['tree', 'pretty'] as Mode[]).map((m) =>
      h('button', { role: 'tab', 'data-mode': m, title: t(m === 'tree' ? 'Tree view' : 'Pretty text view'), onclick: () => setMode(m) }, icon(m === 'tree' ? 'list' : 'code', 14), ' ', t(m === 'tree' ? 'Tree' : 'Pretty')),
    ),
  );
  btnCollapse.title = t('Collapse all');
  btnExpand.title = t('Expand all');
  btnDepth.title = t('Expand to depth');
  searchInput.placeholder = t('Search keys and values');
  searchInput.setAttribute('aria-label', t('Search keys and values'));
  btnCase.title = t('Match case');
  btnWord.title = t('Match whole word');
  btnRegex.title = t('Regular expression');
  btnPrev.title = t('Previous match (Shift+Enter)');
  btnNext.title = t('Next match (Enter)');
  btnFilter.title = t('Show only matching');
  btnClear.title = t('Clear search');
  btnFormat.title = t('Format document');
  btnMinify.title = t('Remove all whitespace');
  btnSort.title = t('Sort object keys recursively');
  btnFormat.querySelector('.lbl')!.textContent = t('Format');
  btnMinify.querySelector('.lbl')!.textContent = t('Minify');
  btnSort.querySelector('.lbl')!.textContent = t('Sort keys');
  btnText.title = t('Open as text');
  bar.replaceChildren(segMode, segSyntax, h('span', { class: 'dv-sep' }), btnCollapse, btnExpand, btnDepth, h('span', { class: 'dv-sep' }), searchBox, h('span', { class: 'dv-spacer' }), barBusy, btnFormat, btnMinify, btnSort, valid, btnText);
  searchInput.value = S.search.text;
  syncSearchUi();
}

// ---------------------------------------------------------------------------------------------------------------
// Virtual list

function ctx(): Ctx {
  let guide: Ctx['guide'];
  const sr = vl.cache.get(S.sel);
  if (sr && sr.x && S.mode === 'tree' && S.layout === 'tree') {
    const [, end] = vl.range();
    let to = S.sel;
    for (let r = S.sel + 1; r < end + 1; r++) {
      const row = vl.cache.get(r);
      if (!row || row.d <= sr.d) break;
      to = r;
    }
    guide = { from: S.sel, to, depth: sr.d };
  }
  return { mode: S.mode, syntax: S.syntax, layout: S.layout, sel: S.sel, focused: S.focused, re: hlRe, keyWidth: S.keyWidth, indent: S.indent, ch: S.ch, guide, gutter: 0, readOnly: !!S.status?.readOnly };
}

let paintCtx: Ctx | undefined;
function render(el: HTMLElement, row: Row | undefined, r: number): void {
  const c = (paintCtx ??= ctx());
  queueMicrotask(() => (paintCtx = undefined));
  if (!row) return renderPlaceholder(el, r, c);
  if (S.mode === 'pretty') {
    renderPretty(el, row, r, c);
    // lines can be wider than the viewport: grow the horizontal scroll range as long lines come into view
    const chars = row.d * (S.syntax === 'yaml' ? 2 : S.indent) + String(row.k ?? '').length + (row.v?.length ?? 0) + (row.attrs ? row.attrs.reduce((n, [a, v]) => n + a.length + v.length + 4, 0) : 0) + 14;
    const w = Math.ceil(chars * S.ch + 110);
    if (w > S.tableW && w > vl.el.clientWidth) {
      S.tableW = w;
      vl.setWidth(w);
    }
  }
  else if (S.layout === 'ini') renderIni(el, row, r, c);
  else {
    if (row.r === RowKind.TableHead) {
      TABLES.set(row.id, row);
      const w = tableWidth(row, c, row.n ?? 0);
      if (w > S.tableW) {
        S.tableW = w;
        vl.setWidth(w);
      }
    }
    if (row.r === RowKind.TableRow) {
      const head = TABLES.get(row.tid ?? -1);
      c.gutter = head?.n ?? 0;
      renderTree(el, row, r, c);
      c.gutter = 0;
      return;
    }
    renderTree(el, row, r, c);
  }
}

function measureCh(): number {
  const probe = h('span', { class: 'tv-probe' }, '0'.repeat(100));
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return w || 7.8;
}

function rowH(): number {
  return S.mode === 'pretty' ? 20 : 22;
}

function updateSticky(): void {
  if (S.mode !== 'tree' || S.layout !== 'tree') {
    stickyHead.hidden = true;
    return;
  }
  const first = vl.cache.get(vl.first);
  const partial = vl.toContentTop() % vl.rowH > 0;
  const head = first && first.r === RowKind.TableRow ? TABLES.get(first.tid ?? -1) : first && first.r === RowKind.TableHead && partial ? first : undefined;
  if (!head) {
    stickyHead.hidden = true;
    return;
  }
  stickyHead.hidden = false;
  let el = stickyHead.firstElementChild as HTMLElement | null;
  if (!el) {
    el = h('div');
    stickyHead.append(el);
  }
  renderTableHead(el, head, -1, ctx(), true);
  el.style.transform = `translateX(${-vl.el.scrollLeft}px)`;
}

function persist(): void {
  setState<WebState & { pathStyle?: PathStyle }>({ uri: S.fileName, mode: S.mode, syntax: S.syntax, scrollTop: vl?.scrollTop() ?? 0, search: S.search, pathStyle: S.pathStyle });
}
const persistSoon = rafThrottle(persist);

function initList(): void {
  vl = new VList(main, {
    rowHeight: rowH(),
    render,
    request: (start, end, version) => send({ type: 'rows', start, end, version }),
    onScroll: () => {
      persistSoon();
      positionEditor();
    },
    onPaint: () => updateSticky(),
  });
  vl.el.setAttribute('role', 'tree');
  main.insertBefore(vl.el, stickyHead);
  vl.el.addEventListener('focus', () => setFocus(true));
  vl.el.addEventListener('blur', () => setFocus(false));
  vl.el.addEventListener('keydown', onKey);
  vl.el.addEventListener('mousedown', onMouseDown);
  vl.el.addEventListener('click', onClick);
  vl.el.addEventListener('dblclick', onDblClick);
  vl.el.addEventListener('contextmenu', onContext);
  copySelection(vl.el, copyOpts);
  onSelectionChange(updateSelInfo);
}

// ---------------------------------------------------------------------------------------------------------------
// Text selection: row text can be selected directly; a copy gets clean text and the status bar shows its length.

/** Row parts that are chrome, not content: not selectable (see tree.css) and never copied. */
const NO_COPY = '.tw,.ind:not(.pind),.gut,button,.cnt,.sw,.hint-ic,.hint,.anc,.ph-bar,.ini-ln,.sec-n,.badge,.c-idx';

const levelOf = (el: Element) => (el.matches('.tr') ? Number(el.getAttribute('aria-level')) : NaN);
/** Tree rows copied together are indented relative to the first one. */
const indentFor = (d: number, base: number) => (d > base ? '  '.repeat(d - base) : '');

/** Level and text of rows a selection spans that are scrolled out of the DOM, by row index (per view version). */
const gapText = new Map<number, [number, string]>();
let gapVersion = -1;

function copyOpts(): SerializeOpts {
  const o: SerializeOpts = {
    skip: NO_COPY,
    row: '.row',
    cell: '.c,.hc',
    index: (el) => Number((el as HTMLElement).dataset.r),
    prefix: (row, first) => indentFor(levelOf(row), levelOf(first)),
    gap: (from, to, first) => {
      if (gapVersion !== vl.version) {
        gapText.clear();
        gapVersion = vl.version;
      }
      const base = first ? levelOf(first) : NaN;
      const lines: string[] = [];
      const scratch = document.createElement('div');
      for (let r = from + 1; r < to; r++) {
        const row = vl.cache.get(r);
        if (!row) {
          lines.push('');
          continue;
        }
        let g = gapText.get(r);
        if (!g) {
          render(scratch, row, r);
          g = [levelOf(scratch), rowText(scratch, o)];
          gapText.set(r, g);
        }
        lines.push(indentFor(g[0], base) + g[1]);
      }
      return lines;
    },
    map: (text, parent, whole) => {
      if (parent.closest('.colon')) return text + ' ';
      if (parent.closest('[data-cc]')) return text.replace(/↵/g, '\n').replace(/→/g, '\t');
      // a comment shown beside a tree / INI entry (pretty text has its own spacing): keep it apart from the value
      if (whole && S.mode === 'tree' && parent.matches('.cmt')) return '  ' + (S.layout === 'ini' && !/^[;#]/.test(text) ? '; ' : '') + text;
      return text;
    },
  };
  return o;
}

const selInfo = h('span', { class: 'tv-selinfo' });

/** Status bar: length of the selected text, of the text being edited, or of the current string value. */
function updateSelInfo(): void {
  let text = '';
  const r = vl && selectionIn(vl.el);
  const ed = editing;
  if (ed && document.activeElement === ed.input) {
    // editing: the same readout for the text being edited
    const { value, selectionStart: a, selectionEnd: b } = ed.input;
    text = a !== null && b !== null && b > a ? selectionLabel(value.slice(a, b)) : t('Length {0}', nf.format(measure(value).chars));
  } else if (r) text = selectionLabel(serialize(r, copyOpts()));
  else {
    const sel = getSelection();
    const pop = document.querySelector('.tv-full');
    if (sel && !sel.isCollapsed && pop?.contains(sel.anchorNode)) text = selectionLabel(sel.toString());
    else {
      const row = vl && selRow();
      if (row && row.r === RowKind.Node && (row.t === Kind.Str || row.t === Kind.Comment)) text = t('Length {0}', nf.format(row.tr ?? [...(row.v ?? '')].length));
    }
  }
  if (selInfo.textContent !== text) selInfo.textContent = text;
  selInfo.hidden = !text;
}

/** The word a double-click selected inside `el`, as a range of `raw` (the text the editor opens with). */
const clickedWord = (el: Element | null, raw: string) => locate(raw, selectedIn(el));

function setFocus(on: boolean): void {
  if (S.focused === on) return;
  S.focused = on;
  // A class on the list, not a re-render: rebuilding the rows on the focus that a mouse press causes replaced the
  // chevron under the pointer before the click landed (see onMouseDown).
  vl.el.classList.toggle('tv-focus', on);
}

// ---------------------------------------------------------------------------------------------------------------
// Selection & navigation

let selTimer = 0;
function select(r: number, reveal: 'auto' | 'center' | 'none' = 'auto'): void {
  if (r < 0 || r >= S.total) return;
  S.sel = r;
  const row = vl.cache.get(r);
  S.selId = row ? row.id : -1;
  vl.el.setAttribute('aria-activedescendant', 'r' + r);
  if (reveal !== 'none') vl.reveal(r, reveal);
  vl.invalidate();
  updateSelInfo();
  clearTimeout(selTimer);
  selTimer = window.setTimeout(() => {
    const cur = vl.cache.get(S.sel);
    if (cur && cur.r !== RowKind.Close && cur.r !== RowKind.TableHead) send({ type: 'select', id: cur.id });
  }, 60);
}

function selRow(): Row | undefined {
  return vl.cache.get(S.sel);
}

function isContainer(row: Row): boolean {
  return (row.t === Kind.Obj || row.t === Kind.Arr) && row.r === RowKind.Node;
}

function toggle(row: Row, expand?: boolean, recursive?: boolean): void {
  if (!isContainer(row) && row.r !== RowKind.Close) return;
  send({ type: 'toggle', id: row.id, expand, recursive });
}

function goParent(row: Row): void {
  const pid = row.r === RowKind.TableRow ? row.tid ?? -1 : row.pid;
  if (pid < 0) return;
  for (let r = S.sel - 1; r >= Math.max(0, S.sel - 5000); r--) {
    const x = vl.cache.get(r);
    if (x && x.id === pid && x.r === RowKind.Node) return select(r);
  }
  send({ type: 'reveal', id: pid });
}

function onKey(e: KeyboardEvent): void {
  const row = selRow();
  const mod = e.ctrlKey || e.metaKey;
  const page = Math.max(1, vl.visibleCount - 1);
  let handled = true;
  switch (e.key) {
    case 'ArrowDown':
      if (e.altKey && row) move(row, 1);
      else select(Math.min(S.total - 1, S.sel < 0 ? vl.first : S.sel + 1));
      break;
    case 'ArrowUp':
      if (e.altKey && row) move(row, -1);
      else select(Math.max(0, S.sel < 0 ? vl.first : S.sel - 1));
      break;
    case 'PageDown':
      select(Math.min(S.total - 1, Math.max(0, S.sel) + page));
      break;
    case 'PageUp':
      select(Math.max(0, S.sel - page));
      break;
    case 'Home':
      select(0);
      break;
    case 'End':
      select(S.total - 1);
      break;
    case 'ArrowRight':
      if (row && isContainer(row) && row.n) {
        if (!row.x) toggle(row, true);
        else select(S.sel + 1);
      }
      break;
    case 'ArrowLeft':
      if (row && isContainer(row) && row.x && row.n) toggle(row, false);
      else if (row) goParent(row);
      break;
    case 'Enter':
      if (!row) break;
      if (isContainer(row)) toggle(row);
      else if (row.r === RowKind.Close) toggle(row, false);
      else startEdit(row, 'value');
      break;
    case ' ':
      if (row && isContainer(row)) toggle(row);
      break;
    case 'F2':
      if (row) startEdit(row, 'key');
      break;
    case 'Delete':
    case 'Backspace':
      if (row && canEditRow(row)) doEdit({ op: 'delete', id: row.id });
      break;
    case '*':
      if (row && isContainer(row)) toggle(row, true, true);
      break;
    case 'Escape':
      if (S.search.text) clearSearch(false);
      else handled = false;
      break;
    case 'Insert':
      if (row) addForm(row);
      break;
    case 'c':
    case 'C':
      if (mod && row && !window.getSelection()?.toString()) {
        if (e.shiftKey) send({ type: 'copyNode', id: row.id, what: 'path', style: S.pathStyle });
        else send({ type: 'copyNode', id: row.id, what: 'value' });
        toast(t('Copied'));
      } else handled = false;
      break;
    case 'd':
      if (mod && row && canEditRow(row)) doEdit({ op: 'duplicate', id: row.id });
      else handled = false;
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Row element + row data under a mouse event (or for an explicit target). */
function hit(e: MouseEvent, at?: HTMLElement): { r: number; row?: Row; target: HTMLElement } {
  const target = at ?? (e.target as HTMLElement);
  const el = target.closest<HTMLElement>('.row');
  const r = el?.dataset.r ? Number(el.dataset.r) : vl.rowAt(e.clientY);
  return { r, row: r >= 0 ? vl.cache.get(r) : undefined, target };
}

/** Element the current press started on. */
let pressed: HTMLElement | null = null;

/** The text a double / triple click selects in: a table cell, a pretty-text line, otherwise the row. */
function textUnit(target: HTMLElement): Element | null {
  if (target.closest(NO_COPY)) return null;
  return target.closest('.c,.hc') ?? target.closest('.row.pl .code') ?? target.closest('.row');
}

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0 && e.button !== 2) return;
  pressed = e.target as HTMLElement;
  if (e.button === 0 && !e.shiftKey) {
    const unit = e.detail >= 2 ? textUnit(e.target as HTMLElement) : null;
    if (unit) {
      e.preventDefault();
      selectAt(unit, e.clientX, e.clientY, e.detail === 2 ? 'word' : 'all');
    } else if (e.detail === 1 && selectionIn(vl.el)) {
      // a press on selected text would start dragging it away: start a new selection instead
      getSelection()?.removeAllRanges();
    }
  }
  // Left button: select on click, not here. Re-rendering the rows between press and release replaces the chevron or
  // button under the pointer, and Chromium then fires no click at all — collapsing an unselected row took two clicks.
  if (e.button !== 2) return;
  const { r } = hit(e);
  if (r >= 0 && r !== S.sel) select(r, 'none');
}

function onClick(e: MouseEvent): void {
  // Selecting on mousedown re-renders the rows, so the chevron/button under the pointer is replaced before the click
  // lands and the browser retargets the click to the list. Resolve the click against the element that was pressed.
  const at = pressed && !pressed.isConnected ? pressed : undefined;
  pressed = null;
  const { r, row, target } = hit(e, at);
  if (!row) return;
  const mod = e.ctrlKey || e.metaKey;
  const sw = target.closest<HTMLElement>('.sw[data-color]');
  if (sw) {
    if (r !== S.sel) select(r, 'none');
    return void pickColor(row, sw);
  }
  const btn = target.closest<HTMLElement>('button,[data-url],[data-alias],.tw.can,.ft.can,.hc');
  if (btn) {
    if (btn.dataset.full) return void showFull(Number(btn.dataset.full), btn);
    if (btn.classList.contains('go') && btn.dataset.url) return void send({ type: 'openUrl', url: btn.dataset.url });
    if (btn.dataset.url && mod) return void send({ type: 'openUrl', url: btn.dataset.url });
    if (btn.dataset.alias) return void send({ type: 'reveal', id: Number(btn.dataset.alias) });
    if (btn.dataset.table) return void send({ type: 'table', id: Number(btn.dataset.table), on: row.tb !== 2 });
    if (btn.dataset.open) return void send({ type: 'openCell', id: Number(btn.dataset.open) });
    if (btn.dataset.unfold) return void send({ type: 'toggle', id: Number(btn.dataset.unfold), expand: true });
    if (btn.dataset.col) return void send({ type: 'tableSort', id: Number(btn.dataset.tid), col: Number(btn.dataset.col) });
    if (btn.classList.contains('tw') || btn.classList.contains('ft')) {
      chevronAt = Date.now();
      return void toggle(row, undefined, e.altKey);
    }
  }
  if (r !== S.sel) select(r, 'none');
  vl.el.focus({ preventScroll: true });
}

/** The colour picker for the colour value whose swatch was clicked (a value, or a cell of an object-array table). */
function pickColor(row: Row, sw: HTMLElement): void {
  const cellEl = sw.closest<HTMLElement>('.c[data-id]');
  const cell = cellEl ? row.cells?.find((x) => x?.id === Number(cellEl.dataset.id)) : undefined;
  const id = cell ? cell.id : row.id;
  const value = (cell ? cell.v : row.v) ?? '';
  const editable = canEditRow(row) && !S.status?.readOnly;
  openColorPicker(sw, value, {
    readOnly: !editable,
    apply: (v) => doEdit({ op: 'set', id, value: v, type: 'string' }),
    copy: (v) => (copyText(v), toast(t('Copied'))),
  });
}

/** Time of the last chevron toggle: a double-click on a chevron is two toggles already, not a third. */
let chevronAt = 0;

function onDblClick(e: MouseEvent): void {
  const { row, target } = hit(e);
  if (!row || target.closest('button,.tw.can,.ft.can') || Date.now() - chevronAt < 600) return;
  if (isContainer(row) && !target.closest('.k-prop,.ini-k,.k-sec')) {
    window.getSelection()?.removeAllRanges();
    return void toggle(row);
  }
  // Read-only: the double-click just selects the word, like in any text.
  if (!canEditRow(row)) return;
  // Otherwise edit, with the double-clicked word selected in the editor (so double-click + Ctrl+C still copies it).
  if (row.r === RowKind.TableRow) {
    const cell = target.closest<HTMLElement>('.c[data-id]');
    if (cell && !cell.classList.contains('nest')) {
      const id = Number(cell.dataset.id);
      const c = row.cells?.find((x) => x?.id === id);
      if (c) startEdit({ ...row, id, t: c.t, v: c.v, tr: c.tr, r: RowKind.Node }, 'value', cell, clickedWord(cell, c.v ?? ''));
    }
    return;
  }
  const keyEl = target.closest('.k-prop,.ini-k,.k-sec');
  if (keyEl) return void startEdit(row, 'key', undefined, clickedWord(keyEl, String(row.k ?? '')));
  if (row.r === RowKind.Node) startEdit(row, 'value', undefined, clickedWord(target.closest('.val,.ev'), row.v ?? ''));
}

function onContext(e: MouseEvent): void {
  e.preventDefault();
  const { r, row } = hit(e);
  if (!row) return;
  if (r !== S.sel) select(r, 'none');
  rowMenu(row, e.clientX, e.clientY);
}

// ---------------------------------------------------------------------------------------------------------------
// Context menu

function canEditRow(row: Row): boolean {
  return !S.status?.readOnly && !row.ro && row.r !== RowKind.Close && row.r !== RowKind.TableHead;
}

function pathLabel(s: PathStyle): string {
  return { jsonpath: t('JSONPath'), js: t('JavaScript path'), jq: t('jq filter'), pointer: t('JSON Pointer'), xpath: t('XPath') }[s];
}

function move(row: Row, dir: -1 | 1): void {
  if (canEditRow(row) && row.pid >= -1 && row.kk !== KeyKind.None) doEdit({ op: 'move', id: row.id, dir });
}

function rowMenu(row: Row, x: number, y: number): void {
  const st = S.status;
  const id = row.id;
  const editable = canEditRow(row);
  const isC = isContainer(row) || row.r === RowKind.TableRow ? row.t === Kind.Obj || row.t === Kind.Arr : false;
  const items: MenuItem[] = [];
  const copy = (what: 'value' | 'json' | 'yaml' | 'xml' | 'key' | 'path', style?: PathStyle) => () => {
    send({ type: 'copyNode', id, what, style });
    if (style) S.pathStyle = style;
    persist();
    toast(t('Copied'));
  };
  // text selected in the list: copying exactly that comes first
  const picked = selectionIn(vl.el);
  if (picked) {
    const text = serialize(picked, copyOpts());
    items.push({ label: t('Copy selected text'), icon: 'copy', kbd: 'Ctrl+C', run: () => (copyText(text), toast(t('Copied'))) });
  }
  if (!isC && row.t !== Kind.Obj && row.t !== Kind.Arr) items.push({ label: t('Copy value'), icon: 'copy', kbd: picked ? undefined : 'Ctrl+C', run: copy('value') });
  items.push({ label: t('Copy as JSON'), icon: 'braces', run: copy('json') });
  items.push({ label: t('Copy as YAML'), icon: 'list', run: copy('yaml') });
  if (S.format === 'xml') items.push({ label: t('Copy as XML'), icon: 'code', run: copy('xml') });
  if (row.kk !== KeyKind.None && row.kk !== KeyKind.Index) items.push({ label: t('Copy key'), icon: 'text', run: copy('key') });
  items.push({ sep: true }, { header: true, label: t('Copy path') });
  for (const s of st?.pathStyles ?? ['jsonpath']) items.push({ label: pathLabel(s), icon: 'link', kbd: s === (S.pathStyle ?? st?.pathStyles[0]) ? 'Ctrl+Shift+C' : undefined, run: copy('path', s) });
  if (S.format !== 'xml') {
    items.push({ sep: true });
    const prim = row.t !== Kind.Obj && row.t !== Kind.Arr && row.t !== Kind.Alias;
    if (prim && row.r === RowKind.Node) items.push({ label: t('Edit value'), icon: 'edit', kbd: 'Enter', disabled: !editable, run: () => startEdit(row, 'value') });
    if (row.kk === KeyKind.Prop || row.kk === KeyKind.Section) items.push({ label: t(row.kk === KeyKind.Section ? 'Rename section' : 'Rename key'), icon: 'edit', kbd: 'F2', disabled: !editable, run: () => startEdit(row, 'key') });
    if (row.t === Kind.Obj || row.t === Kind.Arr) {
      const lbl = S.layout === 'ini' ? (row.kk === KeyKind.Section ? 'Add entry…' : 'Add entry…') : row.t === Kind.Arr ? 'Add item…' : 'Add property…';
      items.push({ label: t(lbl), icon: 'plus', kbd: 'Insert', disabled: !!st?.readOnly || !!row.ro, run: () => addForm(row) });
    }
    if (row.kk === KeyKind.Index || row.kk === KeyKind.Prop) items.push({ label: t('Insert after…'), icon: 'plus', disabled: !editable, run: () => addForm(row, true) });
    if (row.kk !== KeyKind.None && row.kk !== KeyKind.Doc) {
      items.push({ label: t('Duplicate'), icon: 'copy', kbd: 'Ctrl+D', disabled: !editable || row.kk === KeyKind.Section, run: () => doEdit({ op: 'duplicate', id }) });
      items.push({ label: t('Move up'), icon: 'arrowUp', kbd: 'Alt+↑', disabled: !editable || row.kk === KeyKind.Section, run: () => doEdit({ op: 'move', id, dir: -1 }) });
      items.push({ label: t('Move down'), icon: 'arrowDown', kbd: 'Alt+↓', disabled: !editable || row.kk === KeyKind.Section, run: () => doEdit({ op: 'move', id, dir: 1 }) });
      items.push({ label: t('Delete'), icon: 'trash', kbd: 'Del', disabled: !editable, run: () => doEdit({ op: 'delete', id }) });
    }
    if (S.layout === 'ini' && row.kk === KeyKind.None) items.push({ label: t('Add section…'), icon: 'plus', run: () => addForm(row) });
  }
  if (isContainer(row) && row.n) {
    items.push({ sep: true });
    items.push({ label: t('Expand children'), icon: 'expand', kbd: '*', run: () => toggle(row, true, true) });
    items.push({ label: t('Collapse children'), icon: 'collapse', run: () => toggle(row, false, true) });
    if (row.tb) items.push({ label: t(row.tb === 2 ? 'Show as tree' : 'Show as table'), icon: 'table', run: () => send({ type: 'table', id, on: row.tb !== 2 }) });
  }
  if (row.t === Kind.Str && row.v && /^(https?|ftp|mailto):/i.test(row.v)) items.push({ label: t('Open link'), icon: 'link', run: () => send({ type: 'openUrl', url: row.v! }) });
  if (row.alias !== undefined) items.push({ label: t('Go to anchor'), icon: 'arrowUp', run: () => send({ type: 'reveal', id: row.alias! }) });
  items.push({ sep: true });
  items.push({ label: t('Reveal in source'), icon: 'code', run: () => send({ type: 'source', id }) });
  showMenu(items, x, y);
}

function doEdit(op: EditOp): void {
  if (S.status?.readOnly) return toast(S.status.readOnly, 'error');
  send({ type: 'edit', edit: op });
}

// ---------------------------------------------------------------------------------------------------------------
// Inline editing

type VT = 'string' | 'number' | 'boolean' | 'null';
interface Editing {
  row: Row;
  r: number;
  what: 'key' | 'value';
  box: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  type: VT;
  anchor?: HTMLElement;
  done: boolean;
}
let editing: Editing | undefined;

function kindType(k: Kind): VT {
  return k === Kind.Num ? 'number' : k === Kind.True || k === Kind.False ? 'boolean' : k === Kind.Null ? 'null' : 'string';
}

function startEdit(row: Row, what: 'key' | 'value', anchor?: HTMLElement, word?: [number, number]): void {
  if (!canEditRow(row)) {
    if (S.status?.readOnly) toast(S.status.readOnly, 'error');
    return;
  }
  if (what === 'key' && row.kk !== KeyKind.Prop && row.kk !== KeyKind.Section) return;
  if (what === 'value' && (row.t === Kind.Obj || row.t === Kind.Arr || row.t === Kind.Alias)) return;
  if (what === 'value' && row.tr) {
    pendingEdit = { row, anchor, word };
    send({ type: 'getValue', id: row.id, purpose: 'edit' });
    return;
  }
  openEditor(row, what, what === 'key' ? String(row.k ?? '') : row.v ?? '', anchor, word);
}
let pendingEdit: { row: Row; anchor?: HTMLElement; word?: [number, number] } | undefined;

function openEditor(row: Row, what: 'key' | 'value', text: string, anchor?: HTMLElement, word?: [number, number]): void {
  closeEditor(false);
  const multi = what === 'value' && (text.includes('\n') || text.length > 200);
  const input = multi ? (h('textarea', { spellcheck: 'false', rows: '6' }) as HTMLTextAreaElement) : (h('input', { type: 'text', spellcheck: 'false' }) as HTMLInputElement);
  input.value = text;
  const type: VT = what === 'key' ? 'string' : kindType(row.t);
  const box = h('div', { class: 'tv-editor' + (multi ? ' multi' : '') });
  const err = h('span', { class: 'tv-ed-err' });
  const typeSel = h('select', { class: 'tv-type', 'aria-label': t('Type') }) as HTMLSelectElement;
  for (const ty of ['string', 'number', 'boolean', 'null'] as VT[]) typeSel.append(h('option', { value: ty, selected: ty === type }, t(ty)));
  const ed: Editing = { row, r: S.sel, what, box, input, type, anchor, done: false };
  typeSel.onchange = () => {
    ed.type = typeSel.value as VT;
    if (ed.type === 'boolean' && !/^(true|false)$/.test(input.value)) input.value = 'true';
    if (ed.type === 'null') input.value = 'null';
    input.disabled = ed.type === 'null';
    validate();
    input.focus();
  };
  const validate = (): boolean => {
    let msg = '';
    const v = input.value.trim();
    if (what === 'key' && !input.value) msg = t('A key is required');
    else if (ed.type === 'number' && !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v) && !(S.format === 'yaml' || S.format === 'toml')) msg = t('Not a valid number');
    else if (ed.type === 'boolean' && !/^(true|false)$/i.test(v)) msg = t('Expected true or false');
    err.textContent = msg;
    box.classList.toggle('bad', !!msg);
    return !msg;
  };
  input.addEventListener('input', validate);
  for (const ev of ['input', 'select', 'keyup', 'mouseup']) input.addEventListener(ev, updateSelInfo);
  input.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Escape') {
      ke.preventDefault();
      closeEditor(false);
    } else if (ke.key === 'Enter' && (!multi || ke.ctrlKey || ke.metaKey)) {
      ke.preventDefault();
      if (validate()) closeEditor(true);
    } else if (ke.key === 'Tab') {
      ke.preventDefault();
      if (validate()) closeEditor(true);
    }
    ke.stopPropagation();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (editing === ed && !box.contains(document.activeElement)) {
        if (validate()) closeEditor(true);
        else closeEditor(false);
      }
    }, 0);
  });
  box.append(input);
  if (what === 'value' && S.format !== 'ini' && S.format !== 'env') box.append(typeSel);
  box.append(err);
  main.append(box);
  editing = ed;
  positionEditor();
  input.focus();
  if (word) input.setSelectionRange(word[0], word[1]);
  else if (input instanceof HTMLInputElement) input.select();
  validate();
  updateSelInfo();
}

/** Left edge of the first character shown in `el` (after a ::before quote mark), or of `el` itself. */
function textLeft(el: HTMLElement): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n as Text).data.trim() || n.parentElement?.closest(NO_COPY)) continue;
    const r = document.createRange();
    r.setStart(n, 0);
    r.setEnd(n, 1);
    const b = r.getBoundingClientRect();
    if (b.width || b.height) return b.left;
  }
  return el.getBoundingClientRect().left;
}

function positionEditor(): void {
  const ed = editing;
  if (!ed) return;
  const rowEl = vl.elementOf(ed.r);
  if (!rowEl) {
    ed.box.style.visibility = 'hidden';
    return;
  }
  ed.box.style.visibility = '';
  const target = ed.anchor && rowEl.contains(ed.anchor) ? ed.anchor : (rowEl.querySelector<HTMLElement>(ed.what === 'key' ? '.k-prop,.ini-k,.k-sec' : '.val,.ini-v,.ev') ?? rowEl);
  const mr = main.getBoundingClientRect();
  const tr = textLeft(target);
  const rr = rowEl.getBoundingClientRect();
  // the editor's text starts where the shown text starts (border 1px + padding 3px), so editing happens in place
  const left = Math.max(0, tr - mr.left - 4);
  ed.box.style.left = left + 'px';
  ed.box.style.top = rr.top - mr.top - 1 + 'px';
  const minW = ed.what === 'key' ? 160 : 260;
  ed.box.style.width = Math.max(minW, Math.min(mr.width - left - 8, ed.box.classList.contains('multi') ? 640 : 520)) + 'px';
}

function closeEditor(commit: boolean): void {
  const ed = editing;
  if (!ed || ed.done) return;
  ed.done = true;
  editing = undefined;
  ed.box.remove();
  vl.el.focus({ preventScroll: true });
  updateSelInfo();
  if (!commit) return;
  const v = ed.input.value;
  if (ed.what === 'key') {
    if (v !== String(ed.row.k ?? '')) doEdit({ op: 'rename', id: ed.row.id, key: v });
  } else {
    const changed = v !== (ed.row.v ?? '') || ed.type !== kindType(ed.row.t);
    if (changed) doEdit({ op: 'set', id: ed.row.id, value: ed.type === 'boolean' ? v.trim().toLowerCase() : v, type: ed.type });
  }
}

// add property / item form
function addForm(row: Row, after = false): void {
  const st = S.status;
  if (st?.readOnly) return toast(st.readOnly, 'error');
  let parent = row;
  let afterId: number | undefined;
  if (after || !(row.t === Kind.Obj || row.t === Kind.Arr) || row.r !== RowKind.Node) {
    afterId = row.id;
    const pid = row.r === RowKind.TableRow ? row.tid! : row.pid;
    parent = { ...row, id: pid, t: row.kk === KeyKind.Index || row.r === RowKind.TableRow ? Kind.Arr : Kind.Obj, kk: KeyKind.None };
    if (pid < 0) parent = { ...parent, id: 0 };
  }
  const isArr = parent.t === Kind.Arr;
  const iniRoot = S.layout === 'ini' && parent.kk === KeyKind.None && !after;
  const isEnv = S.format === 'env';
  const keyIn = h('input', { type: 'text', spellcheck: 'false', placeholder: t(iniRoot && !isEnv ? 'Name' : 'Key') }) as HTMLInputElement;
  const valIn = h('input', { type: 'text', spellcheck: 'false', placeholder: t('Value') }) as HTMLInputElement;
  const err = h('div', { class: 'tv-ed-err' });
  type AddType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  let type: AddType = 'string';
  const types = S.layout === 'ini' ? (iniRoot && !isEnv ? ['string', 'object'] : ['string']) : S.format === 'toml' ? ['string', 'number', 'boolean', 'object', 'array'] : ['string', 'number', 'boolean', 'null', 'object', 'array'];
  const seg = h('div', { class: 'dv-seg tv-typeseg', role: 'tablist' });
  const setType = (ty: AddType) => {
    type = ty;
    for (const b of seg.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.t === ty));
    valIn.disabled = ty === 'null' || ty === 'object' || ty === 'array';
    if (ty === 'boolean') valIn.value = /^(true|false)$/.test(valIn.value) ? valIn.value : 'true';
    valRow.hidden = valIn.disabled;
  };
  for (const ty of types) seg.append(h('button', { 'data-t': ty, onclick: () => setType(ty as AddType) }, ty === 'object' && S.layout === 'ini' ? t('Add section…').replace('…', '') : t(ty)));
  const valRow = h('label', { class: 'tv-f' }, h('span', null, t('Value')), valIn);
  const submit = () => {
    const key = keyIn.value;
    if (!isArr && !key.trim()) {
      err.textContent = t('A key is required');
      keyIn.focus();
      return;
    }
    if (type === 'number' && !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(valIn.value.trim())) {
      err.textContent = t('Not a valid number');
      valIn.focus();
      return;
    }
    closePop();
    doEdit({ op: 'add', id: parent.id, key: isArr ? undefined : key, value: valIn.value, type, after: afterId });
  };
  const form = h(
    'form',
    { class: 'tv-form', onsubmit: (e: Event) => (e.preventDefault(), submit()) },
    h('div', { class: 'tv-form-h' }, icon('plus', 14), t(iniRoot && !isEnv ? 'Add section…' : isArr ? 'Add item…' : S.layout === 'ini' ? 'Add entry…' : 'Add property…')),
    isArr ? null : h('label', { class: 'tv-f' }, h('span', null, t(iniRoot && !isEnv ? 'Name' : 'Key')), keyIn),
    types.length > 1 ? h('div', { class: 'tv-f' }, h('span', null, t('Type')), seg) : null,
    valRow,
    err,
    h('div', { class: 'tv-form-b' }, h('button', { type: 'button', class: 'dv-btn secondary', onclick: () => closePop() }, t('Cancel')), h('button', { type: 'submit', class: 'dv-btn primary' }, t('Add'))),
  );
  setType('string');
  const el = vl.elementOf(S.sel);
  const rect = el?.getBoundingClientRect();
  showPop(form, (rect?.left ?? 40) + (row.d + 2) * IND, (rect?.bottom ?? 80) + 2, 'tv-addpop');
  (isArr ? valIn : keyIn).focus();
}

// full value popover
function showFull(id: number, anchor: HTMLElement): void {
  fullAnchor = anchor.getBoundingClientRect();
  send({ type: 'getValue', id, purpose: 'show' });
}
let fullAnchor: DOMRect | undefined;

function valuePop(text: string, truncated: boolean): void {
  const pre = h('pre', { class: 'tv-full' }, text);
  const head = h(
    'div',
    { class: 'tv-pop-h' },
    h('span', { class: 'dv-meta' }, t('{0} characters', nf.format(text.length)) + (truncated ? ' …' : '')),
    h('span', { class: 'dv-spacer' }),
    h('button', { class: 'dv-btn', onclick: () => (copyText(text), toast(t('Copied'))) }, icon('copy', 14), t('Copy')),
    h('button', { class: 'dv-iconbtn', title: t('Close'), onclick: () => closePop() }, icon('close', 14)),
  );
  const r = fullAnchor ?? new DOMRect(60, 60, 0, 0);
  showPop(h('div', null, head, pre), Math.max(8, r.left - 200), r.bottom + 4, 'tv-valpop');
}

// ---------------------------------------------------------------------------------------------------------------
// Toolbar actions

function setMode(m: Mode, syntax?: Syntax): void {
  if (m === S.mode && (!syntax || syntax === S.syntax)) return;
  closeEditor(false);
  send({ type: 'mode', mode: m, syntax });
}

function depthMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const items: MenuItem[] = [{ header: true, label: t('Expand to depth') }];
  for (let d = 1; d <= 6; d++) items.push({ label: t('Level {0}', d), icon: d === S.depth ? 'check' : undefined, run: () => send({ type: 'depth', depth: d }) });
  showMenu(items, r.left, r.bottom + 2);
}

function scopeMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const cur = S.search.scope ?? 'all';
  showMenu(
    (['all', 'keys', 'values'] as const).map((s) => ({ label: scopeLabel(s), icon: s === cur ? 'check' : undefined, run: () => setQuery({ scope: s }) })),
    r.left,
    r.bottom + 2,
  );
}

function scopeLabel(s: 'all' | 'keys' | 'values'): string {
  return s === 'keys' ? t('Keys only') : s === 'values' ? t('Values only') : t('Keys and values');
}

function errorsPop(anchor: HTMLElement): void {
  const errs = S.status?.errors ?? [];
  if (!errs.length) return;
  const list = h('div', { class: 'tv-errs' });
  errs.forEach((e, i) =>
    list.append(
      h(
        'button',
        { class: 'tv-err ' + (e.severity ?? 'error'), onclick: () => (closePop(), send({ type: 'gotoError', index: i })) },
        icon(e.severity === 'warning' ? 'warning' : 'warning', 14),
        h('span', { class: 'pos' }, t('Line {0}, column {1}', e.line, e.col)),
        h('span', { class: 'msg' }, e.message),
      ),
    ),
  );
  const r = anchor.getBoundingClientRect();
  showPop(list, r.right - 380, r.bottom + 4, 'tv-errpop');
}

// ---------------------------------------------------------------------------------------------------------------
// Search

let searchTimer = 0;
function setQuery(patch: Partial<SearchQuery>, immediate = true): void {
  S.search = { ...S.search, ...patch };
  syncSearchUi();
  persist();
  clearTimeout(searchTimer);
  const go = () => {
    searchTimer = 0;
    send({ type: 'search', query: S.search });
  };
  if (immediate) go();
  else searchTimer = window.setTimeout(go, 120);
}

function clearSearch(focusInput: boolean): void {
  searchInput.value = '';
  setQuery({ text: '' });
  if (focusInput) searchInput.focus();
  else vl.el.focus();
}

function nav(dir: 1 | -1): void {
  if (S.count) send({ type: 'searchNav', dir });
}

function compileHl(): void {
  const q = S.search;
  hlRe = undefined;
  if (!q.text) return;
  try {
    let src = q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (q.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    hlRe = new RegExp(src, 'g' + (q.caseSensitive ? '' : 'i') + (q.wholeWord ? 'u' : ''));
  } catch {
    hlRe = undefined;
  }
}

function syncSearchUi(): void {
  const q = S.search;
  btnCase.setAttribute('aria-pressed', String(q.caseSensitive));
  btnWord.setAttribute('aria-pressed', String(!!q.wholeWord));
  btnRegex.setAttribute('aria-pressed', String(q.regex));
  btnFilter.setAttribute('aria-pressed', String(q.filter));
  btnScope.textContent = q.scope === 'keys' ? t('Keys') : q.scope === 'values' ? t('Values') : t('All');
  btnScope.title = scopeLabel(q.scope ?? 'all');
  btnScope.setAttribute('aria-pressed', String((q.scope ?? 'all') !== 'all'));
  searchBox.classList.toggle('has', !!q.text);
  searchBox.classList.toggle('bad', !!S.searchErr);
  let c = '';
  if (q.text) {
    if (S.searchErr) c = t('Invalid regular expression');
    else if (!S.count && !S.searchBusy) c = t('No results');
    else c = (S.current >= 0 ? t('{0} of {1}', nf.format(S.current + 1), nf.format(S.count)) : nf.format(S.count)) + (S.searchBusy ? '…' : '');
  }
  searchCount.textContent = c;
  searchCount.title = S.searchErr;
  btnPrev.disabled = btnNext.disabled = !S.count;
  compileHl();
}

searchInput.addEventListener('input', () => setQuery({ text: searchInput.value }, false));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'F3') {
    e.preventDefault();
    if (searchTimer) {
      // the debounced query hasn't gone out yet: send it now instead of stepping
      clearTimeout(searchTimer);
      searchTimer = 0;
      send({ type: 'search', query: S.search });
    } else nav(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (searchInput.value) clearSearch(false);
    else vl.el.focus();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    vl.el.focus();
  }
  e.stopPropagation();
});

// global keys
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inField = (e.target as HTMLElement).closest('input,textarea,select');
  if (mod && (e.key === 'f' || e.key === 'F') && !e.shiftKey) {
    e.preventDefault();
    focusSearch();
  } else if (e.key === 'F3') {
    e.preventDefault();
    nav(e.shiftKey ? -1 : 1);
  } else if (e.key === '/' && !inField) {
    e.preventDefault();
    focusSearch();
  } else if (e.key === 'Escape' && popOpen()) {
    closePop();
  } else if (e.key === 'Escape') closeMenu();
});

function focusSearch(): void {
  searchInput.focus();
  searchInput.select();
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering of host state

function renderStatus(st: Status): void {
  const errs = st.errors.filter((e) => e.severity !== 'warning');
  const warns = st.errors.length - errs.length;
  btnFormat.disabled = !st.canFormat;
  btnMinify.disabled = !st.canMinify;
  btnSort.disabled = !st.canSort;
  btnFormat.hidden = !st.canFormat && !['json', 'yaml'].includes(st.format);
  btnMinify.hidden = st.format !== 'json';
  btnSort.hidden = !['json', 'yaml'].includes(st.format);
  valid.className = 'tv-valid ' + (errs.length ? 'bad' : warns ? 'warn' : 'ok');
  valid.replaceChildren(icon(errs.length ? 'warning' : warns ? 'info' : 'check', 14), errs.length ? (errs.length === 1 ? t('1 error') : t('{0} errors', errs.length)) : warns ? t('{0} warnings', warns) : t('Valid'));
  valid.disabled = !st.errors.length;
  // syntax switch for pretty mode
  segSyntax.hidden = S.mode !== 'pretty' || st.syntaxes.length < 2;
  segSyntax.replaceChildren(...st.syntaxes.map((s) => h('button', { role: 'tab', 'aria-selected': String(s === S.syntax), onclick: () => setMode('pretty', s) }, s.toUpperCase())));
  for (const b of segMode.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.mode === S.mode));
  btnDepth.replaceChildren(icon('list', 14), h('span', null, S.depth >= 1e6 ? '∞' : String(S.depth)), icon('chevronDown', 12));
  btnCollapse.disabled = btnExpand.disabled = btnDepth.disabled = false;
  // banner
  if (errs.length) {
    const e = errs[0];
    banner.hidden = false;
    banner.className = 'dv-banner error tv-banner';
    const nodes: (Node | null)[] = [
      icon('warning', 14),
      h('span', { class: 'pos' }, t('Line {0}, column {1}', e.line, e.col)),
      h('span', { class: 'msg' }, e.message),
      st.stale ? h('span', { class: 'stale' }, t('Showing the last valid version. Fix the errors to edit.')) : null,
      h('span', { class: 'dv-spacer' }),
      errs.length > 1 ? h('button', { class: 'dv-btn', onclick: (ev: Event) => errorsPop(ev.currentTarget as HTMLElement) }, t('More errors') + ` (${errs.length})`) : null,
      h('button', { class: 'dv-btn', onclick: () => send({ type: 'gotoError', index: st.errors.indexOf(e) }) }, icon('code', 14), t('Show in source')),
    ];
    banner.replaceChildren(...(nodes.filter(Boolean) as Node[]));
  } else banner.hidden = true;
  // status bar
  const parts: (Node | string)[] = [h('span', { class: 'tv-fmt' }, st.label), h('span', null, t('{0} nodes', nf.format(st.nodes))), h('span', null, fmtBytes(st.bytes))];
  if (st.parseMs !== undefined && st.parseMs > 50) parts.push(h('span', { class: 'v-muted' }, `${nf.format(st.parseMs)} ms`));
  if (st.readOnly) parts.push(h('span', { class: 'tv-ro', title: st.readOnly }, icon('eye', 12), t('Read-only')));
  statusBar.replaceChildren(...parts, h('span', { class: 'dv-spacer' }), selInfo, h('span', { class: 'mono tv-path', title: t('Selected path') }, S.path));
  updateSelInfo();
}

function renderEmpty(): void {
  const none = S.total === 0 && S.status && !S.status.errors.length;
  const noMatch = S.total === 0 && S.search.filter && !!S.search.text;
  empty.hidden = !(none || noMatch);
  if (!empty.hidden) {
    empty.replaceChildren(icon(noMatch ? 'search' : 'braces', 28), h('div', null, noMatch ? t('No matches') : t('Empty document')), noMatch ? h('button', { class: 'dv-btn secondary', onclick: () => clearSearch(true) }, t('Clear search')) : h('button', { class: 'dv-btn secondary', onclick: () => send({ type: 'action', name: 'openText' }) }, icon('code', 14), t('Open as text')));
  }
}

function onView(m: ViewMsg): void {
  const modeChanged = m.mode !== S.mode || m.syntax !== S.syntax || m.layout !== S.layout;
  S.mode = m.mode;
  S.syntax = m.syntax;
  S.layout = m.layout;
  S.keyWidth = m.keyWidth ?? 12;
  S.version = m.version;
  S.total = m.total;
  S.depth = m.depth;
  S.status = m.status;
  S.format = m.status.format;
  document.body.dataset.mode = m.mode;
  document.body.dataset.layout = m.layout;
  document.body.dataset.syntax = m.syntax;
  if (modeChanged) {
    TABLES.clear();
    S.tableW = 0;
    vl.setWidth(0);
  }
  vl.setRowHeight(rowH());
  const top = vl.scrollTop();
  vl.reset(m.total, m.version, m.start, m.rows);
  if (m.sel !== undefined && m.sel >= 0) {
    S.sel = m.sel;
    S.selId = m.selId ?? -1;
  } else if (m.sel === -1 && !m.keepScroll) S.sel = -1;
  if (S.sel >= m.total) S.sel = m.total - 1;
  if (!S.ready) {
    S.ready = true;
    if (saved.scrollTop && saved.uri === S.fileName && m.scrollTo === undefined) vl.setScrollTop(saved.scrollTop);
  }
  if (m.scrollTo !== undefined && m.scrollTo >= 0) vl.reveal(m.scrollTo, 'center');
  else if (m.keepScroll) vl.setScrollTop(top);
  vl.el.setAttribute('aria-activedescendant', S.sel >= 0 ? 'r' + S.sel : '');
  vl.paint();
  updateSticky();
  renderStatus(m.status);
  renderEmpty();
  if (editing) positionEditor();
  persist();
}

onMessage<HostMsg>((m) => {
  switch (m.type) {
    case 'init':
      setStrings(m.strings);
      S.fileName = m.fileName;
      S.format = m.format;
      S.indent = m.indent;
      S.ch = measureCh();
      document.body.dataset.format = m.format;
      vl.el.setAttribute('aria-label', m.fileName);
      if (saved.uri && saved.uri !== m.fileName) S.search = { ...S.search, text: '' };
      buildToolbar();
      return;
    case 'view':
      onView(m);
      return;
    case 'rows':
      vl.fill(m.version, m.start, m.rows);
      vl.paint();
      updateSticky();
      if (S.sel >= 0 && S.selId < 0) S.selId = vl.cache.get(S.sel)?.id ?? -1;
      return;
    case 'search':
      S.count = m.count;
      S.current = m.current;
      S.searchBusy = !!m.busy;
      S.searchErr = m.error ?? '';
      syncSearchUi();
      vl.invalidate();
      return;
    case 'selection': {
      S.selId = m.id;
      S.path = m.path;
      renderCrumbs(m.crumbs);
      const p = statusBar.querySelector('.tv-path');
      if (p) p.textContent = m.path;
      return;
    }
    case 'busy':
      barBusy.hidden = !m.on;
      busy.hidden = !(m.on && S.total === 0);
      busy.querySelector('span')!.textContent = m.text ? t(m.text) : '';
      return;
    case 'value':
      if (m.purpose === 'edit' && pendingEdit && pendingEdit.row.id === m.id) {
        const pe = pendingEdit;
        pendingEdit = undefined;
        openEditor(pe.row, 'value', m.text, pe.anchor, pe.word);
      } else valuePop(m.text, !!m.truncated);
      return;
    case 'notice':
      toast(m.text, m.kind);
      return;
    case 'focusSearch':
      focusSearch();
      return;
  }
});

function renderCrumbs(list: { id: number; label: string; kk: KeyKind }[]): void {
  const parts: Node[] = [h('button', { class: 'cr root', onclick: () => vl.setScrollTop(0) }, S.status?.format === 'xml' ? '/' : '$')];
  const max = 12;
  const shown = list.length > max ? [...list.slice(0, 2), null, ...list.slice(-max + 3)] : list;
  for (const c of shown) {
    parts.push(h('span', { class: 'cr-sep' }, icon('chevronRight', 12)));
    if (!c) {
      parts.push(h('span', { class: 'cr-more' }, '…'));
      continue;
    }
    const label = c.kk === KeyKind.Index ? `[${c.label}]` : c.kk === KeyKind.Doc ? t('Document {0}', Number(c.label) + 1) : c.kk === KeyKind.Attr ? '@' + c.label : c.kk === KeyKind.Elem ? `<${c.label}>` : c.kk === KeyKind.Section ? `[${c.label}]` : c.label;
    parts.push(h('button', { class: 'cr k' + c.kk, title: label, onclick: () => send({ type: 'reveal', id: c.id }) }, label.length > 40 ? label.slice(0, 40) + '…' : label));
  }
  const copyBtn = h('button', { class: 'dv-iconbtn sm', title: t('Copy the path'), onclick: () => (send({ type: 'copyNode', id: S.selId, what: 'path', style: S.pathStyle }), toast(t('Copied'))) }, icon('copy', 14));
  crumbs.replaceChildren(h('div', { class: 'cr-list' }, ...parts), copyBtn);
  const list2 = crumbs.querySelector('.cr-list');
  if (list2) list2.scrollLeft = list2.scrollWidth;
}

// ---------------------------------------------------------------------------------------------------------------

initList();
crumbs.replaceChildren(h('div', { class: 'cr-list' }, h('span', { class: 'cr root' }, '$')));
vl.el.addEventListener('scroll', () => {
  if (!stickyHead.hidden) {
    const el = stickyHead.firstElementChild as HTMLElement | null;
    if (el) el.style.transform = `translateX(${-vl.el.scrollLeft}px)`;
  }
});
window.addEventListener('resize', () => positionEditor());
send({ type: 'ready', state: saved });
