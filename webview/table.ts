// Data Viewer table page: CSV/TSV/JSONL/Parquet grid and the log view.
import { fmtBytes, getState, h, icon, nf, onMessage, post, rafThrottle, setState, setStrings, t } from './shared/vscode';
import type { ColMeta, CopyFormat, Density, EditOp, FileInfo, Filter, FilterOp, Meta, Query, RowData, Settings, Stats, ToHost, ToView } from '../src/table/protocol';
import { RowCache } from './table/cache';
import { DetailPanel, typeLabel } from './table/detail';
import { Col, Grid, GridHost, Sel, TYPE_ICON } from './table/grid';
import { closePopup, MenuItem, openMenu, openPopover, repositionPopup } from './table/popup';
import { highlighter } from './table/render';

// ------------------------------------------------------------------------------------------------------------------
// State

interface UiState {
  v: 2;
  y: number;
  x: number;
  sel?: Sel;
  widths: Record<string, number>;
  hidden: number[];
  pinned: number[];
  wrap?: boolean;
  density?: Density;
  detail: boolean;
  detailW: number;
  query?: Query;
  search: { q: string; regex: boolean; matchCase: boolean; word?: boolean; scope?: number; filter?: boolean };
  hasHeader?: boolean;
  follow?: boolean;
  dismissed?: boolean;
  tab?: 'record' | 'schema';
}

const saved = getState<UiState>();
const st: UiState = saved && saved.v === 2 ? saved : { v: 2, y: 0, x: 0, widths: {}, hidden: [], pinned: [], detail: false, detailW: 380, search: { q: '', regex: false, matchCase: false } };
const send = (m: ToHost) => post(m);
let saveTimer = 0;
function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => setState(st), 250);
}

let file: FileInfo | undefined;
let settings: Settings = { density: 'normal', wrap: false, follow: true };
let meta: Meta | undefined;
let lastQueryJson = '';
const cache = new RowCache();
let grid: Grid | undefined;
let detail: DetailPanel | undefined;
let isLog = false;
let busy: { task: string; pct: number } | undefined;
let restored = false;
interface SearchState {
  id: number;
  total: number;
  /** [viewRow, logicalCol] pairs in scan order: from `from` to the end, then wrapping around */
  hits: number[];
  from: number;
  /** pair index where the scan wrapped to the top (-1 = not yet) */
  wrapAt: number;
  cur: number;
  done: boolean;
  capped: boolean;
  jumped: boolean;
  levels?: number[];
  ms?: number;
}
let search: SearchState = { id: 0, total: 0, hits: [], from: 0, wrapAt: -1, cur: -1, done: true, capped: false, jumped: true };
let searchActive = true;
let seedVer = -1;
let changedBanner = false;
let errorMsg: string | undefined;

const app = document.getElementById('app')!;
const ROW_H: Record<Density, number> = { compact: 22, normal: 26, comfortable: 32 };
const HEAD_H: Record<Density, number> = { compact: 28, normal: 30, comfortable: 34 };

// Extra icons in the shared 16px / 1.5px stroke style.
const EXTRA: Record<string, string> = {
  panel: 'M2.5 2.5h11v11h-11zM9.5 2.5v11',
  density: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  header: 'M2.5 3h11v10h-11zM2.5 6.5h11M6 3v3.5M9.5 3v3.5',
  tail: 'M8 2.5v7M5 7l3 3 3-3M3.5 13.5h9',
  regex: 'M11 2.5v5M8.8 3.8l4.4 2.4M8.8 6.2l4.4-2.4M3 11.5h3v3H3z',
  caseIcon: 'M2 12.5L4.75 4.5 7.5 12.5M3 10h3.5M12.5 8v4.5M12.5 9.5a2 2 0 1 0 0 2.5',
  bug: 'M8 4.5a3 3 0 0 1 3 3v2.5a3 3 0 0 1-6 0V7.5a3 3 0 0 1 3-3zM5 8.5H2.5M13.5 8.5H11M5.5 4.5L4 3M10.5 4.5L12 3M5 11.5l-2 1.5M11 11.5l2 1.5',
  word: 'M2.5 5.5v5h11v-5M5 8.5h.01M8 8.5h.01M11 8.5h.01',
  scope: 'M2.5 2.5h11v11h-11zM6.5 2.5v11M9.5 2.5v11M6.5 6h3',
};
function ic(name: string, size = 16): SVGSVGElement {
  if (!EXTRA[name]) return icon(name, size);
  const svg = icon('info', size);
  svg.querySelector('path')!.setAttribute('d', EXTRA[name]);
  return svg;
}

// ------------------------------------------------------------------------------------------------------------------
// Layout skeleton

const toolbar = h('div', { class: 'dv-toolbar tb-main', role: 'toolbar' });
const chipsBar = h('div', { class: 'tb-chips' });
const banners = h('div', { class: 'tb-banners' });
const main = h('div', { class: 'tb-main-area' });
const gridWrap = h('div', { class: 'tb-grid' });
const status = h('div', { class: 'dv-status tb-status', role: 'status' });
main.append(gridWrap);
app.append(toolbar, chipsBar, banners, main, status);
// before the host's first message (strings not loaded yet): spinner + skeleton rows in the page language
const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
gridWrap.append(
  h(
    'div',
    { class: 'tb-loading' },
    h('div', { class: 'tb-loading-msg' }, h('div', { class: 'dv-spinner' }), h('span', null, zh ? '正在打开…' : 'Opening…')),
    ...Array.from({ length: 12 }, () => h('div', { class: 'tb-skel' })),
  ),
);
/** Thin progress bar over the grid while indexing / sorting / filtering. */
const progressBar = h('div', { class: 'tb-progress', role: 'progressbar', 'aria-hidden': 'true' }, h('div', { class: 'tb-progress-fill' }));

// ------------------------------------------------------------------------------------------------------------------
// Columns

function colByKey(key: number): ColMeta | undefined {
  return meta?.columns.find((c) => c.key === key);
}
function liOf(key: number): number {
  return meta ? meta.columns.findIndex((c) => c.key === key) : -1;
}
const hiddenSet = () => new Set(st.hidden);

/** Display order: pinned (in pin order) then the rest, without hidden columns. */
function displayKeys(): number[] {
  if (!meta) return [];
  const hidden = hiddenSet();
  const keys = meta.columns.map((c) => c.key);
  const pins = st.pinned.filter((k) => keys.includes(k) && !hidden.has(k));
  return [...pins, ...keys.filter((k) => !pins.includes(k) && !hidden.has(k))];
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(s: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}
let cellFont = '';
let headFont = '';
function fonts(): void {
  const probe = h('div', { class: 'tg-c' }, 'x');
  const hp = h('div', { class: 'tg-h' }, h('span', { class: 'tg-hn' }, 'x'));
  const holder = h('div', { class: 'tg tb-probe' }, probe, hp);
  document.body.append(holder);
  const cs = getComputedStyle(probe);
  cellFont = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const hs = getComputedStyle(hp.firstChild as HTMLElement);
  headFont = `${hs.fontWeight} ${hs.fontSize} ${hs.fontFamily}`;
  const mono = h('span', { class: 'tg-c log' }, 'x'.repeat(100));
  holder.append(mono);
  const mw = mono.getBoundingClientRect().width / 100;
  holder.remove();
  if (grid && mw > 3) grid.setCharWidth(isLog ? mw : textWidth('0', cellFont) || 7);
}

function autoWidth(key: number): number {
  const c = colByKey(key);
  if (!c) return 120;
  const li = liOf(key);
  const head = textWidth(c.name, headFont) + 62;
  let max = 0;
  const rows = cache.loadedRows().slice(0, 300);
  for (const r of rows) {
    const v = r.c[li] ?? '';
    const s = v.length > 80 ? v.slice(0, 80) : v;
    if (!s) continue;
    const w = s.length * 9 < max ? 0 : textWidth(s.replace(/\s+/g, ' '), cellFont);
    if (w > max) max = w;
  }
  const isNum = c.type === 'int' || c.type === 'float';
  const want = Math.max(head, max + 24);
  return Math.round(Math.max(isNum ? 64 : 72, Math.min(c.type === 'json' ? 420 : 340, want)));
}

function buildCols(): Col[] {
  if (!meta) return [];
  const pins = new Set(st.pinned);
  return displayKeys().map((key) => {
    const c = colByKey(key)!;
    return { key, li: liOf(key), name: c.name, type: c.type, w: st.widths[key] ?? 0, pinned: pins.has(key) };
  });
}

let widthsPending = false;
function syncColumns(): void {
  if (!grid || !meta) return;
  const cols = buildCols();
  const haveRows = cache.loadedRows().length > 0 || meta.count === 0;
  for (const c of cols)
    if (!c.w) {
      if (isLog) c.w = 400;
      else if (haveRows) {
        c.w = autoWidth(c.key);
        st.widths[c.key] = c.w;
      } else {
        c.w = Math.max(80, Math.min(240, textWidth(c.name, headFont || '600 12px sans-serif') + 62));
        widthsPending = true;
      }
    }
  grid.setColumns(cols);
  send({ type: 'viewCols', keys: cols.map((c) => c.key) });
}

// ------------------------------------------------------------------------------------------------------------------
// Grid host

const gridHost: GridHost = {
  row: (r) => cache.get(r),
  need: (r0, r1) => cache.need(r0, r1, meta?.count ?? 0),
  selectionChanged: () => {
    selVersion++;
    if (st.sel?.fr !== grid!.sel.fr) scheduleDetail();
    st.sel = grid!.sel;
    persist();
    updateStatus();
  },
  headerClick: (col) => cycleSort(col.key),
  headerMenu: (col, anchor) => columnMenu(col, anchor),
  contextMenu: (e, onHeader) => (onHeader ? columnMenu(onHeader, { x: e.clientX, y: e.clientY }) : cellMenu(e)),
  commitEdit: (r, col, value) => {
    const row = cache.get(r);
    const old = row ? (row.k?.[col.li] === 'z' ? '' : (row.c[col.li] ?? '')) : undefined;
    if (old === value && !row?.tr?.includes(col.li)) return;
    cache.patch(r, col.li, value);
    grid!.invalidate();
    edit({ op: 'set', row: r, key: col.key, value });
  },
  editValue: async (r, col) => {
    const row = cache.get(r);
    if (!row) return undefined;
    if (row.tr?.includes(col.li)) {
      const full = await fetchRecord(r);
      return full?.c[col.li] ?? row.c[col.li];
    }
    return row.k?.[col.li] === 'z' ? '' : (row.c[col.li] ?? '');
  },
  copy: () => copySelection('tsv', false),
  paste: () => send({ type: 'pasteReq' }),
  clear: () => {
    const [r0, r1, c0, c1] = grid!.selRect();
    const rows: number[] = [];
    for (let r = r0; r <= Math.min(r1, r0 + 100000); r++) rows.push(r);
    edit({ op: 'clear', rows, keys: grid!.cols.slice(c0, c1 + 1).map((c) => c.key) });
  },
  widthChanged: (col) => {
    st.widths[col.key] = col.w;
    persist();
  },
  fitWidth: (col) => {
    col.w = autoWidth(col.key);
    st.widths[col.key] = col.w;
    grid!.relayout();
    persist();
  },
  highlighter: () => currentRe,
  isHit: (r, li) => {
    if (search.cur < 0) return false;
    return search.hits[search.cur * 2] === r && search.hits[search.cur * 2 + 1] === li;
  },
  sortOf: (key) => (st.query?.sort?.key === key ? st.query.sort.dir : undefined),
  filtered: (key) => !!st.query?.filters.some((f) => f.key === key),
  canEdit: () => !!meta && !meta.readOnly,
  find: () => focusSearch(),
  scrolled: () => {
    st.y = grid!.scrollY;
    st.x = grid!.scrollX;
    persist();
    if (isLog) updateFollowButton();
  },
};

let currentRe: RegExp | undefined;
let selVersion = 0;

function edit(op: EditOp): void {
  send({ type: 'edit', edit: op });
}

// ------------------------------------------------------------------------------------------------------------------
// Query (sort / filter)

function query(): Query {
  return st.query ?? { filters: [] };
}

function setQuery(q: Query): void {
  st.query = q;
  persist();
  send({ type: 'query', query: q });
  renderChips();
  grid?.invalidate();
  grid?.relayout();
}

function cycleSort(key: number): void {
  const q = query();
  const cur = q.sort?.key === key ? q.sort.dir : undefined;
  const next = cur === undefined ? 'asc' : cur === 'asc' ? 'desc' : undefined;
  setQuery({ ...q, sort: next ? { key, dir: next } : null });
}

function setSort(key: number, dir: 'asc' | 'desc' | null): void {
  setQuery({ ...query(), sort: dir ? { key, dir } : null });
}

function addFilter(f: Filter, replaceIndex?: number): void {
  const filters = query().filters.slice();
  if (replaceIndex !== undefined && replaceIndex >= 0) filters[replaceIndex] = f;
  else {
    const i = filters.findIndex((x) => x.key === f.key);
    if (i >= 0) filters[i] = f;
    else filters.push(f);
  }
  setQuery({ ...query(), filters });
}

function removeFilter(i: number): void {
  const filters = query().filters.slice();
  filters.splice(i, 1);
  setQuery({ ...query(), filters });
}

const OPS: [FilterOp, string][] = [
  ['contains', 'contains'],
  ['notContains', 'does not contain'],
  ['equals', 'equals'],
  ['notEquals', 'does not equal'],
  ['startsWith', 'starts with'],
  ['endsWith', 'ends with'],
  ['regex', 'matches regex'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['empty', 'is empty'],
  ['notEmpty', 'is not empty'],
  ['in', 'is one of'],
];
const opLabel = (op: FilterOp) => {
  const l = OPS.find((o) => o[0] === op)?.[1] ?? op;
  return /^[<>≤≥]$/.test(l) ? l : t(l);
};

function filterText(f: Filter): string {
  if (f.op === 'empty' || f.op === 'notEmpty') return opLabel(f.op);
  if (f.op === 'in') {
    const v = f.values ?? [];
    return `${opLabel(f.op)} ${v.slice(0, 2).map((x) => (x === '' ? '∅' : x)).join(', ')}${v.length > 2 ? ` +${v.length - 2}` : ''}`;
  }
  return `${opLabel(f.op)} ${f.value ?? ''}`;
}

// ------------------------------------------------------------------------------------------------------------------
// Toolbar

let searchInput: HTMLInputElement;
let searchCount: HTMLElement;
let searchBox: HTMLElement;
let scopeBtn: HTMLButtonElement | undefined;
let followBtn: HTMLButtonElement | undefined;
let headerBtn: HTMLButtonElement | undefined;
let wrapBtn: HTMLButtonElement;
let detailBtn: HTMLButtonElement | undefined;
let colsBtn: HTMLButtonElement | undefined;
let metaEl: HTMLElement;
let levelChips: HTMLElement | undefined;

function iconBtn(name: string, label: string, onclick: (e: MouseEvent) => void, pressed?: boolean): HTMLButtonElement {
  return h('button', { class: 'dv-iconbtn', title: label, 'aria-label': label, 'aria-pressed': pressed === undefined ? undefined : String(pressed), onclick: onclick as EventListener }, ic(name));
}

function toggle(btn: HTMLButtonElement, on: boolean): void {
  btn.setAttribute('aria-pressed', String(on));
}

function buildToolbar(): void {
  toolbar.textContent = '';
  const kindIcon = file!.kind === 'log' ? 'list' : file!.kind === 'jsonl' ? 'braces' : 'table';
  metaEl = h('span', { class: 'dv-meta' });
  toolbar.append(h('span', { class: 'tb-file' }, h('span', { class: 'tb-kind' }, icon(kindIcon, 14)), h('span', { class: 'dv-title', title: file!.path }, file!.name), metaEl));

  // find box (Ctrl+F): match case / whole word / regex / only this column / filter rows to matches
  searchInput = h('input', { class: 'dv-plain', type: 'text', placeholder: isLog ? t('Find in log…') : t('Find…'), 'aria-label': t('Find'), value: st.search.q, spellcheck: 'false' });
  searchCount = h('span', { class: 'dv-count', 'aria-live': 'polite' });
  const opt = (name: string, label: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = iconBtn(name, label, () => {
      set(!get());
      toggle(b, get());
      persist();
      runSearch(true);
    }, get());
    b.classList.add('tb-mini');
    return b;
  };
  const caseBtn = opt('caseIcon', t('Match case'), () => st.search.matchCase, (v) => (st.search.matchCase = v));
  const wordBtn = opt('word', t('Match whole word'), () => !!st.search.word, (v) => (st.search.word = v));
  const reBtn = opt('regex', t('Use regular expression'), () => st.search.regex, (v) => (st.search.regex = v));
  const opts: HTMLElement[] = [caseBtn, wordBtn, reBtn];
  if (!isLog) {
    scopeBtn = iconBtn('scope', t('Only search the selected column'), () => {
      if (st.search.scope !== undefined) st.search.scope = undefined;
      else if (grid?.cols[grid.sel.fc]) st.search.scope = grid.cols[grid.sel.fc].key;
      updateScopeButton();
      persist();
      runSearch(true);
    }, st.search.scope !== undefined);
    scopeBtn.classList.add('tb-mini');
    opts.push(scopeBtn);
  }
  const filterBtn = opt('filter', t('Filter rows to matches'), () => filterMode(), (v) => (st.search.filter = v));
  opts.push(filterBtn);
  searchBox = h('label', { class: 'dv-input tb-search' }, icon('search', 14), searchInput, searchCount, ...opts);
  let deb = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(deb);
    deb = window.setTimeout(() => runSearch(), 120);
  });
  searchInput.addEventListener('focus', () => {
    if (!searchActive && searchInput.value) runSearch();
  });
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'F3') {
      e.preventDefault();
      if (!searchActive || (searchInput.value !== st.search.q)) runSearch();
      else gotoHit(e.shiftKey ? -1 : 1, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInput.select();
    }
  });
  toolbar.append(
    searchBox,
    iconBtn('arrowUp', t('Previous match') + ' (Shift+Enter)', () => gotoHit(-1)),
    iconBtn('arrowDown', t('Next match') + ' (Enter)', () => gotoHit(1)),
  );

  if (isLog) {
    levelChips = h('span', { class: 'tb-levels', role: 'group', 'aria-label': t('Levels') });
    toolbar.append(levelChips);
  }
  toolbar.append(h('span', { class: 'dv-spacer' }));

  if (isLog) {
    toolbar.append(
      h(
        'span',
        { class: 'tb-group', role: 'group', 'aria-label': t('Errors') },
        h('button', { class: 'dv-btn tb-err', title: t('First error'), onclick: () => findLevel(-1, 1) }, ic('bug', 14), h('span', { class: 'tb-label' }, t('First error'))),
        iconBtn('arrowUp', t('Previous error'), () => findLevel(grid?.sel.fr ?? 0, -1)),
        iconBtn('arrowDown', t('Next error'), () => findLevel(grid?.sel.fr ?? -1, 1)),
      ),
      h('span', { class: 'dv-sep' }),
    );
  }
  if (file!.kind === 'csv') {
    headerBtn = iconBtn('header', t('First row is header'), () => {
      const v = !meta?.hasHeader;
      st.hasHeader = v;
      persist();
      send({ type: 'header', value: v });
    }, !!meta?.hasHeader);
    toolbar.append(headerBtn);
  }
  if (!isLog) {
    colsBtn = iconBtn('columns', t('Columns'), (e) => columnChooser((e.currentTarget as HTMLElement).getBoundingClientRect()));
    toolbar.append(colsBtn);
  }
  wrapBtn = iconBtn('wrap', t('Wrap text'), () => {
    st.wrap = !wrapOn();
    toggle(wrapBtn, wrapOn());
    grid?.setWrap(wrapOn());
    persist();
  }, wrapOn());
  toolbar.append(wrapBtn);
  if (!isLog)
    toolbar.append(
      iconBtn('density', t('Row density'), (e) => {
        const cur = density();
        openMenu(
          (['compact', 'normal', 'comfortable'] as Density[]).map((d) => ({ label: t(d[0].toUpperCase() + d.slice(1)), checked: cur === d, run: () => setDensity(d) })),
          (e.currentTarget as HTMLElement).getBoundingClientRect(),
          'below',
        );
      }),
    );
  if (isLog) {
    followBtn = h('button', { class: 'dv-btn tb-follow', title: t('Follow new lines'), 'aria-pressed': String(followOn()), onclick: () => setFollow(!followOn()) }, ic('tail', 14), h('span', { class: 'tb-label' }, t('Follow')));
    toolbar.append(followBtn);
  } else {
    detailBtn = iconBtn(file!.kind === 'parquet' ? 'panel' : 'panel', file!.kind === 'parquet' ? t('Schema and record details') : t('Record details'), () => setDetail(!st.detail), st.detail);
    toolbar.append(detailBtn);
  }
  toolbar.append(h('span', { class: 'dv-sep' }));
  if (!isLog) toolbar.append(iconBtn('download', t('Export view…'), () => send({ type: 'command', id: 'export' })));
  toolbar.append(h('button', { class: 'dv-btn', title: t('Open as Text'), onclick: () => send({ type: 'command', id: 'openAsText' }) }, icon('code', 14), h('span', { class: 'tb-label' }, t('Open as Text'))));
}

function wrapOn(): boolean {
  return st.wrap ?? settings.wrap;
}
function density(): Density {
  return st.density ?? settings.density;
}
function followOn(): boolean {
  return st.follow ?? settings.follow;
}

function setDensity(d: Density): void {
  st.density = d;
  persist();
  grid?.setRowHeight(ROW_H[d], HEAD_H[d]);
  document.body.dataset.density = d;
}

function setFollow(on: boolean): void {
  st.follow = on;
  persist();
  send({ type: 'follow', on });
  updateFollowButton();
  if (on) grid?.stickToBottom();
}

function updateFollowButton(): void {
  if (!followBtn) return;
  const on = followOn();
  toggle(followBtn, on);
  followBtn.classList.toggle('paused', on && !!grid && !grid.atBottom());
}

/** Ctrl/Cmd+F: focus the find box, seeded with the active cell's text when the selection moved since. */
function focusSearch(): void {
  if (!searchInput) return;
  if (grid && meta && grid.sel.mode === 'cells' && seedVer !== selVersion) {
    const [r0, r1, c0, c1] = grid.selRect();
    const col = grid.cols[grid.sel.fc];
    const row = cache.get(grid.sel.fr);
    const v = row && col && !isLog ? (row.c[col.li] ?? '') : '';
    if (r0 === r1 && c0 === c1 && v && v.length <= 120 && !/[\r\n]/.test(v) && v !== searchInput.value) {
      searchInput.value = v;
      seedVer = selVersion;
      runSearch();
    }
  }
  seedVer = selVersion;
  searchInput.focus();
  searchInput.select();
  if (!searchActive && searchInput.value) runSearch();
}

function filterMode(): boolean {
  return st.search.filter ?? isLog;
}

function updateScopeButton(): void {
  if (!scopeBtn) return;
  const on = st.search.scope !== undefined;
  toggle(scopeBtn, on);
  const name = on ? colByKey(st.search.scope!)?.name : undefined;
  const label = on && name ? t('Only searching column “{0}” (click to search all columns)', name) : t('Only search the selected column');
  scopeBtn.title = label;
  scopeBtn.setAttribute('aria-label', label);
}

function closeSearch(): void {
  searchActive = false;
  currentRe = undefined;
  search = { ...search, id: search.id + 1, hits: [], total: 0, cur: -1, done: true };
  searchBox?.classList.add('inactive');
  if (query().text) setQuery({ ...query(), text: undefined, regex: undefined, matchCase: undefined, word: undefined, keys: undefined });
  renderSearchCount();
  renderLevels();
  grid?.invalidate();
  grid?.focus();
}

// ------------------------------------------------------------------------------------------------------------------
// Log levels

const LV_CHIPS: { label: string; bits: number; cls: string }[] = [
  { label: 'Error', bits: (1 << 5) | (1 << 6), cls: 'lv5' },
  { label: 'Warn', bits: 1 << 4, cls: 'lv4' },
  { label: 'Info', bits: 1 << 3, cls: 'lv3' },
  { label: 'Debug', bits: 1 << 2, cls: 'lv2' },
  { label: 'Trace', bits: 1 << 1, cls: 'lv1' },
  { label: 'Other', bits: 1 << 0, cls: 'lv0' },
];

function renderLevels(): void {
  if (!levelChips || !meta?.levelCounts) return;
  const counts = meta.levelCounts;
  const mask = query().levels ?? 0x7f;
  levelChips.textContent = '';
  const matches = st.search.q && searchActive && search.levels ? search.levels : undefined;
  if (meta.levelsPending) levelChips.append(h('span', { class: 'tb-busy', title: t('Detecting levels…') }, h('span', { class: 'dv-spinner' })));
  levelChips.classList.toggle('matching', !!matches);
  for (const c of LV_CHIPS) {
    let n = 0;
    let m = 0;
    for (let b = 0; b < 7; b++)
      if (c.bits & (1 << b)) {
        n += counts[b] ?? 0;
        m += matches?.[b] ?? 0;
      }
    if (!n && c.label !== 'Error' && c.label !== 'Warn' && c.label !== 'Info') continue;
    const on = (mask & c.bits) === c.bits;
    levelChips.append(
      h(
        'button',
        {
          class: 'dv-chip tb-lv ' + c.cls,
          'aria-pressed': String(on),
          title: t('Click to show/hide, Alt+click to show only this level'),
          onclick: (e: Event) => {
            const ev = e as MouseEvent;
            let m = query().levels ?? 0x7f;
            if (ev.altKey || ev.ctrlKey || ev.metaKey) m = m === c.bits ? 0x7f : c.bits;
            else m = on ? m & ~c.bits : m | c.bits;
            setQuery({ ...query(), levels: m === 0x7f ? undefined : m });
          },
        },
        h('span', { class: 'tb-dot' }),
        t(c.label),
        matches ? h('span', { class: 'tb-n tb-m', title: t('{0} matching lines of {1}', nf.format(m), nf.format(n)) }, nf.format(m)) : h('span', { class: 'tb-n' }, nf.format(n)),
      ),
    );
  }
}

function findLevel(from: number, dir: 1 | -1): void {
  send({ type: 'findLevel', from, dir, mask: (1 << 5) | (1 << 6), vv: meta?.vv ?? 0 });
}

// ------------------------------------------------------------------------------------------------------------------
// Filter chips

function renderChips(): void {
  chipsBar.textContent = '';
  const q = query();
  if (isLog || !q.filters.length) {
    chipsBar.hidden = true;
    return;
  }
  chipsBar.hidden = false;
  chipsBar.append(h('span', { class: 'tb-chips-label' }, icon('filter', 14), t('Filters')));
  q.filters.forEach((f, i) => {
    const c = colByKey(f.key);
    const chip = h(
      'span',
      { class: 'dv-chip tb-fchip', 'aria-pressed': 'true' },
      h('button', { class: 'tb-fchip-main', title: t('Edit filter'), onclick: (e: Event) => filterPopover(f.key, (e.currentTarget as HTMLElement).getBoundingClientRect(), i) }, h('b', null, c?.name ?? '?'), ' ', filterText(f)),
      h('button', { class: 'tb-x', title: t('Remove filter'), 'aria-label': t('Remove filter'), onclick: () => removeFilter(i) }, icon('close', 12)),
    );
    chipsBar.append(chip);
  });
  if (q.filters.length > 1) chipsBar.append(h('button', { class: 'dv-btn tb-clear', onclick: () => setQuery({ ...q, filters: [] }) }, t('Clear all')));
}

// ------------------------------------------------------------------------------------------------------------------
// Banners

function renderBanners(): void {
  banners.textContent = '';
  if (errorMsg) banners.append(h('div', { class: 'dv-banner error' }, icon('warning', 14), h('span', null, errorMsg), h('span', { class: 'dv-spacer' }), h('button', { class: 'dv-iconbtn', 'aria-label': t('Close'), onclick: () => ((errorMsg = undefined), renderBanners()) }, icon('close', 14))));
  if (changedBanner)
    banners.append(
      h(
        'div',
        { class: 'dv-banner' },
        icon('warning', 14),
        h('span', null, t('The file has changed on disk, but you have unsaved changes here.')),
        h('span', { class: 'dv-spacer' }),
        h('button', { class: 'dv-btn primary', onclick: () => send({ type: 'command', id: 'reload' }) }, t('Reload from disk')),
        h('button', { class: 'dv-btn secondary', onclick: () => ((changedBanner = false), renderBanners()) }, t('Keep my changes')),
      ),
    );
  // logs and Parquet are read-only by nature (the status bar says so); the banner is for files one might expect to edit
  if (meta?.readOnlyReason && !st.dismissed && !meta.indexing && file?.kind !== 'log' && file?.kind !== 'parquet')
    banners.append(
      h(
        'div',
        { class: 'dv-banner info' },
        icon('info', 14),
        h('span', null, meta.readOnlyReason),
        h('span', { class: 'dv-spacer' }),
        h(
          'button',
          {
            class: 'dv-iconbtn',
            title: t('Dismiss'),
            'aria-label': t('Dismiss'),
            onclick: () => {
              st.dismissed = true;
              persist();
              renderBanners();
            },
          },
          icon('close', 14),
        ),
      ),
    );
}

// ------------------------------------------------------------------------------------------------------------------
// Status bar

function selectionSummary(): (HTMLElement | string)[] {
  if (!grid || !meta || !meta.count) return [];
  const [r0, r1, c0, c1] = grid.selRect();
  const nr = r1 - r0 + 1;
  const nc = isLog ? 1 : c1 - c0 + 1;
  const cells = nr * nc;
  if (cells <= 1 && grid.sel.mode === 'cells') {
    const col = grid.cols[grid.sel.fc];
    return col ? [h('span', { class: 'mono tb-cellref' }, `${col.name} · ${t('Row {0}', nf.format(grid.sel.fr + 1))}`)] : [];
  }
  if (isLog && nr === 1) {
    const ln = cache.get(grid.sel.fr)?.ln;
    return ln ? [h('span', { class: 'mono tb-cellref' }, t('Line {0}', nf.format(ln)))] : [];
  }
  const out: (HTMLElement | string)[] = [isLog ? t('{0} lines selected', nf.format(nr)) : `${nf.format(nr)} × ${nf.format(nc)} · ${t('{0} cells', nf.format(cells))}`];
  if (isLog || cells > 200000) return out;
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let missing = false;
  for (let r = r0; r <= r1; r++) {
    const row = cache.get(r);
    if (!row) {
      missing = true;
      continue;
    }
    for (let c = c0; c <= c1; c++) {
      const col = grid.cols[c];
      if (!col) continue;
      const v = row.c[col.li];
      if (!v || (col.type !== 'int' && col.type !== 'float' && row.k?.[col.li] !== 'n')) continue;
      const x = Number(v);
      if (isNaN(x)) continue;
      n++;
      sum += x;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  if (n) {
    const f = (x: number) => (Math.abs(x) >= 1e15 ? x.toExponential(4) : nf.format(Math.round(x * 1e4) / 1e4));
    out.push(h('span', { class: 'tb-agg' }, `${t('Sum')} ${f(sum)} · ${t('Avg')} ${f(sum / n)} · ${t('Min')} ${f(min)} · ${t('Max')} ${f(max)}${missing ? ' *' : ''}`));
  }
  return out;
}

const updateStatus = rafThrottle(() => {
  if (!meta || !file) return;
  status.textContent = '';
  const unit = isLog ? t('lines') : t('rows');
  if (meta.count !== meta.total) status.append(h('span', null, t('{0} of {1}', nf.format(meta.count), nf.format(meta.total)) + ' ' + unit));
  else status.append(h('span', null, nf.format(meta.total) + ' ' + unit + (isLog ? '' : ` · ${nf.format(meta.columns.length)} ${t('columns')}`)));
  if (meta.indexing) status.append(h('span', { class: 'tb-busy' }, h('span', { class: 'dv-spinner' }), t('Indexing… {0}% · {1} read', Math.round((meta.progress ?? 0) * 100), nf.format(meta.total))));
  if (busy && busy.task) status.append(h('span', { class: 'tb-busy' }, h('span', { class: 'dv-spinner' }), `${t(busy.task === 'sort' ? 'Sorting…' : busy.task === 'filter' ? 'Filtering…' : 'Working…')} ${Math.round(busy.pct * 100)}%`));
  const frac = busy && busy.task ? busy.pct : meta.indexing ? (meta.progress ?? 0) : -1;
  progressBar.classList.toggle('on', frac >= 0);
  if (frac >= 0) (progressBar.firstChild as HTMLElement).style.width = Math.max(2, Math.min(100, frac * 100)).toFixed(1) + '%';
  const sel = selectionSummary();
  if (sel.length) status.append(h('span', { class: 'tb-sel' }, ...sel));
  status.append(h('span', { class: 'dv-spacer' }));
  for (const w of meta.warnings) status.append(h('span', { class: 'tb-warn', title: w }, icon('warning', 12), w));
  if (meta.invalid)
    status.append(
      h(
        'button',
        { class: 'tb-warn tb-link', title: t('Go to next invalid line'), onclick: () => send({ type: 'findInvalid', from: grid?.sel.fr ?? -1, dir: 1, vv: meta!.vv }) },
        icon('warning', 12),
        t('{0} invalid lines', nf.format(meta.invalid)),
      ),
    );
  const facts: string[] = [];
  if (meta.delimiter) facts.push(t(meta.delimiter));
  facts.push(meta.encoding);
  if (file.kind !== 'parquet') facts.push(meta.eol);
  status.append(h('span', null, facts.join(' · ')));
  if (meta.readOnly && !meta.indexing) status.append(h('span', { class: 'dv-tag', title: meta.readOnlyReason }, t('Read-only')));
  else if (meta.dirty) status.append(h('span', { class: 'dv-tag tb-dirty' }, t('Modified')));
});

function updateMetaLine(): void {
  if (!metaEl || !meta || !file) return;
  const parts = [isLog ? t('{0} lines', nf.format(meta.total)) : `${nf.format(meta.total)} × ${nf.format(meta.columns.length)}`, fmtBytes(file.size)];
  metaEl.textContent = parts.join(' · ');
}

// ------------------------------------------------------------------------------------------------------------------
// Search

function searchKeys(): number[] {
  if (st.search.scope !== undefined && colByKey(st.search.scope)) return [st.search.scope];
  return grid?.cols.map((c) => c.key) ?? [];
}

/** Start a find over the whole file on the host (each call cancels the previous one there). */
function runSearch(keepPosition = false): void {
  if (!searchInput || !meta) return;
  const q = searchInput.value;
  st.search.q = q;
  persist();
  searchActive = true;
  searchBox.classList.remove('inactive', 'invalid');
  searchBox.title = '';
  const spec = { q, regex: st.search.regex, matchCase: st.search.matchCase, word: !!st.search.word };
  currentRe = highlighter(q, spec.regex, spec.matchCase, spec.word);
  if (q && !currentRe) {
    // invalid regular expression: say so, search nothing
    searchBox.classList.add('invalid');
    try {
      new RegExp(q);
    } catch (e) {
      searchBox.title = e instanceof Error ? e.message : String(e);
    }
    search = { ...search, id: search.id + 1, hits: [], total: 0, cur: -1, done: true };
    renderSearchCount();
    grid?.invalidate();
    return;
  }
  // "filter rows to matches" reuses the same engine through the view query; the find then runs over that view
  const want: Query = filterMode() && q ? { ...query(), text: q, regex: spec.regex || undefined, matchCase: spec.matchCase || undefined, word: spec.word || undefined, keys: st.search.scope !== undefined ? [st.search.scope] : undefined } : { ...query(), text: undefined, regex: undefined, matchCase: undefined, word: undefined, keys: undefined };
  const viewChanges = JSON.stringify(stripUndef(want)) !== JSON.stringify(stripUndef(query()));
  search = { id: search.id + 1, total: 0, hits: [], from: keepPosition && search.cur >= 0 ? search.hits[search.cur * 2] : (grid?.sel.fr ?? 0), wrapAt: -1, cur: -1, done: !q, capped: false, jumped: false };
  if (viewChanges) {
    search.from = 0;
    setQuery(want);
    pendingFind = !!q;
  } else if (q) sendFind();
  renderSearchCount();
  renderLevels();
  grid?.invalidate();
}

let pendingFind = false;
function sendFind(): void {
  if (!st.search.q || !searchActive) return;
  send({ type: 'search', id: search.id, q: st.search.q, regex: st.search.regex, matchCase: st.search.matchCase, word: !!st.search.word, keys: searchKeys(), from: Math.max(0, Math.min(search.from, (meta?.count ?? 1) - 1)) });
}

function stripUndef(q: Query): Query {
  return JSON.parse(JSON.stringify(q));
}

function onSearchResult(msg: Extract<ToView, { type: 'searchResult' }>): void {
  if (msg.id !== search.id) return;
  if (msg.error) {
    searchBox.classList.add('invalid');
    searchBox.title = msg.error;
  }
  const hits = search.hits;
  for (let i = 0; i < msg.hits.length; i += 2) {
    if (search.wrapAt < 0 && msg.hits[i] < search.from && hits.length) search.wrapAt = hits.length / 2;
    hits.push(msg.hits[i], msg.hits[i + 1]);
  }
  search.total = msg.total;
  search.done = msg.done;
  search.capped = msg.capped;
  search.levels = msg.levels;
  search.ms = msg.ms;
  // jump to the first match as soon as it is known (without taking focus from the find box)
  if (!search.jumped && hits.length) {
    search.jumped = true;
    gotoHit(1, false, 0);
  }
  renderSearchCount();
  if (isLog) renderLevels();
}

/** 1-based rank of pair index i in document order (needs the complete list when the scan wrapped). */
function rankOf(i: number): number | undefined {
  const n = search.hits.length / 2;
  if (search.from === 0 || search.wrapAt === 0) return i + 1;
  if (!search.done || search.capped) return undefined;
  const w = search.wrapAt < 0 ? n : search.wrapAt;
  return i < w ? n - w + i + 1 : i - w + 1;
}

function renderSearchCount(): void {
  if (!searchCount) return;
  if (!st.search.q || !searchActive) {
    searchCount.textContent = '';
    return;
  }
  if (searchBox.classList.contains('invalid')) {
    searchCount.textContent = t('Invalid regex');
    return;
  }
  if (!search.total) {
    searchCount.textContent = search.done ? t('No results') : '…';
    return;
  }
  const total = nf.format(search.total);
  const rank = search.cur >= 0 ? rankOf(search.cur) : undefined;
  if (!search.done) searchCount.textContent = rank !== undefined ? `${nf.format(rank)} / ≥ ${total}` : `≥ ${total}`;
  else searchCount.textContent = `${rank !== undefined ? nf.format(rank) : '–'} / ${total}`;
  searchCount.title = search.ms !== undefined && search.done ? `${search.ms} ms` : '';
}

/** Move to the next/previous match (cyclic). `exact` selects pair index directly. */
function gotoHit(d: 1 | -1, keepFocus = true, exact?: number): void {
  const n = search.hits.length / 2;
  if (!n || !grid) return;
  const H = search.hits;
  const disp = new Map(grid.cols.map((c, i) => [c.li, i]));
  if (exact !== undefined) search.cur = exact;
  else {
    const curOk = search.cur >= 0 && H[search.cur * 2] === grid.sel.fr && disp.get(H[search.cur * 2 + 1]) === grid.sel.fc;
    if (curOk) search.cur = (search.cur + d + n) % n;
    else {
      // nearest match after/before the selection (document order)
      const key = (i: number) => H[i * 2] * 1e6 + (disp.get(H[i * 2 + 1]) ?? 0);
      const here = grid.sel.fr * 1e6 + grid.sel.fc;
      let best = -1;
      let wrapBest = -1;
      for (let i = 0; i < n; i++) {
        const k = key(i);
        if (d > 0) {
          if (k > here && (best < 0 || k < key(best))) best = i;
          if (wrapBest < 0 || k < key(wrapBest)) wrapBest = i;
        } else {
          if (k < here && (best < 0 || k > key(best))) best = i;
          if (wrapBest < 0 || k > key(wrapBest)) wrapBest = i;
        }
      }
      search.cur = best >= 0 ? best : wrapBest;
    }
  }
  const r = H[search.cur * 2];
  const c = disp.get(H[search.cur * 2 + 1]) ?? 0;
  grid.select(r, c, false, isLog ? 'rows' : 'cells');
  grid.scrollToRow(r, 'center');
  grid.invalidate();
  if (!keepFocus) searchInput.focus({ preventScroll: true });
  renderSearchCount();
}

// ------------------------------------------------------------------------------------------------------------------
// Copy / paste

function selectedKeys(): number[] {
  const [, , c0, c1] = grid!.selRect();
  return isLog ? [0] : grid!.cols.slice(c0, c1 + 1).map((c) => c.key);
}

function copySelection(format: CopyFormat, header: boolean): void {
  if (!grid) return;
  const [r0, r1] = grid.selRect();
  send({ type: 'copyRange', r0, r1: r1 + 1, keys: selectedKeys(), format, header });
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === '\t') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else f += c;
  }
  if (f !== '' || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

function paste(text: string): void {
  if (!grid || !meta || meta.readOnly) return;
  const block = parseTsv(text);
  if (!block.length) return;
  const [r0, r1, c0, c1] = grid.selRect();
  if (block.length === 1 && block[0].length === 1 && (r1 > r0 || c1 > c0)) {
    // one value into a range: fill it
    const keys = grid.cols.slice(c0, c1 + 1).map((c) => c.key);
    const rows: string[][] = [];
    for (let r = r0; r <= Math.min(r1, r0 + 100000); r++) rows.push(keys.map(() => block[0][0]));
    edit({ op: 'paste', row: r0, keys, rows });
    return;
  }
  const width = Math.max(...block.map((r) => r.length));
  const keys = grid.cols.slice(c0, c0 + width).map((c) => c.key);
  edit({ op: 'paste', row: r0, keys, rows: block.map((r) => r.slice(0, keys.length)) });
}

// ------------------------------------------------------------------------------------------------------------------
// Menus

function cellMenu(e: MouseEvent): void {
  if (!grid || !meta) return;
  const ro = meta.readOnly;
  const [r0, r1, c0, c1] = grid.selRect();
  const single = r0 === r1 && c0 === c1;
  const col = grid.cols[grid.sel.fc];
  const row = cache.get(grid.sel.fr);
  const value = row && col ? (row.k?.[col.li] === 'z' ? '' : (row.c[col.li] ?? '')) : '';
  const nrows = r1 - r0 + 1;
  const items: MenuItem[] = [
    { label: t('Copy'), icon: 'copy', kbd: 'Ctrl+C', run: () => copySelection('tsv', false) },
    { label: t('Copy with headers'), run: () => copySelection('tsv', true) },
    { label: t('Copy as CSV'), run: () => copySelection('csv', true) },
    { label: t('Copy as Markdown'), run: () => copySelection('markdown', true) },
    { label: t('Copy as JSON'), icon: 'braces', run: () => copySelection('json', true) },
  ];
  if (!isLog && single && col && row)
    items.push('sep', { label: t('Filter by this value'), icon: 'filter', run: () => addFilter({ key: col.key, op: 'equals', value }) }, { label: t('Exclude this value'), run: () => addFilter({ key: col.key, op: 'notEquals', value }) });
  if (!isLog && !ro) {
    items.push(
      'sep',
      { label: t('Edit cell'), icon: 'edit', kbd: 'Enter', disabled: !single, run: () => void grid!.startEdit(grid!.sel.fr, grid!.sel.fc) },
      { label: nrows > 1 ? t('Insert {0} rows above', nf.format(nrows)) : t('Insert row above'), icon: 'plus', run: () => edit({ op: 'insertRows', at: r0, count: nrows }) },
      { label: nrows > 1 ? t('Insert {0} rows below', nf.format(nrows)) : t('Insert row below'), run: () => edit({ op: 'insertRows', at: r1 + 1, count: nrows }) },
      { label: nrows > 1 ? t('Delete {0} rows', nf.format(nrows)) : t('Delete row'), icon: 'trash', danger: true, run: () => deleteRows(r0, r1) },
      { label: t('Clear cells'), kbd: 'Del', run: () => gridHost.clear() },
    );
  }
  openMenu(items, { x: e.clientX, y: e.clientY });
}

function deleteRows(r0: number, r1: number): void {
  const rows: number[] = [];
  for (let r = r0; r <= r1; r++) rows.push(r);
  edit({ op: 'deleteRows', rows });
  grid?.select(Math.min(r0, (meta?.count ?? 1) - rows.length - 1), grid.sel.fc, false);
}

function columnMenu(col: Col, anchor: DOMRect | { x: number; y: number }): void {
  if (!meta) return;
  const q = query();
  const sort = q.sort?.key === col.key ? q.sort.dir : undefined;
  const ro = meta.readOnly;
  const canRename = file?.kind === 'jsonl' || meta.hasHeader;
  const items: MenuItem[] = [
    { header: col.name },
    { label: t('Sort ascending'), icon: 'sortAsc', checked: sort === 'asc' ? true : undefined, run: () => setSort(col.key, 'asc') },
    { label: t('Sort descending'), icon: 'sortDesc', checked: sort === 'desc' ? true : undefined, run: () => setSort(col.key, 'desc') },
  ];
  if (sort) items.push({ label: t('Clear sort'), run: () => setSort(col.key, null) });
  items.push(
    'sep',
    { label: t('Filter…'), icon: 'filter', run: () => filterPopover(col.key, grid!.headerRect(grid!.cols.indexOf(col))) },
    { label: t('Column statistics'), icon: 'hash', run: () => statsPopover(col, grid!.headerRect(grid!.cols.indexOf(col))) },
    'sep',
    { label: col.pinned ? t('Unpin column') : t('Pin column to the left'), icon: 'pin', run: () => togglePin(col.key) },
    { label: t('Hide column'), icon: 'eyeOff', run: () => hideColumn(col.key) },
    { label: t('Fit width to content'), run: () => gridHost.fitWidth(col) },
    { label: t('Copy column'), icon: 'copy', run: () => send({ type: 'copyRange', r0: 0, r1: meta!.count, keys: [col.key], format: 'tsv', header: false }) },
    { label: t('Select column'), run: () => grid!.select(0, grid!.cols.indexOf(col), false, 'cols') },
  );
  if (!ro && file?.kind !== 'parquet') {
    items.push(
      'sep',
      { label: t('Insert column left'), icon: 'plus', disabled: !canRename, run: () => promptName(t('New column name'), '', (name) => edit({ op: 'insertCol', at: col.li, name })) },
      { label: t('Insert column right'), disabled: !canRename, run: () => promptName(t('New column name'), '', (name) => edit({ op: 'insertCol', at: col.li + 1, name })) },
      { label: t('Rename column…'), icon: 'edit', disabled: !canRename, run: () => promptName(t('Rename column'), col.name, (name) => edit({ op: 'renameCol', key: col.key, name })) },
      { label: t('Delete column'), icon: 'trash', danger: true, run: () => edit({ op: 'deleteCol', key: col.key }) },
    );
  }
  openMenu(items, anchor, anchor instanceof DOMRect ? 'below' : 'point');
}

function promptName(title: string, value: string, done: (v: string) => void): void {
  const input = h('input', { class: 'dv-plain', value, 'aria-label': title });
  const ok = () => {
    const v = input.value.trim();
    closePopup();
    if (v) done(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ok();
  });
  const anchor = grid ? grid.headerRect(Math.max(0, grid.sel.fc)) : new DOMRect(40, 40, 0, 0);
  openPopover(h('div', { class: 'tp-form' }, h('div', { class: 'tp-title' }, title), h('label', { class: 'dv-input' }, input), h('div', { class: 'tp-actions' }, h('button', { class: 'dv-btn secondary', onclick: () => closePopup() }, t('Cancel')), h('button', { class: 'dv-btn primary', onclick: ok }, t('OK')))), anchor);
  input.focus();
  input.select();
}

function togglePin(key: number): void {
  const i = st.pinned.indexOf(key);
  if (i >= 0) st.pinned.splice(i, 1);
  else st.pinned.push(key);
  persist();
  syncColumns();
}

function hideColumn(key: number): void {
  if (!st.hidden.includes(key)) st.hidden.push(key);
  persist();
  syncColumns();
  scheduleDetail();
}

let statsWaiter: ((s: Stats) => void) | undefined;
function requestStats(key: number, top: number): Promise<Stats> {
  return new Promise((resolve) => {
    statsWaiter = (s) => {
      if (s.key === key) resolve(s);
    };
    send({ type: 'stats', key, top });
  });
}

function fmtNum(x: number): string {
  if (!isFinite(x)) return String(x);
  if (Math.abs(x) >= 1e15 || (Math.abs(x) < 1e-6 && x !== 0)) return x.toExponential(4);
  return nf.format(Math.round(x * 1e6) / 1e6);
}

function topList(s: Stats, onPick?: (v: string, e: MouseEvent) => void, selected?: Set<string>): HTMLElement {
  const list = h('div', { class: 'tp-top', role: 'list' });
  const max = s.top[0]?.[1] ?? 1;
  for (const [v, n] of s.top) {
    const bar = h('span', { class: 'tp-bar' });
    bar.style.width = Math.max(2, (n / max) * 100) + '%';
    const item = h(
      onPick ? 'button' : 'div',
      { class: 'tp-tv' + (selected?.has(v) ? ' on' : ''), role: 'listitem', title: v },
      bar,
      h('span', { class: 'tp-tv-v' + (v === '' ? ' v-muted' : '') }, v === '' ? t('(empty)') : v.length > 120 ? v.slice(0, 120) + '…' : v),
      h('span', { class: 'tp-tv-n' }, nf.format(n)),
    );
    if (onPick) item.addEventListener('click', (e) => onPick(v, e as MouseEvent));
    list.append(item);
  }
  return list;
}

function statsPopover(col: Col, anchor: DOMRect): void {
  const body = h('div', { class: 'tp-stats' }, h('div', { class: 'tp-title' }, h('span', { class: 'tp-ty' }, icon(TYPE_ICON[col.type], 14)), col.name, h('span', { class: 'dv-tag' }, typeLabel(col.type))), h('div', { class: 'tp-loading' }, h('div', { class: 'dv-spinner' }), t('Computing…')));
  openPopover(body, anchor, undefined, 'tp-wide');
  void requestStats(col.key, 10).then((s) => {
    if (!body.isConnected) return;
    body.lastChild!.remove();
    const facts: [string, string][] = [
      [t('Count'), nf.format(s.count)],
      [t('Empty'), `${nf.format(s.empty)}${s.count ? ` (${Math.round((s.empty / s.count) * 1000) / 10}%)` : ''}`],
      [t('Distinct'), nf.format(s.distinct) + (s.distinctCapped ? '+' : '')],
    ];
    if (s.numeric) facts.push([t('Min'), fmtNum(s.numeric.min)], [t('Max'), fmtNum(s.numeric.max)], [t('Mean'), fmtNum(s.numeric.mean)], [t('Sum'), fmtNum(s.numeric.sum)]);
    else if (s.minStr !== undefined) facts.push([t('First'), s.minStr], [t('Last'), s.maxStr ?? '']);
    body.append(h('div', { class: 'tp-facts' }, ...facts.map(([k, v]) => h('div', { class: 'tp-fact' }, h('span', { class: 'tp-fk' }, k), h('span', { class: 'tp-fv', title: v }, v)))));
    if (s.top.length) {
      body.append(h('div', { class: 'tp-sub' }, t('Top values')));
      body.append(
        topList(s, (v) => {
          closePopup();
          addFilter({ key: col.key, op: 'equals', value: v });
        }),
      );
    }
    repositionPopup(anchor);
  });
}

function filterPopover(key: number, anchor: DOMRect, index?: number): void {
  const col = colByKey(key);
  if (!col) return;
  const q = query();
  const existingIndex = index ?? q.filters.findIndex((f) => f.key === key);
  const existing = existingIndex >= 0 ? q.filters[existingIndex] : undefined;
  const numeric = col.type === 'int' || col.type === 'float' || col.type === 'date';
  const sel = h('select', { class: 'tp-select', 'aria-label': t('Condition') });
  for (const [op] of OPS) {
    if (op === 'in' && existing?.op !== 'in') continue;
    sel.append(h('option', { value: op, selected: (existing?.op ?? (numeric ? 'equals' : 'contains')) === op }, opLabel(op)));
  }
  const input = h('input', { class: 'dv-plain', value: existing?.value ?? '', placeholder: t('Value'), 'aria-label': t('Value') });
  const picked = new Set<string>(existing?.op === 'in' ? (existing.values ?? []) : []);
  const inputWrap = h('label', { class: 'dv-input tp-value' }, input);
  const syncInput = () => {
    inputWrap.hidden = sel.value === 'empty' || sel.value === 'notEmpty' || sel.value === 'in';
  };
  sel.addEventListener('change', syncInput);
  syncInput();
  const apply = () => {
    const op = sel.value as FilterOp;
    if (op === 'in') {
      if (!picked.size) return;
      addFilter({ key, op, values: [...picked] }, existingIndex);
    } else addFilter({ key, op, value: input.value }, existingIndex);
    closePopup();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  const topWrap = h('div', { class: 'tp-topwrap' }, h('div', { class: 'tp-loading' }, h('div', { class: 'dv-spinner' }), t('Loading top values…')));
  const body = h(
    'div',
    { class: 'tp-filter' },
    h('div', { class: 'tp-title' }, h('span', { class: 'tp-ty' }, icon(TYPE_ICON[col.type], 14)), col.name),
    h('div', { class: 'tp-row' }, sel, inputWrap),
    h('div', { class: 'tp-sub' }, t('Top values'), h('span', { class: 'tp-hint' }, t('click to filter · Ctrl+click to pick several'))),
    topWrap,
    h(
      'div',
      { class: 'tp-actions' },
      existing ? h('button', { class: 'dv-btn secondary', onclick: () => (removeFilter(existingIndex), closePopup()) }, t('Remove')) : null,
      h('span', { class: 'dv-spacer' }),
      h('button', { class: 'dv-btn secondary', onclick: () => closePopup() }, t('Cancel')),
      h('button', { class: 'dv-btn primary', onclick: apply }, t('Apply')),
    ),
  );
  openPopover(body, anchor, undefined, 'tp-wide');
  input.focus();
  void requestStats(key, 40).then((s) => {
    if (!body.isConnected) return;
    topWrap.textContent = '';
    const meta2 = h('div', { class: 'tp-hint' }, t('{0} distinct values', nf.format(s.distinct) + (s.distinctCapped ? '+' : '')));
    const redraw = () => {
      const list = topList(
        s,
        (v, e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            if (picked.has(v)) picked.delete(v);
            else picked.add(v);
            if (!sel.querySelector('option[value="in"]')) sel.append(h('option', { value: 'in' }, opLabel('in')));
            sel.value = 'in';
            syncInput();
            topWrap.replaceChild(redraw(), topWrap.firstChild!);
          } else {
            closePopup();
            addFilter({ key, op: 'equals', value: v }, existingIndex);
          }
        },
        picked,
      );
      return list;
    };
    topWrap.append(redraw(), meta2);
    repositionPopup(anchor);
  });
}

function columnChooser(anchor: DOMRect): void {
  if (!meta) return;
  const input = h('input', { class: 'dv-plain', placeholder: t('Search columns…'), 'aria-label': t('Search columns…') });
  const list = h('div', { class: 'tp-cols', role: 'list' });
  const draw = () => {
    list.textContent = '';
    const q = input.value.trim().toLowerCase();
    const hidden = hiddenSet();
    let n = 0;
    for (const c of meta!.columns) {
      if (q && !c.name.toLowerCase().includes(q)) continue;
      if (++n > 1500) break;
      const cb = h('input', { type: 'checkbox', checked: !hidden.has(c.key), 'aria-label': c.name });
      cb.addEventListener('change', () => {
        if (cb.checked) st.hidden = st.hidden.filter((k) => k !== c.key);
        else if (!st.hidden.includes(c.key)) st.hidden.push(c.key);
        persist();
        syncColumns();
      });
      list.append(
        h(
          'div',
          { class: 'tp-col', role: 'listitem' },
          h('label', null, cb, h('span', { class: 'tp-ty' }, icon(TYPE_ICON[c.type], 12)), h('span', { class: 'tp-cn' }, c.name)),
          st.pinned.includes(c.key) ? h('span', { class: 'tp-pin', title: t('Pinned') }, icon('pin', 12)) : null,
          h(
            'button',
            {
              class: 'dv-iconbtn tp-go',
              title: t('Scroll to column'),
              'aria-label': t('Scroll to column'),
              onclick: () => {
                closePopup();
                revealColumn(c.key);
              },
            },
            icon('chevronRight', 14),
          ),
        ),
      );
    }
  };
  input.addEventListener('input', draw);
  const setAll = (show: boolean) => {
    const q = input.value.trim().toLowerCase();
    const match = meta!.columns.filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => c.key);
    if (show) st.hidden = st.hidden.filter((k) => !match.includes(k));
    else st.hidden = [...new Set([...st.hidden, ...match])];
    persist();
    syncColumns();
    draw();
  };
  draw();
  const body = h(
    'div',
    { class: 'tp-chooser' },
    h('label', { class: 'dv-input' }, icon('search', 14), input),
    h('div', { class: 'tp-row' }, h('button', { class: 'dv-btn secondary', onclick: () => setAll(true) }, icon('eye', 14), t('Show all')), h('button', { class: 'dv-btn secondary', onclick: () => setAll(false) }, icon('eyeOff', 14), t('Hide all')), h('span', { class: 'dv-spacer' }), h('span', { class: 'dv-count' }, t('{0} hidden', nf.format(st.hidden.length)))),
    list,
  );
  openPopover(body, anchor, undefined, 'tp-wide');
  input.focus();
}

function revealColumn(key: number): void {
  if (!grid) return;
  if (st.hidden.includes(key)) {
    st.hidden = st.hidden.filter((k) => k !== key);
    persist();
    syncColumns();
  }
  const c = grid.cols.findIndex((x) => x.key === key);
  if (c >= 0) grid.select(grid.sel.fr, c, false);
}

// ------------------------------------------------------------------------------------------------------------------
// Detail panel

const recordWaiters = new Map<number, (d: RowData | null) => void>();
function fetchRecord(row: number): Promise<RowData | null> {
  return new Promise((resolve) => {
    recordWaiters.set(row, resolve);
    send({ type: 'record', row, vv: meta?.vv ?? 0 });
  });
}

let detailTimer = 0;
function scheduleDetail(): void {
  if (!st.detail || !detail || !grid) return;
  clearTimeout(detailTimer);
  detailTimer = window.setTimeout(async () => {
    const r = grid!.sel.fr;
    if (!meta || r >= meta.count) return detail!.show(r, null, meta?.columns ?? [], [], hiddenSet());
    const cached = cache.get(r);
    if (cached && !cached.tr) detail!.show(r, cached, meta.columns, displayKeys(), hiddenSet());
    const d = await fetchRecord(r);
    if (grid!.sel.fr === r) detail!.show(r, d, meta!.columns, displayKeys(), hiddenSet());
  }, 60);
}

function setDetail(on: boolean): void {
  st.detail = on;
  persist();
  if (detailBtn) toggle(detailBtn, on);
  if (!detail) return;
  if (on) {
    main.append(detail.el);
    scheduleDetail();
  } else detail.el.remove();
}

// ------------------------------------------------------------------------------------------------------------------
// Boot

function boot(): void {
  isLog = file!.kind === 'log';
  document.body.dataset.kind = file!.kind;
  gridWrap.textContent = '';
  grid = new Grid(gridHost, isLog ? 'log' : 'table');
  gridWrap.append(grid.root, progressBar);
  fonts();
  const d = density();
  document.body.dataset.density = d;
  grid.setRowHeight(isLog ? (d === 'compact' ? 20 : d === 'comfortable' ? 24 : 22) : ROW_H[d], HEAD_H[d]);
  grid.setWrap(wrapOn());
  cache.onData = () => grid?.dataChanged();
  buildToolbar();
  if (!isLog) {
    detail = new DetailPanel({
      step: (dd) => {
        if (!grid || !meta) return;
        grid.select(Math.max(0, Math.min(meta.count - 1, grid.sel.fr + dd)), grid.sel.fc, false);
      },
      close: () => setDetail(false),
      resized: (w) => {
        st.detailW = w;
        persist();
      },
      reveal: (key) => {
        revealColumn(key);
        if (detail?.currentTab === 'schema') return;
      },
    });
    detail.setWidth(st.detailW);
    if (file!.kind === 'parquet' && saved === undefined) st.detail = true;
    if (st.detail) setDetail(true);
  }
  updateScopeButton();
  if (st.search.q) {
    currentRe = highlighter(st.search.q, st.search.regex, st.search.matchCase, !!st.search.word);
    pendingFind = true;
  }
}

function applyMeta(m: Meta, reset: boolean): void {
  const prev = meta;
  meta = m;
  const qj = JSON.stringify(m.query);
  const queryChanged = qj !== lastQueryJson;
  lastQueryJson = qj;
  if (!st.query || queryChanged) st.query = m.query;
  if (prev?.vv !== m.vv || reset) {
    if (queryChanged || (prev && prev.columns.length !== m.columns.length) || !prev) cache.clear(m.vv);
    else cache.revalidate(m.vv);
  }
  cache.configure(Math.max(1, m.columns.length));
  if (!grid) return;
  const colsChanged = !prev || JSON.stringify(prev.columns) !== JSON.stringify(m.columns);
  if (colsChanged) syncColumns();
  grid.setCount(m.count);
  if (headerBtn) toggle(headerBtn, m.hasHeader);
  if (detail && file?.kind === 'parquet') {
    const first = !prev;
    detail.enableSchema(m);
    if (first && st.tab) detail.setTab(st.tab);
  }
  updateMetaLine();
  renderLevels();
  renderChips();
  renderBanners();
  renderSearchCount();
  updateStatus();
  if (prev?.vv !== m.vv || reset) {
    if (pendingFind) {
      pendingFind = false;
      sendFind();
    } else if (st.search.q && searchActive && prev) runSearch(true);
  }
  if (prev && prev.vv !== m.vv) scheduleDetail();
  grid.invalidate();
  // restore scroll/selection once enough rows exist
  if (!restored && (!m.indexing || m.count * grid.rowH > st.y + 2000)) {
    restored = true;
    if (st.sel) grid.setSel(st.sel, false);
    if (isLog && followOn() && !saved) grid.stickToBottom();
    else {
      grid.setY(st.y);
      grid.setX(st.x);
    }
  } else if (isLog && followOn() && grid.atBottom()) grid.stickToBottom();
  if (isLog) updateFollowButton();
}

// Watchdog: visible rows still without data (a lost or dropped reply, a block fetched while indexing) are asked for
// again — the view must never stay blank until the next scroll.
setInterval(() => {
  if (grid && grid.missing > 0 && !document.hidden) grid.dataChanged();
}, 500);

onMessage<ToView>((msg) => {
  try {
    handleMessage(msg);
  } catch (e) {
    console.error('[Data Viewer] failed to handle', msg.type, e);
    grid?.invalidate();
  }
});

function handleMessage(msg: ToView): void {
  switch (msg.type) {
    case 'init': {
      setStrings(msg.strings);
      const first = !file;
      file = msg.file;
      settings = msg.settings;
      if (first) {
        boot();
      } else {
        buildToolbar();
        grid?.setWrap(wrapOn());
      }
      applyMeta(msg.meta, true);
      return;
    }
    case 'meta':
      applyMeta(msg.meta, !!msg.reset);
      return;
    case 'rows':
      if (cache.receive(msg.vv, msg.b, msg.bs, msg.rows)) {
        if (widthsPending) {
          widthsPending = false;
          syncColumns();
        }
        if (isLog && grid) {
          let max = 0;
          for (const r of msg.rows) if (r.c[0] && r.c[0].length > max) max = r.c[0].length;
          grid.setLogWidth(max);
        }
        grid?.dataChanged();
        if (st.detail && grid && msg.b === Math.floor(grid.sel.fr / msg.bs)) scheduleDetail();
        updateStatus();
      }
      return;
    case 'dropped':
      cache.dropped(msg.vv, msg.blocks);
      grid?.dataChanged();
      return;
    case 'progress':
      busy = msg.task ? { task: msg.task, pct: msg.pct } : undefined;
      updateStatus();
      return;
    case 'searchResult':
      onSearchResult(msg);
      return;
    case 'stats':
      statsWaiter?.(msg.stats);
      return;
    case 'record': {
      const w = recordWaiters.get(msg.row);
      if (w) {
        recordWaiters.delete(msg.row);
        w(msg.data);
      }
      return;
    }
    case 'focusSearch':
      focusSearch();
      return;
    case 'goTo':
    case 'found':
      if (!grid || msg.row < 0) return;
      grid.select(msg.row, Math.max(0, grid.sel.fc), false, isLog ? 'rows' : 'cells');
      grid.scrollToRow(msg.row, 'center');
      grid.focus();
      if (isLog && followOn()) setFollow(false);
      return;
    case 'paste':
      paste(msg.text);
      return;
    case 'banner':
      changedBanner = msg.kind === 'changed';
      renderBanners();
      return;
    case 'error':
      errorMsg = msg.message;
      if (!grid) gridWrap.textContent = msg.message;
      renderBanners();
      return;
  }
}

// Ctrl/Cmd+F anywhere in the page focuses the search box (the command also does this through the host).
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    e.stopPropagation();
    focusSearch();
  } else if (e.key === 'F3') {
    e.preventDefault();
    if (!searchActive && st.search.q) runSearch();
    else gotoHit(e.shiftKey ? -1 : 1);
  }
});

send({ type: 'ready', query: st.query, hasHeader: st.hasHeader });
