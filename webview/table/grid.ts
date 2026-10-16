// Virtualized data grid: rows and columns are virtualized, header/gutter/pinned columns stay in place, and all
// drawing happens in a sticky "stage" positioned from the scroll offsets. Huge row counts use a scaled scrollbar
// with wheel scrolling handled 1:1.
import { h, icon } from '../shared/vscode';
import type { ColType, RowData } from '../../src/table/protocol';
import { Heights } from './cache';
import { renderLogLine, setHighlighted } from './render';

export interface Col {
  key: number;
  /** index into RowData.c */
  li: number;
  name: string;
  type: ColType;
  w: number;
  pinned: boolean;
}

export interface Sel {
  ar: number;
  ac: number;
  fr: number;
  fc: number;
  /** cells | whole rows | whole columns */
  mode: 'cells' | 'rows' | 'cols';
}

export interface GridHost {
  row(r: number): RowData | undefined;
  need(r0: number, r1: number): void;
  selectionChanged(): void;
  headerClick(col: Col, e: MouseEvent): void;
  headerMenu(col: Col, anchor: DOMRect): void;
  contextMenu(e: MouseEvent, onHeader: Col | undefined): void;
  commitEdit(r: number, col: Col, value: string, move: 'down' | 'right' | 'left' | 'up' | 'none'): void;
  editValue(r: number, col: Col): Promise<string | undefined>;
  copy(): void;
  paste(): void;
  clear(): void;
  widthChanged(col: Col): void;
  fitWidth(col: Col): void;
  highlighter(): RegExp | undefined;
  isHit(r: number, li: number): boolean;
  sortOf(key: number): 'asc' | 'desc' | undefined;
  filtered(key: number): boolean;
  canEdit(): boolean;
  find(): void;
  scrolled(): void;
}

/** Tallest scroll content we create; beyond it the scrollbar is scaled (wheel scrolling stays 1:1). The rendered rows sit
 * in a sticky layer at scrollTop, so layer coordinates grow with this height. Chromium's GPU raster (VS Code) drops text
 * glyphs once those coordinates reach the millions of device pixels on HiDPI screens — rows kept their backgrounds but
 * lost their text near the end of a 400k-line log at 150 % scaling — so stay far below that, even at 3x DPR. */
const MAXPX = 300_000;

interface RowEl {
  el: HTMLDivElement;
  track: HTMLDivElement;
  gut: HTMLDivElement;
  r: number;
  data?: RowData;
  ver: number;
  top: number;
  c0: number;
  c1: number;
  selVer: number;
  cells: Map<number, HTMLDivElement>;
  measured: boolean;
}

export const TYPE_ICON: Record<ColType, string> = { int: 'hash', float: 'hash', bool: 'toggle', date: 'calendar', json: 'braces', string: 'text', empty: 'text' };

export class Grid {
  readonly root: HTMLDivElement;
  private scroller: HTMLDivElement;
  private sizer: HTMLDivElement;
  private stage: HTMLDivElement;
  private head: HTMLDivElement;
  private headTrack: HTMLDivElement;
  private body: HTMLDivElement;
  private rowsEl: HTMLDivElement;
  private editor?: HTMLTextAreaElement;
  private editing?: { r: number; c: number; original: string };

  cols: Col[] = [];
  nPinned = 0;
  private pinX: number[] = [];
  private pinW = 0;
  private xs: number[] = [0];
  gutW = 48;
  rowH = 26;
  headH = 30;
  count = 0;
  wrap = false;
  heights?: Heights;
  private viewW = 0;
  private viewH = 0;
  private y = 0;
  private scaled = false;
  private k = 1;
  /** scrollTop we set ourselves (its scroll event must not overwrite the exact y); NaN = none pending. */
  private expectTop = NaN;
  private rowEls = new Map<number, RowEl>();
  private pool: RowEl[] = [];
  private ver = 1;
  private selVer = 1;
  private headVer = 0;
  private base = 0;
  private raf = 0;
  sel: Sel = { ar: 0, ac: 0, fr: 0, fc: 0, mode: 'cells' };
  private drag?: { kind: 'sel' | 'resize'; col?: Col; x0?: number; w0?: number; lastX?: number; lastY?: number };
  private autoScroll = 0;
  logMode = false;
  logW = 0;
  private charW = 7.2;
  private stickBottom = false;
  /** Visible rows whose data has not arrived yet (at the last render). */
  missing = 0;

  constructor(
    private host: GridHost,
    mode: 'table' | 'log',
  ) {
    this.logMode = mode === 'log';
    this.root = h('div', { class: 'tg' + (this.logMode ? ' tg-log' : ''), tabindex: 0, role: 'grid', 'aria-multiselectable': 'true' });
    this.scroller = h('div', { class: 'tg-scroll' });
    this.sizer = h('div', { class: 'tg-sizer' });
    this.stage = h('div', { class: 'tg-stage' });
    this.head = h('div', { class: 'tg-head', role: 'row' });
    this.headTrack = h('div', { class: 'tg-track' });
    this.head.append(this.headTrack);
    this.body = h('div', { class: 'tg-body', role: 'rowgroup' });
    this.rowsEl = h('div', { class: 'tg-rows' });
    this.body.append(this.rowsEl);
    this.stage.append(this.body);
    if (!this.logMode) this.stage.append(this.head);
    this.sizer.append(this.stage);
    this.scroller.append(this.sizer);
    this.root.append(this.scroller);
    if (this.logMode) this.headH = 0;

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.stage.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.stage.addEventListener('contextmenu', (e) => this.onContext(e));
    this.stage.addEventListener('mouseover', (e) => this.onOver(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.measureView()).observe(this.scroller);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Layout

  setColumns(cols: Col[]): void {
    this.cols = cols;
    this.nPinned = cols.filter((c) => c.pinned).length;
    this.relayout();
  }

  relayout(): void {
    this.pinX = [];
    let x = 0;
    for (let i = 0; i < this.nPinned; i++) {
      this.pinX.push(x);
      x += this.cols[i].w;
    }
    this.pinW = x;
    this.xs = [0];
    let s = 0;
    for (let i = this.nPinned; i < this.cols.length; i++) {
      s += this.cols[i].w;
      this.xs.push(s);
    }
    if (this.logMode && this.cols[0]) this.cols[0].w = this.wrap ? Math.max(200, this.viewW - this.gutW) : Math.max(this.viewW - this.gutW, this.logW);
    if (this.logMode) this.xs = [0, this.cols[0]?.w ?? 0];
    this.ver++;
    this.headVer++;
    this.root.setAttribute('aria-colcount', String(this.cols.length));
    this.updateSizer();
    this.schedule();
  }

  setCount(n: number): void {
    const atBottom = this.logMode && this.y >= this.maxY() - 4 && this.count > 0;
    this.count = n;
    this.heights?.resize(n);
    this.root.setAttribute('aria-rowcount', String(n + (this.logMode ? 0 : 1)));
    const digits = String(Math.max(1, n)).length;
    const gw = Math.max(this.logMode ? 44 : 40, Math.ceil(digits * this.charW + 22));
    if (gw !== this.gutW) {
      this.gutW = gw;
      this.ver++;
      this.headVer++;
      if (this.logMode) this.relayout();
    }
    this.updateSizer();
    if (atBottom || this.stickBottom) this.setY(this.maxY());
    else if (this.y > this.maxY()) this.setY(this.maxY());
    this.schedule();
  }

  setRowHeight(rh: number, headH: number): void {
    this.rowH = rh;
    if (!this.logMode) this.headH = headH;
    if (this.heights) this.heights = new Heights(this.count, rh);
    this.root.style.setProperty('--rh', rh + 'px');
    this.root.style.setProperty('--hh', this.headH + 'px');
    this.ver++;
    this.headVer++;
    this.updateSizer();
    this.schedule();
  }

  setWrap(on: boolean): void {
    this.wrap = on;
    this.root.classList.toggle('wrap', on);
    this.heights = on ? new Heights(this.count, this.rowH) : undefined;
    if (this.logMode) this.relayout();
    this.ver++;
    this.updateSizer();
    this.schedule();
  }

  setLogWidth(chars: number): void {
    const w = Math.ceil(chars * this.charW + 24);
    if (w > this.logW) {
      this.logW = Math.min(w, 200_000);
      if (!this.wrap) this.relayout();
    }
  }

  setCharWidth(w: number): void {
    this.charW = w;
  }

  private totalH(): number {
    return this.heights ? this.heights.total() : this.count * this.rowH;
  }

  private bodyH(): number {
    return Math.max(0, this.viewH - this.headH);
  }

  maxY(): number {
    return Math.max(0, this.totalH() - this.bodyH());
  }

  private contentW(): number {
    return this.gutW + this.pinW + this.xs[this.xs.length - 1];
  }

  private updateSizer(): void {
    const total = this.totalH();
    this.scaled = total > MAXPX;
    const virtH = this.scaled ? MAXPX : total;
    this.sizer.style.height = this.headH + virtH + 'px';
    this.sizer.style.width = this.contentW() + 'px';
    // explicit track width: cells live inside it, so its box must cover them (see .tg-track in table.css)
    this.stage.style.setProperty('--tw', this.contentW() + 'px');
    const bh = this.bodyH();
    this.k = this.scaled ? Math.max(1, (total - bh) / Math.max(1, MAXPX - bh)) : 1;
  }

  private measureView(): void {
    const w = this.scroller.clientWidth;
    const hh = this.scroller.clientHeight;
    if (w === this.viewW && hh === this.viewH) return;
    // a log followed at the bottom stays there when the view resizes (toolbar wraps, panel opens)
    const wasBottom = this.logMode && this.count > 0 && this.viewH > 0 && (this.stickBottom || this.y >= this.maxY() - 4);
    this.viewW = w;
    this.viewH = hh;
    this.stage.style.width = w + 'px';
    this.stage.style.height = hh + 'px';
    if (this.logMode) this.relayout();
    this.updateSizer();
    if (wasBottom) this.setY(this.maxY());
    this.schedule();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Scrolling

  get scrollY(): number {
    return this.y;
  }
  get scrollX(): number {
    return this.scroller.scrollLeft;
  }

  setY(y: number): void {
    this.y = Math.max(0, Math.min(this.maxY(), y));
    const top = this.scaled ? this.y / this.k : this.y;
    this.scroller.scrollTop = top;
    this.expectTop = this.scroller.scrollTop;
    this.schedule();
  }

  setX(x: number): void {
    this.scroller.scrollLeft = x;
    this.schedule();
  }

  private onScroll(): void {
    const st = this.scroller.scrollTop;
    if (!this.scaled) this.y = st;
    else if (Number.isNaN(this.expectTop) || Math.abs(st - this.expectTop) > 1.5) {
      // scaled scrollbar: thumb at either end means exactly the first / last row (no rounding drift)
      const maxTop = this.scroller.scrollHeight - this.scroller.clientHeight;
      this.y = st <= 0.5 ? 0 : st >= maxTop - 0.5 ? this.maxY() : Math.min(this.maxY(), st * this.k);
    }
    this.expectTop = NaN;
    this.stickBottom = false;
    this.render();
    this.host.scrolled();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.scaled || e.ctrlKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? this.rowH : e.deltaMode === 2 ? this.bodyH() : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    if (dy) this.setY(this.y + dy);
    if (dx) this.scroller.scrollLeft += dx;
    this.host.scrolled();
  }

  /** Keep the log view pinned to the bottom (follow mode). */
  stickToBottom(): void {
    this.stickBottom = true;
    this.setY(this.maxY());
  }

  atBottom(): boolean {
    return this.y >= this.maxY() - 4;
  }

  private rowTop(r: number): number {
    return this.heights ? this.heights.top(r) : r * this.rowH;
  }
  private rowHeight(r: number): number {
    return this.heights ? this.heights.get(r) : this.rowH;
  }
  private rowAtY(y: number): number {
    if (this.count === 0) return 0;
    if (this.heights) return this.heights.find(y);
    return Math.max(0, Math.min(this.count - 1, Math.floor(y / this.rowH)));
  }

  scrollToRow(r: number, align: 'auto' | 'center' = 'auto'): void {
    if (r < 0 || r >= this.count) return;
    const top = this.rowTop(r);
    const hh = this.rowHeight(r);
    const bh = this.bodyH();
    if (align === 'center') this.setY(top - bh / 2 + hh / 2);
    else if (top < this.y) this.setY(top);
    else if (top + hh > this.y + bh) this.setY(top + hh - bh);
  }

  scrollToCol(c: number): void {
    if (c < this.nPinned || c >= this.cols.length) return;
    const i = c - this.nPinned;
    const x0 = this.xs[i];
    const x1 = this.xs[i + 1];
    const avail = this.viewW - this.gutW - this.pinW;
    const sl = this.scroller.scrollLeft;
    if (x0 < sl) this.setX(x0);
    else if (x1 > sl + avail) this.setX(Math.min(x0, x1 - avail));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Rendering

  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      // scroll events of our own scrollTop changes have been dispatched by now (they precede rAF callbacks)
      this.expectTop = NaN;
      this.render();
    });
  }

  invalidate(): void {
    this.ver++;
    this.schedule();
  }

  /** Data for some rows changed (new block arrived). */
  dataChanged(): void {
    this.schedule();
  }

  private visibleCols(): [number, number] {
    const n = this.cols.length - this.nPinned;
    if (n <= 0) return [0, -1];
    if (this.logMode) return [0, 0];
    const sl = this.scroller.scrollLeft;
    const avail = Math.max(0, this.viewW - this.gutW - this.pinW);
    // binary search for the first column ending after sl
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.xs[mid + 1] <= sl) lo = mid + 1;
      else hi = mid;
    }
    let c1 = lo;
    while (c1 + 1 < n && this.xs[c1 + 1] < sl + avail) c1++;
    return [lo, c1];
  }

  render(): void {
    if (!this.viewH) this.measureView();
    const bh = this.bodyH();
    const sl = this.scroller.scrollLeft;
    this.stage.style.setProperty('--sx', -sl + 'px');
    const [u0, u1] = this.visibleCols();
    const c0 = this.nPinned + u0;
    const c1 = this.nPinned + u1;
    this.renderHeader(c0, c1);
    if (this.count === 0) {
      this.missing = 0;
      for (const re of this.rowEls.values()) this.release(re);
      this.rowEls.clear();
      return;
    }
    const r0 = this.rowAtY(this.y);
    const baseRow = r0 - (r0 % 256);
    if (baseRow !== this.base) {
      this.base = baseRow;
      for (const re of this.rowEls.values()) re.top = NaN;
    }
    const baseY = this.rowTop(this.base);
    this.rowsEl.style.transform = `translateY(${baseY - this.y}px)`;
    const seen = new Set<number>();
    let missing = 0;
    let r = r0;
    let y = this.rowTop(r0);
    const toMeasure: RowEl[] = [];
    while (r < this.count && y < this.y + bh + 1) {
      seen.add(r);
      let re = this.rowEls.get(r);
      if (!re) {
        re = this.acquire(r);
        this.rowEls.set(r, re);
      }
      const top = y - baseY;
      if (re.top !== top) {
        re.top = top;
        re.el.style.top = top + 'px';
      }
      const data = this.host.row(r);
      if (!data) missing++;
      if (re.data !== data || re.ver !== this.ver || re.c0 !== c0 || re.c1 !== c1) {
        this.fillRow(re, data, c0, c1);
        if (this.wrap) toMeasure.push(re);
      } else if (re.selVer !== this.selVer) this.paintSelection(re);
      y += this.rowHeight(r);
      r++;
    }
    for (const [rr, re] of this.rowEls)
      if (!seen.has(rr)) {
        this.rowEls.delete(rr);
        this.release(re);
      }
    this.missing = missing;
    this.host.need(r0, r);
    if (toMeasure.length) this.measureRows(toMeasure);
    if (this.editing) this.positionEditor();
  }

  private measureRows(rows: RowEl[]): void {
    let changed = false;
    const hs: number[] = [];
    for (const re of rows) {
      if (!re.data) {
        hs.push(-1);
        continue;
      }
      let m = this.rowH;
      for (const cell of re.cells.values()) m = Math.max(m, cell.scrollHeight);
      hs.push(Math.min(m, this.logMode ? 4000 : 400));
    }
    rows.forEach((re, i) => {
      const hh = hs[i];
      if (hh < 0) return;
      re.el.style.height = hh + 'px';
      if (this.heights!.set(re.r, hh)) changed = true;
    });
    if (changed) {
      this.updateSizer();
      this.schedule();
    }
  }

  private acquire(r: number): RowEl {
    let re = this.pool.pop();
    if (!re) {
      const el = h('div', { class: 'tg-row', role: 'row' });
      const track = h('div', { class: 'tg-track' });
      const gut = h('div', { class: 'tg-gut', role: 'rowheader' });
      el.append(track, gut);
      re = { el, track, gut, r, ver: 0, top: NaN, c0: -1, c1: -1, selVer: 0, cells: new Map(), measured: false };
    }
    re.r = r;
    re.data = undefined;
    re.ver = 0;
    re.top = NaN;
    re.el.dataset.r = String(r);
    re.el.setAttribute('aria-rowindex', String(r + 2));
    this.rowsEl.append(re.el);
    return re;
  }

  private release(re: RowEl): void {
    re.el.remove();
    if (this.pool.length < 200) this.pool.push(re);
  }

  private cellLeft(c: number): number {
    return c < this.nPinned ? this.gutW + this.pinX[c] : this.gutW + this.pinW + this.xs[c - this.nPinned];
  }

  private fillRow(re: RowEl, data: RowData | undefined, c0: number, c1: number): void {
    const layout = re.ver !== this.ver || re.c0 !== c0 || re.c1 !== c1;
    if (re.ver !== this.ver) {
      // columns changed (pin, resize, reorder): cells may need another container — start over
      for (const cell of re.cells.values()) cell.remove();
      re.cells.clear();
    }
    re.data = data;
    re.ver = this.ver;
    re.c0 = c0;
    re.c1 = c1;
    const r = re.r;
    let cls = 'tg-row' + (r % 2 ? ' odd' : '');
    if (data?.f && data.f & 1) cls += ' invalid';
    if (data?.f && data.f & 2) cls += ' edited';
    if (this.logMode && data?.log) cls += ' lv' + data.log.lv;
    if (!data) cls += ' loading';
    re.el.className = cls;
    if (this.wrap) re.el.style.height = '';
    else re.el.style.height = this.rowH + 'px';
    re.gut.textContent = data ? (data.ln ? String(data.ln) : '+') : '';
    if (layout) re.gut.style.width = this.gutW + 'px';
    const want: number[] = [];
    for (let c = 0; c < this.nPinned; c++) want.push(c);
    for (let c = c0; c <= c1; c++) if (c >= this.nPinned) want.push(c);
    for (const [c, cell] of re.cells)
      if (!want.includes(c)) {
        cell.remove();
        re.cells.delete(c);
      }
    const re2 = this.host.highlighter();
    for (const c of want) {
      let cell = re.cells.get(c);
      const col = this.cols[c];
      if (!cell) {
        cell = h('div', { class: 'tg-c', role: 'gridcell' });
        re.cells.set(c, cell);
        if (c < this.nPinned) re.el.insertBefore(cell, re.gut);
        else re.track.append(cell);
      }
      cell.dataset.c = String(c);
      if (layout) {
        cell.style.left = this.cellLeft(c) + 'px';
        cell.style.width = col.w + 'px';
      }
      this.fillCell(cell, data, col, r, re2);
    }
    this.paintSelection(re);
  }

  private fillCell(cell: HTMLDivElement, data: RowData | undefined, col: Col, r: number, re: RegExp | undefined): void {
    const pinned = col.pinned;
    if (!data) {
      cell.className = 'tg-c ph' + (pinned ? ' pin' : '');
      cell.textContent = '';
      return;
    }
    if (this.logMode) {
      cell.className = 'tg-c log';
      renderLogLine(cell, data.c[0] ?? '', data.log, re, this.host.isHit(r, 0));
      return;
    }
    const v = data.c[col.li] ?? '';
    const kind = data.k?.[col.li];
    let cls = 'tg-c';
    if (pinned) cls += ' pin';
    if (col.type === 'int' || col.type === 'float') cls += ' num';
    if (kind) {
      if (kind === 'u') cls += ' missing';
      else if (kind === 'z') cls += ' v-null';
      else if (kind === 'o' || kind === 'a') cls += ' json';
      else if (kind === 'n') cls += ' num';
      else if (kind === 'b') cls += ' v-bool';
    } else if (col.type === 'bool' && v) cls += ' v-bool';
    if (v === '' && kind !== 'z') cls += ' empty';
    if (data.tr?.includes(col.li)) cls += ' trunc';
    cell.className = cls;
    const text = kind === 'z' ? 'null' : v;
    setHighlighted(cell, this.wrap ? text : text.length > 400 ? text.slice(0, 400) : text, re, this.host.isHit(r, col.li));
  }

  private renderHeader(c0: number, c1: number): void {
    if (this.logMode) return;
    const key = `${this.headVer}:${c0}:${c1}:${this.selVer}`;
    if (this.head.dataset.k === key) return;
    this.head.dataset.k = key;
    this.headTrack.textContent = '';
    for (const el of [...this.head.children]) if (el !== this.headTrack) el.remove();
    const corner = h('div', { class: 'tg-corner', title: '' });
    corner.style.width = this.gutW + 'px';
    const [, , sc0, sc1] = this.selRect();
    const add = (c: number) => {
      const col = this.cols[c];
      const sort = this.host.sortOf(col.key);
      const cell = h(
        'div',
        { class: 'tg-h' + (col.pinned ? ' pin' : '') + (col.type === 'int' || col.type === 'float' ? ' num' : '') + (c >= sc0 && c <= sc1 && this.sel.mode !== 'rows' ? ' sel' : ''), role: 'columnheader', 'data-c': c, 'aria-sort': sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined, title: col.name },
        h('span', { class: 'tg-ty', title: '' }, icon(TYPE_ICON[col.type], 14)),
        h('span', { class: 'tg-hn' }, col.name),
        sort ? h('span', { class: 'tg-sort' }, icon(sort === 'asc' ? 'arrowUp' : 'arrowDown', 12)) : null,
        this.host.filtered(col.key) ? h('span', { class: 'tg-fl' }, icon('filter', 12)) : null,
        h('button', { class: 'tg-hm', tabindex: -1, 'data-menu': c, 'aria-label': 'menu' }, icon('chevronDown', 12)),
        h('span', { class: 'tg-rz', 'data-rz': c }),
      );
      cell.style.left = this.cellLeft(c) + 'px';
      cell.style.width = col.w + 'px';
      if (col.pinned) this.head.append(cell);
      else this.headTrack.append(cell);
    };
    for (let c = 0; c < this.nPinned; c++) add(c);
    for (let c = Math.max(c0, this.nPinned); c <= c1; c++) add(c);
    this.head.append(corner);
    this.stage.classList.toggle('has-pins', this.nPinned > 0);
    this.root.style.setProperty('--pinend', this.gutW + this.pinW + 'px');
    this.root.style.setProperty('--gw', this.gutW + 'px');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Selection

  /** [r0, r1, c0, c1] inclusive */
  selRect(): [number, number, number, number] {
    const s = this.sel;
    let r0 = Math.min(s.ar, s.fr);
    let r1 = Math.max(s.ar, s.fr);
    let c0 = Math.min(s.ac, s.fc);
    let c1 = Math.max(s.ac, s.fc);
    if (s.mode === 'rows') {
      c0 = 0;
      c1 = this.cols.length - 1;
    }
    if (s.mode === 'cols') {
      r0 = 0;
      r1 = this.count - 1;
    }
    return [r0, r1, c0, c1];
  }

  private paintSelection(re: RowEl): void {
    re.selVer = this.selVer;
    const [r0, r1, c0, c1] = this.selRect();
    const inRows = re.r >= r0 && re.r <= r1;
    const active = re.r === this.sel.fr;
    re.el.classList.toggle('sel', inRows && this.sel.mode === 'rows');
    re.el.classList.toggle('act', active);
    re.gut.classList.toggle('sel', inRows);
    for (const [c, cell] of re.cells) {
      const s = inRows && c >= c0 && c <= c1 && !this.logMode;
      cell.classList.toggle('sel', s);
      const a = active && c === this.sel.fc && !this.logMode;
      cell.classList.toggle('act', a);
      if (a) {
        cell.id = 'tg-active';
        this.root.setAttribute('aria-activedescendant', 'tg-active');
      } else if (cell.id) cell.removeAttribute('id');
      cell.setAttribute('aria-selected', s ? 'true' : 'false');
    }
  }

  setSel(s: Sel, scroll = true): void {
    const r = Math.max(0, Math.min(this.count - 1, s.fr));
    const c = Math.max(0, Math.min(this.cols.length - 1, s.fc));
    this.sel = { ...s, fr: r, fc: c, ar: Math.max(0, Math.min(this.count - 1, s.ar)), ac: Math.max(0, Math.min(this.cols.length - 1, s.ac)) };
    this.selVer++;
    if (scroll) {
      if (s.mode !== 'cols') this.scrollToRow(r);
      if (s.mode !== 'rows') this.scrollToCol(c);
    }
    this.schedule();
    this.host.selectionChanged();
  }

  select(r: number, c: number, extend: boolean, mode: Sel['mode'] = 'cells'): void {
    if (extend) this.setSel({ ...this.sel, fr: r, fc: c, mode: this.sel.mode === mode ? mode : this.sel.mode });
    else this.setSel({ ar: r, ac: c, fr: r, fc: c, mode });
  }

  selectAll(): void {
    this.setSel({ ar: 0, ac: 0, fr: this.count - 1, fc: this.cols.length - 1, mode: 'cells' }, false);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Hit testing

  /** Cell under a client point: row (-1 = header), display column (-1 = gutter). */
  hit(cx: number, cy: number): { r: number; c: number } {
    const rect = this.stage.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    let r: number;
    if (y < this.headH) r = -1;
    else r = this.rowAtY(this.y + (y - this.headH));
    let c: number;
    if (x < this.gutW) c = -1;
    else if (x < this.gutW + this.pinW) {
      c = 0;
      while (c + 1 < this.nPinned && this.pinX[c + 1] <= x - this.gutW) c++;
    } else {
      const xx = x - this.gutW - this.pinW + this.scroller.scrollLeft;
      let lo = 0;
      let hi = this.cols.length - this.nPinned - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.xs[mid] <= xx) lo = mid;
        else hi = mid - 1;
      }
      c = this.nPinned + Math.max(0, lo);
    }
    return { r, c: Math.min(c, this.cols.length - 1) };
  }

  /** Bounding rect (client coordinates) of a cell, for popups. */
  cellRect(r: number, c: number): DOMRect {
    const rect = this.stage.getBoundingClientRect();
    const x = c < 0 ? 0 : c < this.nPinned ? this.cellLeft(c) : this.cellLeft(c) - this.scroller.scrollLeft;
    const y = r < 0 ? 0 : this.headH + this.rowTop(r) - this.y;
    return new DOMRect(rect.left + x, rect.top + y, c < 0 ? this.gutW : this.cols[c]?.w ?? 0, r < 0 ? this.headH : this.rowHeight(r));
  }

  headerRect(c: number): DOMRect {
    return this.cellRect(-1, c);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Mouse

  private onMouseDown(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (this.editor && t === this.editor) return;
    if (e.button !== 0 && e.button !== 2) return;
    this.root.focus({ preventScroll: true });
    const rz = t.closest('[data-rz]') as HTMLElement | null;
    if (rz && e.button === 0) {
      const col = this.cols[Number(rz.dataset.rz)];
      this.drag = { kind: 'resize', col, x0: e.clientX, w0: col.w };
      e.preventDefault();
      return;
    }
    const menu = t.closest('[data-menu]') as HTMLElement | null;
    if (menu && e.button === 0) {
      const c = Number(menu.dataset.menu);
      this.host.headerMenu(this.cols[c], (menu.closest('.tg-h') as HTMLElement).getBoundingClientRect());
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const { r, c } = this.hit(e.clientX, e.clientY);
    if (this.editing) this.commitEditor('none');
    if (r === -1) {
      if (c < 0) {
        if (e.button === 0) this.selectAll();
        return;
      }
      if (e.button === 0) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) this.select(this.sel.mode === 'cols' ? this.sel.ar : 0, c, e.shiftKey, 'cols');
        else this.host.headerClick(this.cols[c], e);
      }
      return;
    }
    if (r >= this.count) return;
    if (e.button === 2) {
      const [r0, r1, c0, c1] = this.selRect();
      const inside = r >= r0 && r <= r1 && (c < 0 || (c >= c0 && c <= c1));
      if (!inside) this.select(r, Math.max(0, c), false, c < 0 || this.logMode ? 'rows' : 'cells');
      return;
    }
    if (c < 0 || this.logMode) {
      this.select(r, 0, e.shiftKey, 'rows');
      this.drag = { kind: 'sel' };
    } else {
      this.select(r, c, e.shiftKey, 'cells');
      this.drag = { kind: 'sel' };
    }
    e.preventDefault();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.drag) return;
    if (this.drag.kind === 'resize' && this.drag.col) {
      const w = Math.max(36, Math.min(2000, this.drag.w0! + e.clientX - this.drag.x0!));
      if (w !== this.drag.col.w) {
        this.drag.col.w = w;
        this.relayout();
      }
      return;
    }
    this.drag.lastX = e.clientX;
    this.drag.lastY = e.clientY;
    this.dragTo(e.clientX, e.clientY);
    const rect = this.scroller.getBoundingClientRect();
    const outside = e.clientY < rect.top + this.headH || e.clientY > rect.bottom || e.clientX > rect.right || e.clientX < rect.left + this.gutW + this.pinW;
    if (outside && !this.autoScroll) this.autoScroll = requestAnimationFrame(() => this.autoScrollStep());
  }

  private dragTo(cx: number, cy: number): void {
    const { r, c } = this.hit(cx, cy);
    const rr = Math.max(0, Math.min(this.count - 1, r < 0 ? this.rowAtY(this.y) : r));
    if (this.sel.mode === 'rows') {
      if (rr !== this.sel.fr) this.setSel({ ...this.sel, fr: rr }, false);
    } else {
      const cc = Math.max(0, c);
      if (rr !== this.sel.fr || cc !== this.sel.fc) this.setSel({ ...this.sel, fr: rr, fc: cc }, false);
    }
  }

  private autoScrollStep(): void {
    this.autoScroll = 0;
    if (!this.drag || this.drag.kind !== 'sel' || this.drag.lastY === undefined) return;
    const rect = this.scroller.getBoundingClientRect();
    const cy = this.drag.lastY;
    const cx = this.drag.lastX!;
    let dy = 0;
    let dx = 0;
    if (cy < rect.top + this.headH) dy = -Math.min(40, rect.top + this.headH - cy);
    else if (cy > rect.bottom) dy = Math.min(40, cy - rect.bottom);
    if (cx > rect.right) dx = Math.min(40, cx - rect.right);
    else if (cx < rect.left + this.gutW + this.pinW && this.sel.mode === 'cells') dx = -Math.min(40, rect.left + this.gutW + this.pinW - cx);
    if (!dx && !dy) return;
    if (dy) this.setY(this.y + dy);
    if (dx) this.scroller.scrollLeft += dx;
    this.dragTo(Math.min(Math.max(cx, rect.left + this.gutW + this.pinW + 1), rect.right - 2), Math.min(Math.max(cy, rect.top + this.headH + 1), rect.bottom - 2));
    this.autoScroll = requestAnimationFrame(() => this.autoScrollStep());
  }

  private onMouseUp(): void {
    if (this.drag?.kind === 'resize' && this.drag.col) this.host.widthChanged(this.drag.col);
    this.drag = undefined;
  }

  private onDblClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const rz = t.closest('[data-rz]') as HTMLElement | null;
    if (rz) {
      this.host.fitWidth(this.cols[Number(rz.dataset.rz)]);
      return;
    }
    const { r, c } = this.hit(e.clientX, e.clientY);
    if (r >= 0 && c >= 0 && r < this.count && !this.logMode) void this.startEdit(r, c);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const { r, c } = this.hit(e.clientX, e.clientY);
    this.host.contextMenu(e, r === -1 && c >= 0 ? this.cols[c] : undefined);
  }

  private onOver(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest('.tg-c') as HTMLElement | null;
    if (!cell || cell.title) return;
    if (cell.scrollWidth > cell.clientWidth + 1 || cell.classList.contains('trunc')) {
      const t = cell.textContent ?? '';
      cell.title = t.length > 2000 ? t.slice(0, 2000) + '…' : t;
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Keyboard

  private pageRows(): number {
    return Math.max(1, Math.floor(this.bodyH() / this.rowH) - 1);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const s = this.sel;
    let r = s.fr;
    let c = s.fc;
    const lastR = this.count - 1;
    const lastC = this.cols.length - 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        r = mod ? lastR : r + 1;
        break;
      case 'ArrowUp':
        r = mod ? 0 : r - 1;
        break;
      case 'ArrowRight':
        c = mod ? lastC : c + 1;
        break;
      case 'ArrowLeft':
        c = mod ? 0 : c - 1;
        break;
      case 'PageDown':
        r += this.pageRows();
        break;
      case 'PageUp':
        r -= this.pageRows();
        break;
      case 'Home':
        if (mod) r = 0;
        c = 0;
        break;
      case 'End':
        if (mod) r = lastR;
        c = lastC;
        break;
      case 'Tab':
        c += e.shiftKey ? -1 : 1;
        if (c > lastC) {
          c = 0;
          r++;
        } else if (c < 0) {
          c = lastC;
          r--;
        }
        this.select(Math.max(0, Math.min(lastR, r)), c, false, 'cells');
        e.preventDefault();
        e.stopPropagation();
        return;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      if (this.logMode && (e.key === 'Home' || e.key === 'End') && !mod) r = e.key === 'Home' ? 0 : lastR;
      r = Math.max(0, Math.min(lastR, r));
      c = Math.max(0, Math.min(lastC, c));
      const mode = this.logMode ? 'rows' : s.mode === 'cols' && !e.shiftKey ? 'cells' : s.mode;
      if (e.shiftKey && e.key !== 'Tab') this.setSel({ ...s, fr: r, fc: c, mode: mode === 'cols' ? 'cells' : mode });
      else this.setSel({ ar: r, ac: c, fr: r, fc: c, mode: this.logMode ? 'rows' : 'cells' });
      return;
    }
    const k = e.key.toLowerCase();
    if (mod && k === 'a') {
      this.selectAll();
    } else if (mod && k === 'c') {
      this.host.copy();
    } else if (mod && k === 'v') {
      if (this.host.canEdit()) this.host.paste();
    } else if (mod && k === 'f') {
      this.host.find();
    } else if ((e.key === 'Enter' || e.key === 'F2') && !mod && !this.logMode) {
      void this.startEdit(s.fr, s.fc);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && this.host.canEdit()) {
      this.host.clear();
    } else if (e.key === 'Escape') {
      if (s.ar !== s.fr || s.ac !== s.fc || s.mode !== 'cells') this.setSel({ ar: s.fr, ac: s.fc, fr: s.fr, fc: s.fc, mode: this.logMode ? 'rows' : 'cells' }, false);
      else return;
    } else if (e.key.length === 1 && !mod && !e.altKey && this.host.canEdit() && !this.logMode) {
      void this.startEdit(s.fr, s.fc, e.key);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Editing

  async startEdit(r: number, c: number, initial?: string): Promise<void> {
    if (!this.host.canEdit() || r < 0 || r >= this.count || c < 0) return;
    const col = this.cols[c];
    this.select(r, c, false);
    const value = initial ?? (await this.host.editValue(r, col));
    if (value === undefined) return;
    this.editing = { r, c, original: initial === undefined ? value : '' };
    if (!this.editor) {
      this.editor = h('textarea', { class: 'tg-editor', rows: 1, spellcheck: 'false', 'aria-label': col.name });
      this.editor.addEventListener('keydown', (e) => this.onEditorKey(e));
      this.editor.addEventListener('blur', () => {
        if (this.editing) this.commitEditor('none');
      });
      this.editor.addEventListener('input', () => this.positionEditor());
    }
    this.editor.value = value;
    this.stage.append(this.editor);
    this.positionEditor();
    this.editor.focus();
    const len = this.editor.value.length;
    this.editor.setSelectionRange(len, len);
  }

  private positionEditor(): void {
    if (!this.editor || !this.editing) return;
    const { r, c } = this.editing;
    const col = this.cols[c];
    const x = c < this.nPinned ? this.cellLeft(c) : this.cellLeft(c) - this.scroller.scrollLeft;
    const y = this.headH + this.rowTop(r) - this.y;
    const ed = this.editor;
    ed.style.left = Math.max(this.gutW, x) + 'px';
    ed.style.top = y + 'px';
    ed.style.width = Math.max(col.w, 160) + 'px';
    // grow with the content (multi-line values), but a one-line value is exactly one row tall
    const rh = this.rowHeight(r);
    ed.style.height = rh + 'px';
    const border = ed.offsetHeight - ed.clientHeight;
    ed.style.height = Math.min(240, Math.max(rh, ed.scrollHeight + border)) + 'px';
  }

  private onEditorKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.commitEditor(e.ctrlKey || e.metaKey ? 'none' : 'down');
    } else if (e.key === 'Enter' && (e.shiftKey || e.altKey)) {
      // newline inside the cell
      if (e.altKey) {
        e.preventDefault();
        const ed = this.editor!;
        const p = ed.selectionStart;
        ed.setRangeText('\n', p, ed.selectionEnd, 'end');
        this.positionEditor();
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.commitEditor(e.shiftKey ? 'left' : 'right');
    }
  }

  private cancelEdit(): void {
    this.editing = undefined;
    this.editor?.remove();
    this.root.focus({ preventScroll: true });
  }

  commitEditor(move: 'down' | 'right' | 'left' | 'up' | 'none'): void {
    if (!this.editing || !this.editor) return;
    const { r, c } = this.editing;
    const value = this.editor.value;
    this.editing = undefined;
    this.editor.remove();
    this.host.commitEdit(r, this.cols[c], value, move);
    this.root.focus({ preventScroll: true });
    if (move === 'down') this.select(Math.min(this.count - 1, r + 1), c, false);
    else if (move === 'right') this.select(r, Math.min(this.cols.length - 1, c + 1), false);
    else if (move === 'left') this.select(r, Math.max(0, c - 1), false);
  }

  get isEditing(): boolean {
    return !!this.editing;
  }

  focus(): void {
    this.root.focus({ preventScroll: true });
  }
}
