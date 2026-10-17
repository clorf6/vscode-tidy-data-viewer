// Text selection inside the virtualised views: the text a copy puts on the clipboard, and the "N characters selected"
// readout. Rows are absolutely positioned and recycled, so the browser's own serialisation (which puts every flex item
// on a line of its own and copies gutters, chevrons and badges) is replaced by a walk over the selected text nodes.
// No imports: the Markdown editor (which acquires the VS Code API itself) uses this module too.

export interface SerializeOpts {
  /** Elements whose text is never copied: chevrons, gutters, buttons, badges. */
  skip: string;
  /** A row element. Rows are joined with newlines. */
  row: string;
  /** Row index of a row element (used to fill rows that are not in the DOM, see `gap`). */
  index?: (row: Element) => number;
  /** Text of rows `from < r < to` that a selection spans but that are scrolled out of the DOM. */
  gap?: (from: number, to: number, first: Element | null) => string[];
  /** Cells within a row, joined with tabs. */
  cell?: string;
  /** Prefix for each row after the first (indentation relative to the first row). */
  prefix?: (row: Element, first: Element) => string;
  /** Displayed text → copied text (e.g. control-character glyphs back to the characters). `whole` = the text node's
   * start is part of the selection. */
  map?: (text: string, parent: Element, whole: boolean) => string;
}

/** The selection's range when it is non-empty and lies inside `root`. */
export function selectionIn(root: Element): Range | undefined {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined;
  const r = sel.getRangeAt(0);
  return root.contains(r.commonAncestorContainer) ? r : undefined;
}

export function serialize(range: Range, o: SerializeOpts): string {
  const top = range.commonAncestorContainer;
  const container = top.nodeType === Node.TEXT_NODE ? top.parentNode : top;
  if (!container) return '';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let out = '';
  let row: Element | null | undefined;
  let first: Element | null = null;
  let cell: Element | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(n)) continue;
    const parent = n.parentElement;
    if (!parent || parent.closest(o.skip)) continue;
    let s = n.data;
    if (n === range.endContainer) s = s.slice(0, range.endOffset);
    const whole = n !== range.startContainer || range.startOffset === 0;
    if (n === range.startContainer) s = s.slice(range.startOffset);
    if (!s) continue;
    const r = parent.closest(o.row);
    if (r !== row) {
      if (row !== undefined) {
        if (row && r && o.index && o.gap) {
          const a = o.index(row);
          const b = o.index(r);
          if (b > a + 1) for (const line of o.gap(a, b, first)) out += '\n' + line;
        }
        out += '\n' + (r && first && o.prefix ? o.prefix(r, first) : '');
      } else first = r;
      row = r;
      cell = null;
    }
    if (o.cell) {
      const c = parent.closest(o.cell);
      if (c && cell && c !== cell) out += '\t';
      if (c) cell = c;
    }
    out += o.map ? o.map(s, parent, whole) : s;
  }
  return out;
}

/** Whole text of one rendered row (for rows outside the DOM, rendered into a scratch element). */
export function rowText(el: Element, o: SerializeOpts): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  return serialize(r, { ...o, gap: undefined });
}

/** Characters (code points, so CJK and emoji count once) and lines of a piece of text. */
export function measure(text: string): { chars: number; lines: number } {
  let chars = 0;
  let lines = 1;
  for (const ch of text) {
    chars++;
    if (ch === '\n') lines++;
  }
  if (text.endsWith('\n')) lines--;
  return { chars, lines };
}

/**
 * Put the serialised selection on the clipboard when a copy happens inside `root` (Ctrl+C, the context menu, VS Code's
 * copy command — all of them fire the copy event).
 */
export function copySelection(root: Element, opts: () => SerializeOpts): void {
  document.addEventListener('copy', (e) => {
    const r = selectionIn(root);
    if (!r || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', serialize(r, opts()));
    e.preventDefault();
  });
}

/** Calls `fn` (at most once a frame) whenever the document selection changes. */
export function onSelectionChange(fn: () => void): void {
  let raf = 0;
  document.addEventListener('selectionchange', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      fn();
    });
  });
}

/** What is selected inside `el` (e.g. the word a double-click picked): its text and where it starts in `el`'s text. */
export function selectedIn(el: Element | null): { text: string; at: number } | undefined {
  const r = el && selectionIn(el);
  if (!el || !r) return undefined;
  const text = r.toString();
  return text.trim() ? { text, at: textOffset(el, r.startContainer, r.startOffset) } : undefined;
}

/**
 * Where a piece picked from the shown text lies in the raw text an editor opens with. The two can differ (quotes,
 * escapes, ↵ for newlines, truncation), so take the occurrence nearest to where it was shown.
 */
export function locate(raw: string, pick: { text: string; at: number } | undefined): [number, number] | undefined {
  if (!pick) return undefined;
  let best = -1;
  for (let i = raw.indexOf(pick.text); i >= 0; i = raw.indexOf(pick.text, i + 1)) if (best < 0 || Math.abs(i - pick.at) < Math.abs(best - pick.at)) best = i;
  return best < 0 ? undefined : [best, best + pick.text.length];
}

/** Character offset of (node, offset) within `el`'s text. */
export function textOffset(el: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(el, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  return r.toString().length;
}

/**
 * The (text node, offset) at character offset `off` within `el`, clamped to its end. An offset between two text nodes
 * goes to the start of the later one: the end of a line number and the start of the code after it are the same
 * offset, and only the latter is selectable.
 */
export function textPoint(el: Node, off: number): [Node, number] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (off < n.data.length || (off === 0 && !last)) return [n, Math.max(0, off)];
    off -= n.data.length;
    last = n;
  }
  return last ? [last, last.data.length] : [el, el.childNodes.length];
}

type Seg = { segment: string; index: number; isWordLike?: boolean };
const segmenter: { segment(s: string): Iterable<Seg> } | undefined =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new (Intl as unknown as { Segmenter: new (l?: string, o?: object) => { segment(s: string): Iterable<Seg> } }).Segmenter(undefined, { granularity: 'word' }) : undefined;

function caretAt(x: number, y: number): [Node, number] | undefined {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) return [p.offsetNode, p.offset];
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? [r.startContainer, r.startOffset] : undefined;
}

/**
 * Select the word under a point inside `unit` (double-click) or all of its text (triple-click). The browser's own word
 * selection runs on into neighbouring cells — their texts touch, with no space between — so the views do it themselves,
 * limited to one cell / value / line. Words come from Intl.Segmenter, so Chinese text splits into words too.
 */
export function selectAt(unit: Element, x: number, y: number, what: 'word' | 'all'): boolean {
  const sel = getSelection();
  if (!sel) return false;
  const text = unit.textContent ?? '';
  let s = 0;
  let e = text.length;
  if (what === 'word') {
    const pos = caretAt(x, y);
    if (!pos || !unit.contains(pos[0])) return false;
    const off = textOffset(unit, pos[0], pos[1]);
    // the caret can sit just after the character that was clicked: prefer a word on either side of it
    let at: Seg | undefined;
    let before: Seg | undefined;
    if (segmenter)
      for (const seg of segmenter.segment(text)) {
        if (off >= seg.index && off < seg.index + seg.segment.length) at = seg;
        if (off - 1 >= seg.index && off - 1 < seg.index + seg.segment.length) before = seg;
      }
    else {
      const word = (i: number): Seg | undefined => {
        if (i < 0 || i >= text.length || !/\w/.test(text[i])) return undefined;
        let a = i;
        let b = i + 1;
        while (a > 0 && /\w/.test(text[a - 1])) a--;
        while (b < text.length && /\w/.test(text[b])) b++;
        return { segment: text.slice(a, b), index: a, isWordLike: true };
      };
      at = word(off);
      before = word(off - 1);
    }
    const seg = at?.isWordLike ? at : before?.isWordLike ? before : (at ?? before);
    if (!seg) return false;
    s = seg.index;
    e = seg.index + seg.segment.length;
  }
  if (e <= s) return false;
  const [an, ao] = textPoint(unit, s);
  const [fn, fo] = textPoint(unit, e);
  try {
    sel.setBaseAndExtent(an, ao, fn, fo);
  } catch {
    return false;
  }
  return true;
}

/** A selection endpoint remembered across a re-render: which row element (by index) and where in its text. */
export interface SelPoint {
  r: number;
  off: number;
}

export interface SavedSelection {
  anchor: SelPoint | null;
  focus: SelPoint | null;
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

/**
 * Remember where the selection's ends are, relative to the rows they are in, so the selection survives rows being
 * rebuilt (selection moved, data arrived, search highlights). `rowOf` maps a node to its row element and index.
 */
export function saveSelection(root: Element, rowOf: (n: Node) => [Element, number] | undefined): SavedSelection | undefined {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return undefined;
  if (!root.contains(sel.anchorNode) && !root.contains(sel.focusNode)) return undefined;
  const point = (n: Node, off: number): SelPoint | null => {
    if (!root.contains(n)) return null;
    const hit = rowOf(n);
    return hit ? { r: hit[1], off: textOffset(hit[0], n, off) } : null;
  };
  const anchor = point(sel.anchorNode, sel.anchorOffset);
  const focus = point(sel.focusNode, sel.focusOffset);
  if (!anchor && !focus) return undefined;
  return { anchor, focus, anchorNode: sel.anchorNode, anchorOffset: sel.anchorOffset, focusNode: sel.focusNode, focusOffset: sel.focusOffset };
}

/**
 * Put the selection back after rows were rebuilt. `elementOf` gives the row element now showing a row index; an end
 * whose row is no longer shown is clamped to the nearest shown row (`first`/`last` are the shown rows' elements).
 */
export function restoreSelection(s: SavedSelection, elementOf: (r: number) => Element | undefined, bounds: () => [number, Element, number, Element] | undefined): void {
  const sel = getSelection();
  if (!sel) return;
  if (s.anchorNode.isConnected && s.focusNode.isConnected && sel.anchorNode === s.anchorNode && sel.focusNode === s.focusNode) return;
  const resolve = (p: SelPoint | null, node: Node, offset: number): [Node, number] | null => {
    // an end outside the rows was not touched by the re-render
    if (!p) return node.isConnected ? [node, offset] : null;
    const el = elementOf(p.r);
    if (el) return textPoint(el, p.off);
    const b = bounds();
    if (!b) return null;
    const [r0, el0, , el1] = b;
    return p.r < r0 ? textPoint(el0, 0) : textPoint(el1, Number.MAX_SAFE_INTEGER);
  };
  const a = resolve(s.anchor, s.anchorNode, s.anchorOffset);
  const f = resolve(s.focus, s.focusNode, s.focusOffset);
  if (!a || !f) return;
  try {
    sel.setBaseAndExtent(a[0], a[1], f[0], f[1]);
  } catch {
    /* nodes went away meanwhile */
  }
}
