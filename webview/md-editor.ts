// Webview of Data Viewer's Markdown editor (custom text editor dataViewer.markdown, host: src/markdown/editor.ts).
//
// The host sends VS Code's own rendering of the document plus its source. Every block carries data-line /
// data-line-end (exclusive) from the markdown-it plugin, so a rendered block maps back to exactly its source lines:
// double-click (or ✎, or Enter on a selected block) edits those lines in place, table cells are edited one at a time,
// task checkboxes toggle their `[ ]`. Edits go back to the host as line replacements guarded by the original text.
import type { EditorStrings } from '../src/markdown/editor';
import type { ToHost, ToView, UiState } from '../src/markdown/protocol';
import { addColumn, emptyRow, replaceCell, splitLines, splitRow, unescapeCell, escapeCell } from '../src/markdown/source';
import { createBackToTop, createTableLayout, installCopyAndZoom, OWN_CONTROLS } from './md/features';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: ToHost) => vscode.postMessage(m);

const meta = document.getElementById('dv-md-data')!;
const S = JSON.parse(meta.dataset.strings || '{}') as EditorStrings;
let ui = JSON.parse(meta.dataset.ui || '{}') as UiState;
const fileName = meta.dataset.title || '';
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
const fmt = (s: string, ...a: (string | number)[]) => s.replace(/\{(\d+)\}/g, (_, i) => String(a[+i]));
const OUTLINE_W = 260;

interface Saved {
  line?: number;
}
const saved: Saved = (vscode.getState() as Saved | undefined) ?? {};

const body = document.querySelector<HTMLElement>('.markdown-body')!;
let source: string[] = [];
let rendered = false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function iconButton(cls: string, title: string, onClick: () => void, label?: string): HTMLButtonElement {
  const b = h('button', `dv-btn ${cls}`);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(h('span', 'dv-btn-icon'));
  if (label) b.appendChild(h('span', 'dv-btn-label', label));
  b.addEventListener('click', onClick);
  return b;
}

// ---- shared reading features ----------------------------------------------------------------------------------------
const lightbox = installCopyAndZoom({ top: S.top, close: S.close });
const top = createBackToTop(S.top);
document.body.appendChild(top.el);
const tables = createTableLayout(() => (document.body.classList.contains('dv-outline-open') && window.innerWidth >= 960 ? OUTLINE_W : 0));

// ---- toolbar ----------------------------------------------------------------------------------------------------------
const bar = h('div', 'dv-bar');
const outlineBtn = iconButton('dv-i-outline', S.outline, () => setUi({ ...ui, outline: !ui.outline }));
const titleEl = h('div', 'dv-bar-title', fileName);
titleEl.title = fileName;
const spacer = h('div', 'dv-bar-spacer');
const widthBtn = iconButton('dv-i-width', S.width, () => setUi({ ...ui, wide: !ui.wide }));
const sourceBtn = iconButton('dv-i-source dv-btn-primary', S.editSource, () => post({ type: 'command', id: 'editSource' }), S.editSource);

// Rarely used actions live in one "⋯" menu so the toolbar stays a single, small set of buttons.
const moreMenu = h('div', 'dv-more-menu');
moreMenu.setAttribute('role', 'menu');
moreMenu.hidden = true;
const moreItem = (cls: string, label: string, id: 'showPreview' | 'openAsText') => {
  const b = h('button', `dv-more-item ${cls}`);
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.append(h('span', 'dv-btn-icon'), h('span', 'dv-btn-label', label));
  b.addEventListener('click', () => {
    closeMore();
    post({ type: 'command', id });
  });
  return b;
};
moreMenu.append(moreItem('dv-i-preview', S.showPreview, 'showPreview'), moreItem('dv-i-text', S.openAsText, 'openAsText'));
const moreBtn = iconButton('dv-i-more', S.more, () => (moreMenu.hidden ? openMore() : closeMore()));
moreBtn.setAttribute('aria-haspopup', 'menu');
function openMore(): void {
  const r = moreBtn.getBoundingClientRect();
  moreMenu.style.top = `${r.bottom + 4}px`;
  moreMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  moreMenu.hidden = false;
  moreBtn.setAttribute('aria-expanded', 'true');
  (moreMenu.firstElementChild as HTMLElement | null)?.focus();
}
function closeMore(): void {
  if (moreMenu.hidden) return;
  moreMenu.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
}
document.addEventListener('mousedown', (e) => !moreMenu.contains(e.target as Node) && !moreBtn.contains(e.target as Node) && closeMore(), true);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMore(), true);
window.addEventListener('blur', closeMore);
document.body.appendChild(moreMenu);
bar.append(outlineBtn, titleEl, spacer, widthBtn, moreBtn, sourceBtn);
document.body.prepend(bar);
const barHeight = () => bar.offsetHeight || 0;

// ---- outline panel ------------------------------------------------------------------------------------------------------
const outline = h('nav', 'dv-outline');
outline.setAttribute('aria-label', S.outline);
const outlineHead = h('div', 'dv-outline-head', S.outline);
const outlineList = h('ul', 'dv-outline-list');
outline.append(outlineHead, outlineList);
document.body.appendChild(outline);
let outlineSig = '';
let headings: HTMLElement[] = [];

function buildOutline() {
  headings = Array.from(body.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')).filter((x) => !x.closest('.dv-edit'));
  const sig = headings.map((x) => x.tagName + x.id + '\u0000' + x.textContent).join('\u0001');
  if (sig === outlineSig) return;
  outlineSig = sig;
  outlineList.textContent = '';
  if (!headings.length) {
    outlineList.appendChild(h('li', 'dv-outline-empty', S.noHeadings));
    return;
  }
  const min = Math.min(...headings.map((x) => +x.tagName[1]));
  for (const hd of headings) {
    const li = h('li', `dv-ol-item dv-ol-l${Math.min(5, +hd.tagName[1] - min)}`);
    const a = h('a', undefined, (hd.textContent || '').trim());
    a.href = '#' + encodeURIComponent(hd.id);
    a.dataset.target = hd.id;
    a.title = a.textContent || '';
    li.appendChild(a);
    outlineList.appendChild(li);
  }
  activeHeading = -1;
  updateActiveHeading();
}

let activeHeading = -1;
function updateActiveHeading() {
  if (!headings.length) return;
  const y = barHeight() + 28;
  let idx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].getBoundingClientRect().top <= y) idx = i;
    else break;
  }
  if (idx < 0) idx = 0;
  if (idx === activeHeading) return;
  activeHeading = idx;
  const items = outlineList.querySelectorAll('.dv-ol-item');
  items.forEach((li, i) => li.classList.toggle('dv-active', i === idx));
  if (ui.outline) (items[idx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
}

outlineList.addEventListener('click', (e) => {
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-target]');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  revealFragment(a.dataset.target!);
  if (window.innerWidth < 960) setUi({ ...ui, outline: false });
});

function applyUi() {
  document.body.classList.toggle('dv-outline-open', ui.outline);
  document.body.classList.toggle('dv-full', ui.wide);
  outlineBtn.classList.toggle('dv-on', ui.outline);
  widthBtn.classList.toggle('dv-on', ui.wide);
  tables.queue();
  invalidateLines();
}
function setUi(next: UiState) {
  ui = next;
  applyUi();
  post({ type: 'ui', ui });
}

// ---- toast --------------------------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(message: string) {
  let t = document.querySelector<HTMLElement>('.dv-toast');
  if (!t) {
    t = h('div', 'dv-toast');
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.add('dv-show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('dv-show'), 4200);
}

// ---- applying renderings without flicker ----------------------------------------------------------------------------
// Top-level nodes are matched by their HTML with line attributes removed: an edit usually changes one block, so the
// common prefix and suffix stay in place (no image reloads, no layout jump) and only the middle is swapped. Matched
// nodes get their new line numbers. Our own later changes to nodes (table classes…) do not affect matching because the
// signature recorded is the HTML they were created from.
const LINE_ATTRS = /\s(?:data-line|data-line-end|data-task-line)="\d+"/g;
const sigs = new WeakMap<Node, { key: string; html: string }>();

function signature(n: Node): { key: string; html: string } {
  const html = n.nodeType === Node.ELEMENT_NODE ? (n as Element).outerHTML : n.textContent || '';
  return { key: html.replace(LINE_ATTRS, ''), html };
}

function syncLines(old: Element, next: Element) {
  const sel = '[data-line], [data-line-end], [data-task-line]';
  const a = [old, ...Array.from(old.querySelectorAll(sel))];
  const b = [next, ...Array.from(next.querySelectorAll(sel))];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    for (const attr of ['data-line', 'data-line-end', 'data-task-line']) {
      const v = b[i].getAttribute(attr);
      if (v === null) a[i].removeAttribute(attr);
      else if (a[i].getAttribute(attr) !== v) a[i].setAttribute(attr, v);
    }
  return true;
}

function visibleAnchor(): Element | undefined {
  const y = barHeight();
  for (const n of Array.from(body.children)) if (sigs.has(n) && n.getBoundingClientRect().bottom > y) return n;
  return undefined;
}

function applyHtml(html: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const next = Array.from(tpl.content.childNodes).filter((n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent || '').trim());
  const nextSig = next.map(signature);
  for (const n of Array.from(body.childNodes)) if (!sigs.has(n)) n.remove(); // stray whitespace, empty-state note
  const prev = Array.from(body.childNodes);

  const anchor = visibleAnchor();
  const anchorTop = anchor?.getBoundingClientRect().top;

  let a = 0;
  while (a < prev.length && a < next.length && sigs.get(prev[a])!.key === nextSig[a].key) a++;
  let b = 0;
  while (b < prev.length - a && b < next.length - a && sigs.get(prev[prev.length - 1 - b])!.key === nextSig[next.length - 1 - b].key) b++;

  const matched = (oldN: Node, i: number) => {
    const s = nextSig[i];
    if (sigs.get(oldN)!.html === s.html) return true;
    if (oldN.nodeType === Node.ELEMENT_NODE && syncLines(oldN as Element, next[i] as Element)) {
      sigs.set(oldN, s);
      return true;
    }
    return false;
  };
  // Prefix/suffix nodes whose line attributes cannot be synced (shouldn't happen) are simply replaced.
  const replace: [Node, number][] = [];
  for (let i = 0; i < a; i++) if (!matched(prev[i], i)) replace.push([prev[i], i]);
  for (let k = 0; k < b; k++) if (!matched(prev[prev.length - 1 - k], next.length - 1 - k)) replace.push([prev[prev.length - 1 - k], next.length - 1 - k]);
  for (const [oldN, i] of replace) {
    oldN.parentNode?.replaceChild(next[i], oldN);
    sigs.set(next[i], nextSig[i]);
  }

  const ref = b > 0 ? prev[prev.length - b] : null;
  for (const n of prev.slice(a, prev.length - b)) n.parentNode?.removeChild(n);
  const added = next.slice(a, next.length - b);
  added.forEach((n, k) => {
    body.insertBefore(n, ref && ref.parentNode === body ? ref : null);
    sigs.set(n, nextSig[a + k]);
  });

  if (!body.children.length) {
    const empty = h('div', 'dv-empty', S.empty);
    body.appendChild(empty);
  }

  // Keep what the reader was looking at where it was.
  if (anchor && anchorTop !== undefined && rendered) {
    const target = anchor.isConnected ? anchor : (added.find((n) => n.nodeType === Node.ELEMENT_NODE) as Element | undefined);
    if (target) {
      const delta = target.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) programmaticScroll(window.scrollY + delta);
    }
  }
}

// ---- source lines ↔ scroll position ----------------------------------------------------------------------------------
interface LineEl {
  el: HTMLElement;
  line: number;
  end: number;
}
let lineEls: LineEl[] | undefined;
const invalidateLines = () => (lineEls = undefined);

function lineMap(): LineEl[] {
  if (lineEls) return lineEls;
  const out: LineEl[] = [];
  for (const el of Array.from(body.querySelectorAll<HTMLElement>('[data-line]'))) {
    const line = Number(el.dataset.line);
    if (isNaN(line) || el.closest('.dv-hidden')) continue;
    const end = Math.max(line + 1, Number(el.dataset.lineEnd ?? line + 1) || line + 1);
    if (el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE') out.push({ el: el.parentElement, line, end });
    else if (!/^(PRE|UL|OL|THEAD|TBODY)$/.test(el.tagName)) out.push({ el, line, end });
  }
  return (lineEls = out.filter((x) => x.el.getClientRects().length > 0));
}

function lineAtScroll(): number {
  const map = lineMap();
  if (!map.length) return 0;
  const y = barHeight() + 8;
  let prev: LineEl | undefined;
  let prevRect: DOMRect | undefined;
  for (const e of map) {
    const r = e.el.getBoundingClientRect();
    if (r.top > y) {
      if (!prev || !prevRect) return e.line;
      if (y < prevRect.bottom) return prev.line + ((y - prevRect.top) / Math.max(1, prevRect.height)) * (prev.end - prev.line);
      const gap = Math.max(1, r.top - prevRect.bottom);
      return prev.end + ((y - prevRect.bottom) / gap) * Math.max(0, e.line - prev.end);
    }
    prev = e;
    prevRect = r;
  }
  if (prev && prevRect) return prev.line + Math.min(1, (y - prevRect.top) / Math.max(1, prevRect.height)) * (prev.end - prev.line);
  return 0;
}

function yForLine(line: number): number {
  const map = lineMap();
  let prev: LineEl | undefined;
  let next: LineEl | undefined;
  for (const e of map) {
    if (e.line <= line) prev = e;
    else {
      next = e;
      break;
    }
  }
  if (!prev) return 0;
  const r = prev.el.getBoundingClientRect();
  const topY = window.scrollY + r.top;
  if (line < prev.end) return topY + r.height * ((line - prev.line) / Math.max(1, prev.end - prev.line));
  if (next) {
    const nTop = window.scrollY + next.el.getBoundingClientRect().top;
    return topY + r.height + (nTop - topY - r.height) * ((line - prev.end) / Math.max(1, next.line - prev.end));
  }
  return topY + r.height;
}

let ignoreScrollUntil = 0;
function programmaticScroll(y: number) {
  ignoreScrollUntil = Date.now() + 150;
  window.scrollTo(window.scrollX, Math.max(0, y));
}
function scrollToLine(line: number) {
  programmaticScroll(line <= 0 ? 0 : yForLine(line) - barHeight() - 8);
}

let scrollQueued = false;
let lastSent = -1;
window.addEventListener(
  'scroll',
  () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      updateActiveHeading();
      hideTools();
      const line = lineAtScroll();
      saved.line = line;
      vscode.setState(saved);
      if (Date.now() < ignoreScrollUntil || !rendered) return;
      if (Math.abs(line - lastSent) < 0.05) return;
      lastSent = line;
      post({ type: 'revealLine', line });
    });
  },
  { passive: true },
);
window.addEventListener('resize', invalidateLines);

function revealFragment(fragment: string) {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    /* raw */
  }
  const el = document.getElementById(id) ?? document.getElementById(id.toLowerCase()) ?? document.querySelector<HTMLElement>(`[name="${CSS.escape(id)}"]`);
  if (!el) return;
  programmaticScroll(window.scrollY + el.getBoundingClientRect().top - barHeight() - 14);
  el.classList.remove('dv-flash');
  void el.offsetWidth;
  el.classList.add('dv-flash');
  window.setTimeout(() => {
    lastSent = -1;
    post({ type: 'revealLine', line: lineAtScroll() });
  }, 200);
}

// ---- blocks ---------------------------------------------------------------------------------------------------------
interface Block {
  start: number;
  end: number;
  /** Rendered nodes hidden while the block is edited. */
  nodes: Element[];
  /** Element that carries the range. */
  el: Element;
}

function visualOf(el: Element): Element {
  if (el.tagName === 'CODE') return el.closest('.dv-code') ?? el.parentElement ?? el;
  if (el.tagName === 'TABLE') return el.closest('.dv-table-wrap') ?? el;
  return el;
}

function topLevel(n: Node): Element | undefined {
  let cur: Node | null = n;
  while (cur && cur.parentNode !== body) cur = cur.parentNode;
  return cur && cur.nodeType === Node.ELEMENT_NODE ? (cur as Element) : undefined;
}

/** A block's range without the blank lines markdown-it counts into lists (editing must not swallow separators). */
function trimmed(start: number, end: number): [number, number] {
  while (end - 1 > start && !(source[end - 1] ?? '').trim()) end--;
  return [start, end];
}

function blockOf(target: Element): Block | undefined {
  if (!body.contains(target) || target.closest('.dv-edit')) return undefined;
  let el = target.closest('[data-line-end]');
  while (el && /^(TR|THEAD|TBODY|TH|TD)$/.test(el.tagName)) el = el.parentElement?.closest('[data-line-end]') ?? null;
  if (el && body.contains(el)) {
    const start = Number(el.getAttribute('data-line'));
    const end = Number(el.getAttribute('data-line-end'));
    if (!isNaN(start) && !isNaN(end) && end > start) {
      const [s0, e0] = trimmed(start, end);
      return { start: s0, end: e0, nodes: [visualOf(el)], el };
    }
  }
  // Raw HTML blocks: the preview puts an empty marker <div data-line …> in front of the HTML it renders verbatim.
  const topEl = topLevel(target);
  if (!topEl) return undefined;
  const nodes: Element[] = [];
  for (let cur: Element | null = topEl; cur; cur = cur.previousElementSibling) {
    if (cur.hasAttribute('data-line')) {
      if (cur.tagName !== 'DIV' || cur.childNodes.length || !cur.hasAttribute('data-line-end')) return undefined;
      for (let n = cur.nextElementSibling; n && !n.hasAttribute('data-line'); n = n.nextElementSibling) nodes.push(n);
      const [s0, e0] = trimmed(Number(cur.getAttribute('data-line')), Number(cur.getAttribute('data-line-end')));
      return { start: s0, end: e0, nodes: nodes.length ? nodes : [cur], el: cur };
    }
  }
  return undefined;
}

function blockAtLine(line: number): Block | undefined {
  for (const el of Array.from(body.querySelectorAll(`[data-line="${line}"][data-line-end]`))) {
    const b = blockOf(el);
    if (b && b.start === line) return b;
  }
  return undefined;
}

// selection (click a block; Enter edits it, ↑/↓ move, Esc clears)
let selected: Block | undefined;
function select(b: Block | undefined, scroll = false) {
  for (const n of Array.from(document.querySelectorAll('.dv-selected'))) n.classList.remove('dv-selected');
  selected = b;
  if (!b) return;
  for (const n of b.nodes) n.classList.add('dv-selected');
  if (scroll) b.nodes[0].scrollIntoView({ block: 'nearest' });
}
function moveSelection(dir: 1 | -1) {
  if (!selected) return;
  const tops = Array.from(body.children).filter((n) => sigs.has(n));
  const cur = topLevel(selected.nodes[0]);
  let i = cur ? tops.indexOf(cur) : -1;
  for (i += dir; i >= 0 && i < tops.length; i += dir) {
    const b = blockOf(tops[i]);
    if (b) return select(b, true);
  }
}

// ---- inline block editor --------------------------------------------------------------------------------------------
interface Editor {
  wrap: HTMLElement;
  ta: HTMLTextAreaElement;
  block: Block;
  original: string;
  state: 'editing' | 'saving';
  note: HTMLElement;
}
let editor: Editor | undefined;
let pending: Extract<ToView, { type: 'render' }> | undefined;

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function openEditor(block: Block, caret?: { word: string; ratio: number }) {
  if (cell) closeCell(true);
  if (editor) {
    if (editor.block.start === block.start) return editor.ta.focus();
    saveEditor();
    if (editor) return;
  }
  hideTools();
  select(undefined);
  const original = source.slice(block.start, block.end).join('\n');
  const wrap = h('div', 'dv-edit');
  const head = h('div', 'dv-edit-head');
  const range = block.end - block.start > 1 ? fmt(S.editing, block.start + 1, block.end) : fmt(S.editingLine, block.start + 1);
  head.append(h('span', 'dv-edit-range', range), h('span', 'dv-edit-hint', fmt(S.saveHint, MOD)));
  const note = h('span', 'dv-edit-note');
  head.appendChild(note);
  const ta = h('textarea', 'dv-edit-text');
  ta.spellcheck = false;
  ta.value = original;
  ta.setAttribute('aria-label', range);
  const actions = h('div', 'dv-edit-actions');
  const save = h('button', 'dv-btn dv-btn-primary', S.save);
  save.type = 'button';
  save.title = `${MOD}+Enter`;
  const cancel = h('button', 'dv-btn', S.cancel);
  cancel.type = 'button';
  cancel.title = 'Esc';
  actions.append(cancel, save);
  wrap.append(head, ta, actions);
  const first = block.nodes[0];
  first.parentNode!.insertBefore(wrap, first);
  for (const n of block.nodes) n.classList.add('dv-hidden');
  invalidateLines();
  editor = { wrap, ta, block, original, state: 'editing', note };
  autosize(ta);
  ta.focus({ preventScroll: true });
  if (wrap.getBoundingClientRect().top < barHeight()) wrap.scrollIntoView({ block: 'nearest' });
  placeCaret(ta, original, caret);

  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeEditor();
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!e.shiftKey) document.execCommand('insertText', false, '  ');
      else outdent(ta);
    }
  });
  wrap.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && wrap.contains(to)) return;
    window.setTimeout(() => {
      if (editor?.wrap === wrap && editor.state === 'editing' && !wrap.contains(document.activeElement)) saveEditor();
    }, 0);
  });
  save.addEventListener('mousedown', (e) => e.preventDefault());
  save.addEventListener('click', () => saveEditor());
  cancel.addEventListener('mousedown', (e) => e.preventDefault());
  cancel.addEventListener('click', () => closeEditor());
}

function outdent(ta: HTMLTextAreaElement) {
  const v = ta.value;
  const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  const n = v.slice(lineStart, lineStart + 2).match(/^ {1,2}|^\t/)?.[0].length ?? 0;
  if (!n) return;
  ta.setSelectionRange(lineStart, lineStart + n);
  document.execCommand('delete');
}

function placeCaret(ta: HTMLTextAreaElement, text: string, caret?: { word: string; ratio: number }) {
  if (!caret?.word) {
    ta.setSelectionRange(text.length, text.length);
    return;
  }
  const want = caret.ratio * text.length;
  let best = -1;
  for (let i = text.indexOf(caret.word); i >= 0; i = text.indexOf(caret.word, i + 1)) if (best < 0 || Math.abs(i - want) < Math.abs(best - want)) best = i;
  if (best < 0) ta.setSelectionRange(Math.round(want), Math.round(want));
  else ta.setSelectionRange(best, best + caret.word.length);
}

function saveEditor() {
  if (!editor || editor.state !== 'editing') return;
  const text = editor.ta.value.replace(/\r\n?/g, '\n');
  if (text === editor.original) return closeEditor();
  editor.state = 'saving';
  editor.wrap.classList.add('dv-saving');
  editor.ta.readOnly = true;
  editor.note.textContent = S.saving;
  post({ type: 'editLines', start: editor.block.start, end: editor.block.end, original: editor.original, text });
}

function closeEditor() {
  const e = editor;
  if (!e) return;
  editor = undefined;
  e.wrap.remove();
  for (const n of e.block.nodes) n.classList.remove('dv-hidden');
  invalidateLines();
  flushPending();
}

// ---- table cells ----------------------------------------------------------------------------------------------------
interface CellEdit {
  td: HTMLTableCellElement;
  input: HTMLInputElement;
  row: number;
  col: number;
  line: string;
}
let cell: CellEdit | undefined;
let focusCellAfterRender: { row: number; col: number } | undefined;

function cellsOf(table: HTMLTableElement): HTMLTableCellElement[] {
  return Array.from(table.querySelectorAll<HTMLTableCellElement>('tr[data-line] > th, tr[data-line] > td')).filter((c) => c.closest('table') === table);
}

function openCell(td: HTMLTableCellElement) {
  if (editor) saveEditor();
  if (editor) return;
  if (cell) closeCell(true, false);
  const tr = td.parentElement as HTMLTableRowElement;
  const row = Number(tr.dataset.line);
  if (isNaN(row) || row >= source.length) return;
  hideTools();
  select(undefined);
  const line = source[row];
  const raw = splitRow(line)[td.cellIndex]?.raw ?? '';
  const input = h('input', 'dv-cell-input');
  input.type = 'text';
  input.value = raw;
  input.spellcheck = false;
  input.title = S.cellHint;
  const r = td.getBoundingClientRect();
  Object.assign(input.style, {
    left: `${window.scrollX + r.left}px`,
    top: `${window.scrollY + r.top}px`,
    width: `${Math.max(r.width, 140)}px`,
    height: `${r.height}px`,
    textAlign: getComputedStyle(td).textAlign,
    font: getComputedStyle(td).font,
  });
  document.body.appendChild(input);
  td.classList.add('dv-cell-editing');
  cell = { td, input, row, col: td.cellIndex, line };
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      closeCell(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCell(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const table = td.closest('table')!;
      const all = cellsOf(table);
      const next = all[all.indexOf(td) + (e.shiftKey ? -1 : 1)];
      closeCell(true, !next);
      if (next) openCell(next);
    }
  });
  input.addEventListener('blur', () => window.setTimeout(() => cell?.input === input && closeCell(true), 0));
}

function closeCell(commit: boolean, flush = true) {
  const c = cell;
  if (!c) return;
  cell = undefined;
  c.input.remove();
  c.td.classList.remove('dv-cell-editing');
  if (commit) {
    const next = replaceCell(c.line, c.col, c.input.value);
    if (next !== c.line && source[c.row] === c.line) {
      post({ type: 'editLines', start: c.row, end: c.row + 1, original: c.line, text: next });
      source[c.row] = next; // optimistic: the next cell edit on this row builds on it
      c.td.textContent = unescapeCell(escapeCell(c.input.value));
    }
  }
  if (flush) flushPending();
}

// table tools (shown on hover): add row below the hovered row, add a column, edit the table source
const tools = h('div', 'dv-table-tools');
let toolsTable: HTMLTableElement | undefined;
let toolsRow: HTMLTableRowElement | undefined;
tools.append(
  iconButton('dv-i-row', S.addRow, () => toolsTable && addRowBelow(toolsTable, toolsRow)),
  iconButton('dv-i-col', S.addColumn, () => toolsTable && addCol(toolsTable)),
  iconButton('dv-i-edit', S.tableSource, () => {
    const b = toolsTable && blockOf(toolsTable);
    if (b) openEditor(b);
  }),
);
document.body.appendChild(tools);

function tableRange(t: HTMLTableElement) {
  return { start: Number(t.dataset.line), end: Number(t.dataset.lineEnd) };
}
function addRowBelow(t: HTMLTableElement, tr?: HTMLTableRowElement) {
  const { start, end } = tableRange(t);
  if (isNaN(start) || isNaN(end) || end > source.length) return;
  const rowLine = tr ? Number(tr.dataset.line) : end - 1;
  const after = !tr || rowLine === start ? (tr ? start + 1 : end - 1) : rowLine;
  const cols = splitRow(source[start]).length;
  const original = source[after];
  focusCellAfterRender = { row: after + 1, col: 0 };
  post({ type: 'editLines', start: after, end: after + 1, original, text: original + '\n' + emptyRow(original, cols) });
}
function addCol(t: HTMLTableElement) {
  const { start, end } = tableRange(t);
  if (isNaN(start) || isNaN(end) || end > source.length) return;
  const lines = source.slice(start, end);
  focusCellAfterRender = { row: start, col: splitRow(lines[0]).length };
  post({ type: 'editLines', start, end, original: lines.join('\n'), text: addColumn(lines).join('\n') });
}

function showTools(t: HTMLTableElement, tr?: HTMLTableRowElement) {
  toolsTable = t;
  toolsRow = tr;
  const wrap = t.closest('.dv-table-wrap') ?? t;
  const r = wrap.getBoundingClientRect();
  // Beside the table's top-right corner when there is room, else just above it.
  const beside = r.right + tools.offsetWidth + 10 < document.documentElement.clientWidth;
  tools.style.left = `${window.scrollX + (beside ? r.right + 6 : r.right - tools.offsetWidth)}px`;
  tools.style.top = `${window.scrollY + (beside ? r.top : r.top - tools.offsetHeight - 4)}px`;
  tools.classList.add('dv-show');
}

// ✎ handle in the left gutter of the hovered block
const handle = iconButton('dv-handle dv-i-edit', S.editBlock, () => {
  if (handleBlock) openEditor(handleBlock);
});
document.body.appendChild(handle);
let handleBlock: Block | undefined;

function hideTools() {
  handle.classList.remove('dv-show');
  tools.classList.remove('dv-show');
  handleBlock = undefined;
}

let hoverQueued: MouseEvent | undefined;
document.addEventListener(
  'mousemove',
  (e) => {
    if (!hoverQueued) requestAnimationFrame(() => hover(hoverQueued!));
    hoverQueued = e;
  },
  { passive: true },
);
function hover(e: MouseEvent) {
  hoverQueued = undefined;
  const t = e.target;
  if (!(t instanceof Element) || editor || cell) return;
  if (t === handle || handle.contains(t) || tools.contains(t)) return;
  const b = blockOf(t);
  if (!b) return hideTools();
  handleBlock = b;
  const r = b.nodes[0].getBoundingClientRect();
  const left = body.getBoundingClientRect().left;
  handle.style.left = `${window.scrollX + left - 30}px`;
  handle.style.top = `${window.scrollY + r.top + Math.min(4, r.height / 2 - 11)}px`;
  handle.classList.add('dv-show');
  const table = t.closest('table');
  if (table && body.contains(table)) showTools(table as HTMLTableElement, (t.closest('tr') as HTMLTableRowElement | null) ?? undefined);
  else tools.classList.remove('dv-show');
}

// ---- events -----------------------------------------------------------------------------------------------------------
document.addEventListener(
  'click',
  (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const a = t.closest<HTMLAnchorElement>('a[href]');
    if (a && body.contains(a)) {
      e.preventDefault();
      const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
      if (href.startsWith('#')) revealFragment(href.slice(1));
      else post({ type: 'openLink', href });
      return;
    }
    if (!body.contains(t) || t.closest('input, button, summary, .dv-edit, .dv-code-bar') || lightbox.isOpen()) return;
    if (t instanceof HTMLImageElement) return;
    if (!window.getSelection()?.isCollapsed) return; // selecting text to copy
    select(blockOf(t));
  },
  true,
);

body.addEventListener('change', (e) => {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement) || !cb.classList.contains('task-list-item-checkbox')) return;
  const line = Number(cb.dataset.taskLine);
  if (isNaN(line)) return;
  cb.setAttribute('aria-checked', String(cb.checked));
  post({ type: 'toggleTask', line, checked: cb.checked });
});

document.addEventListener('dblclick', (e) => {
  const t = e.target;
  if (!(t instanceof Element) || !body.contains(t) || t.closest(`${OWN_CONTROLS}, .dv-edit, input, a, summary`)) return;
  if (t.closest('.dv-empty')) {
    e.preventDefault();
    openEditor({ start: 0, end: source.length, nodes: [t.closest('.dv-empty')!], el: t });
    return;
  }
  const td = t.closest<HTMLTableCellElement>('td, th');
  if (td && td.closest('tr[data-line]') && body.contains(td)) {
    e.preventDefault();
    openCell(td);
    return;
  }
  const b = blockOf(t);
  if (!b) return; // empty space: nothing (double-click no longer means "jump to source")
  e.preventDefault();
  // Open with the double-clicked word selected in the source.
  const sel = window.getSelection();
  const word = (sel?.toString() || '').trim();
  let ratio = 0;
  try {
    if (sel && sel.rangeCount) {
      const r = document.createRange();
      r.setStart(b.nodes[0], 0);
      r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      ratio = r.toString().length / Math.max(1, (b.nodes[0].textContent || '').length);
    }
  } catch {
    ratio = 0;
  }
  openEditor(b, { word, ratio });
});

document.addEventListener('keydown', (e) => {
  if (editor || cell || lightbox.isOpen()) return;
  const t = e.target as Element | null;
  if (t && t.closest('input, textarea, select, button, a, [contenteditable]')) return;
  if (!selected) return;
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const b = blockAtLine(selected.start) ?? selected;
    openEditor(b);
  } else if (e.key === 'Escape') select(undefined);
  else if (e.key === 'ArrowDown' && !e.shiftKey) {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp' && !e.shiftKey) {
    e.preventDefault();
    moveSelection(-1);
  }
});

// ---- messages from the host -------------------------------------------------------------------------------------------
function flushPending() {
  if (pending && !editor && !cell) {
    const m = pending;
    pending = undefined;
    onRender(m);
  }
}

function onRender(m: Extract<ToView, { type: 'render' }>) {
  if ((editor && editor.state === 'editing') || cell) {
    pending = m;
    return;
  }
  if (editor) {
    // our edit came back: the textarea makes way for the new rendering in the same frame
    const e = editor;
    editor = undefined;
    e.wrap.remove();
    for (const n of e.block.nodes) n.classList.remove('dv-hidden');
  }
  const selectedLine = selected?.start;
  applyHtml(m.html);
  source = splitLines(m.source);
  invalidateLines();
  tables.now();
  buildOutline();
  top.update();
  if (!rendered) {
    rendered = true;
    if (m.fragment) revealFragment(m.fragment);
    else if (saved.line) scrollToLine(saved.line);
  } else if (m.fragment) revealFragment(m.fragment);
  if (selectedLine !== undefined) {
    const b = blockAtLine(selectedLine);
    if (b) select(b);
    else selected = undefined;
  }
  if (focusCellAfterRender) {
    const f = focusCellAfterRender;
    focusCellAfterRender = undefined;
    const tr = body.querySelector(`tr[data-line="${f.row}"]`);
    const td = tr?.children[f.col];
    if (td instanceof HTMLTableCellElement) openCell(td);
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as ToView;
  switch (m?.type) {
    case 'render':
      return onRender(m);
    case 'scrollTo':
      if (!editor && !cell && rendered) scrollToLine(m.line);
      return;
    case 'reveal':
      return revealFragment(m.fragment);
    case 'refused':
      toast(m.message);
      focusCellAfterRender = undefined;
      if (editor && editor.state === 'saving') {
        editor.state = 'editing';
        editor.ta.readOnly = false;
        editor.wrap.classList.remove('dv-saving');
        editor.wrap.classList.add('dv-error');
        editor.note.textContent = m.message;
      }
      return;
    case 'style':
      document.documentElement.setAttribute('style', m.vars);
      document.body.classList.toggle('wordWrap', /\bwordWrap\b/.test(m.classes));
      tables.queue();
      return;
    case 'ui':
      ui = m.ui;
      return applyUi();
  }
});

applyUi();
post({ type: 'ready' });
