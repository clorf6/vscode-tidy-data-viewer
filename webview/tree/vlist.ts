// Virtualised list of fixed-height rows whose data lives on the host. Rows are fetched in windows, cached, and
// recycled DOM nodes are positioned inside a sticky layer, so the scroll range can be scaled down for lists with
// millions of rows (browsers cap element heights at roughly 16–33 M px).
import type { Row } from '../../src/tree/protocol';

const MAX_PX = 6_000_000;
const CACHE_MAX = 30_000;

export interface VListOptions {
  rowHeight: number;
  render(el: HTMLElement, row: Row | undefined, index: number): void;
  request(start: number, end: number, version: number): void;
  onScroll?(): void;
  /** after each repaint */
  onPaint?(): void;
}

export class VList {
  readonly el: HTMLDivElement;
  private layer: HTMLDivElement;
  private inner: HTMLDivElement;
  private sizer: HTMLDivElement;
  rowH: number;
  total = 0;
  version = -1;
  readonly cache = new Map<number, Row>();
  private shown = new Map<number, HTMLElement>();
  private pool: HTMLElement[] = [];
  private pending = '';
  private pendingAt = 0;
  first = 0;
  private offset = 0;
  private width = 0;
  private raf = 0;
  /** rows that must be re-rendered even when their data is unchanged (selection etc.) */
  private dirty = true;

  constructor(
    parent: HTMLElement,
    private o: VListOptions,
  ) {
    this.rowH = o.rowHeight;
    this.el = document.createElement('div');
    this.el.className = 'vl';
    this.el.tabIndex = 0;
    this.layer = document.createElement('div');
    this.layer.className = 'vl-layer';
    this.inner = document.createElement('div');
    this.inner.className = 'vl-rows';
    this.layer.append(this.inner);
    this.sizer = document.createElement('div');
    this.sizer.className = 'vl-sizer';
    this.el.append(this.layer, this.sizer);
    parent.append(this.el);
    this.el.addEventListener('scroll', () => {
      this.update();
      o.onScroll?.();
    });
    new ResizeObserver(() => this.layout()).observe(this.el);
  }

  get viewportH(): number {
    return this.el.clientHeight || 1;
  }

  get visibleCount(): number {
    return Math.ceil(this.viewportH / this.rowH);
  }

  private get contentH(): number {
    return this.total * this.rowH;
  }

  private get scrollH(): number {
    return Math.min(this.contentH, MAX_PX);
  }

  /** scrollTop → first content pixel shown */
  private toContent(scrollTop: number): number {
    const vh = this.viewportH;
    if (this.contentH <= MAX_PX) return scrollTop;
    const range = this.scrollH - vh;
    return range > 0 ? (scrollTop / range) * (this.contentH - vh) : 0;
  }

  private toScroll(px: number): number {
    const vh = this.viewportH;
    if (this.contentH <= MAX_PX) return px;
    const range = this.contentH - vh;
    return range > 0 ? (px / range) * (this.scrollH - vh) : 0;
  }

  setWidth(px: number): void {
    if (px === this.width) return;
    this.width = px;
    const w = px ? px + 'px' : '';
    this.inner.style.minWidth = w;
    this.layer.style.minWidth = w;
    this.sizer.style.minWidth = w;
  }

  setRowHeight(h: number): void {
    if (h === this.rowH) return;
    this.rowH = h;
    this.layout();
  }

  /** New data set (a new version): replaces the cache. */
  reset(total: number, version: number, start: number, rows: Row[]): void {
    this.total = total;
    this.version = version;
    this.cache.clear();
    this.pending = '';
    rows.forEach((r, k) => this.cache.set(start + k, r));
    for (const el of this.shown.values()) this.recycle(el);
    this.shown.clear();
    this.layout();
  }

  fill(version: number, start: number, rows: Row[]): void {
    if (version !== this.version) return;
    rows.forEach((r, k) => this.cache.set(start + k, r));
    this.pending = '';
    if (this.cache.size > CACHE_MAX) {
      const lo = this.first - CACHE_MAX / 3;
      const hi = this.first + CACHE_MAX / 3;
      for (const k of this.cache.keys()) if (k < lo || k > hi) this.cache.delete(k);
    }
    this.invalidate();
  }

  layout(): void {
    const vh = this.viewportH;
    this.sizer.style.height = Math.max(0, this.scrollH - vh) + 'px';
    this.layer.style.height = vh + 'px';
    this.invalidate();
  }

  /** Re-render visible rows (data unchanged, e.g. selection moved). */
  invalidate(): void {
    this.dirty = true;
    this.update();
  }

  private recycle(el: HTMLElement): void {
    el.remove();
    if (this.pool.length < 200) this.pool.push(el);
  }

  /** First content pixel at the top of the viewport. */
  toContentTop(): number {
    return this.toContent(this.el.scrollTop);
  }

  scrollTop(): number {
    return this.el.scrollTop;
  }

  setScrollTop(px: number): void {
    this.el.scrollTop = px;
    this.update();
  }

  /** Scroll so that row r is visible (align: 'auto' keeps it if already visible, 'center' centres it). */
  reveal(r: number, align: 'auto' | 'center' | 'top' = 'auto'): void {
    if (r < 0 || r >= this.total) return;
    const vh = this.viewportH;
    const top = r * this.rowH;
    const cur = this.toContent(this.el.scrollTop);
    let target = cur;
    if (align === 'center') target = top - vh / 2 + this.rowH / 2;
    else if (align === 'top') target = top;
    else if (top < cur) target = top;
    else if (top + this.rowH > cur + vh) target = top + this.rowH - vh;
    target = Math.max(0, Math.min(target, this.contentH - vh));
    if (Math.abs(target - cur) < 0.5) return;
    this.el.scrollTop = this.toScroll(target);
    this.update();
  }

  /** Row index at a client Y coordinate. */
  rowAt(clientY: number): number {
    const rect = this.el.getBoundingClientRect();
    const y = clientY - rect.top + this.offset;
    const r = this.first + Math.floor(y / this.rowH);
    return r >= 0 && r < this.total ? r : -1;
  }

  elementOf(r: number): HTMLElement | undefined {
    return this.shown.get(r);
  }

  /** Visible range [start, end). */
  range(): [number, number] {
    return [this.first, Math.min(this.total, this.first + this.visibleCount + 1)];
  }

  private update(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  /** Synchronous repaint (used right after data arrives to avoid a blank frame). */
  paint(): void {
    const px = this.toContent(this.el.scrollTop);
    const first = Math.max(0, Math.floor(px / this.rowH));
    const offset = px - first * this.rowH;
    const moved = first !== this.first;
    this.first = first;
    if (offset !== this.offset) {
      this.offset = offset;
      this.inner.style.transform = `translateY(${-offset}px)`;
    }
    const count = this.visibleCount + 1;
    const last = Math.min(this.total, first + count);
    for (const [r, el] of this.shown) {
      if (r < first || r >= last) {
        this.recycle(el);
        this.shown.delete(r);
      }
    }
    let missing = false;
    for (let r = first; r < last; r++) {
      const row = this.cache.get(r);
      if (!row) missing = true;
      let el = this.shown.get(r);
      const fresh = !el;
      if (!el) {
        el = this.pool.pop() ?? document.createElement('div');
        this.shown.set(r, el);
        this.inner.append(el);
      }
      if (fresh || moved || this.dirty || el.dataset.v !== (row ? '1' : '0')) {
        el.style.top = (r - first) * this.rowH + 'px';
        el.style.height = this.rowH + 'px';
        el.dataset.v = row ? '1' : '0';
        this.o.render(el, row, r);
      }
    }
    this.dirty = false;
    this.o.onPaint?.();
    // fetch the visible window plus a margin on both sides
    const margin = Math.max(150, count * 3);
    const lo = Math.max(0, first - margin);
    const hi = Math.min(this.total, last + margin);
    let need = missing;
    if (!need) {
      for (const r of [lo, Math.max(lo, first - (margin >> 1)), Math.min(hi - 1, last + (margin >> 1)), hi - 1]) {
        if (r >= 0 && r < this.total && !this.cache.has(r)) {
          need = true;
          break;
        }
      }
    }
    if (need) {
      const key = `${this.version}:${lo}:${hi}`;
      const now = Date.now();
      if (key !== this.pending || now - this.pendingAt > 1500) {
        this.pending = key;
        this.pendingAt = now;
        this.o.request(lo, hi, this.version);
      }
    }
  }
}
