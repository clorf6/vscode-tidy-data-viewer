// Cell/line rendering helpers: search highlighting, ANSI-styled log lines, pretty JSON with value colours.
import { h } from '../shared/vscode';
import type { LogLine } from '../../src/table/protocol';

/** Build a global, case-insensitive (unless matchCase) highlighter for a search query. */
export function highlighter(q: string, regex: boolean, matchCase: boolean, word = false): RegExp | undefined {
  if (!q) return undefined;
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (word) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, (matchCase ? 'g' : 'gi') + (word ? 'u' : ''));
  } catch {
    return undefined;
  }
}

/** Replace el's content with text, wrapping matches of re in <mark>. */
export function setHighlighted(el: HTMLElement, text: string, re: RegExp | undefined, current = false): void {
  if (!re || !text) {
    if (el.firstChild && el.childNodes.length === 1 && el.firstChild.nodeType === 3) {
      if (el.firstChild.nodeValue !== text) el.firstChild.nodeValue = text;
    } else el.textContent = text;
    return;
  }
  re.lastIndex = 0;
  let m = re.exec(text);
  if (!m) {
    el.textContent = text;
    return;
  }
  el.textContent = '';
  let last = 0;
  let guard = 0;
  while (m && guard++ < 200) {
    if (m[0] === '') {
      re.lastIndex++;
      m = re.exec(text);
      continue;
    }
    if (m.index > last) el.append(text.slice(last, m.index));
    el.append(h('mark', { class: 'dv-hit' + (current ? ' current' : '') }, m[0]));
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) el.append(text.slice(last));
}

const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'];

function ansiColor(c: string): string {
  if (!c) return '';
  if (c === 'inv') return 'var(--dv-bg)';
  if (c[0] === '#') return c;
  const n = Number(c);
  return `var(--vscode-terminal-ansi${ANSI_NAMES[n] ?? 'White'})`;
}

interface Run {
  s: number;
  e: number;
  cls: string;
  style?: string;
}

/** Render a log line: timestamp/level token classes, ANSI runs, search marks. */
export function renderLogLine(el: HTMLElement, text: string, log: LogLine | undefined, re: RegExp | undefined, current: boolean): void {
  el.textContent = '';
  if (!text) return;
  // boundaries from all decorations
  const marks: [number, number][] = [];
  if (re) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 200) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      marks.push([m.index, m.index + m[0].length]);
    }
  }
  const cuts = new Set<number>([0, text.length]);
  const runs: Run[] = [];
  if (log?.ts) runs.push({ s: log.ts[0], e: log.ts[1], cls: 'lg-ts' });
  if (log?.lt) runs.push({ s: log.lt[0], e: log.lt[1], cls: 'lg-lv lg-lv' + log.lv });
  if (log?.sp) for (const [s, e, st] of log.sp) runs.push({ s, e, cls: '', style: st });
  for (const r of runs) cuts.add(Math.max(0, Math.min(text.length, r.s))).add(Math.max(0, Math.min(text.length, r.e)));
  for (const [s, e] of marks) cuts.add(s).add(e);
  if (cuts.size === 2 && !runs.length) {
    el.textContent = text;
    return;
  }
  const pts = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    if (e <= s) continue;
    let cls = '';
    let fg = '';
    let bg = '';
    let flags = '';
    for (const r of runs)
      if (r.s <= s && r.e >= e) {
        if (r.cls) cls += ' ' + r.cls;
        if (r.style) {
          const [f, b, fl] = r.style.split(';');
          if (f) fg = f;
          if (b) bg = b;
          if (fl) flags += fl;
        }
      }
    const isMark = marks.some(([ms, me]) => ms <= s && me >= e);
    const piece = text.slice(s, e);
    if (!cls && !fg && !bg && !flags && !isMark) {
      el.append(piece);
      continue;
    }
    const span = isMark ? h('mark', { class: 'dv-hit' + (current ? ' current' : '') + cls }, piece) : h('span', { class: cls.trim() }, piece);
    if (fg) span.style.color = ansiColor(fg);
    if (bg) span.style.backgroundColor = ansiColor(bg);
    if (flags) {
      if (flags.includes('b')) span.classList.add('a-b');
      if (flags.includes('d')) span.classList.add('a-d');
      if (flags.includes('i')) span.classList.add('a-i');
      if (flags.includes('u')) span.classList.add('a-u');
      if (flags.includes('s')) span.classList.add('a-s');
    }
    el.append(span);
  }
}

/** Pretty-print compact JSON text into coloured DOM (works on raw text, so big integers survive). */
export function prettyJsonDom(raw: string): HTMLElement {
  const pre = h('pre', { class: 'dv-json' });
  let depth = 0;
  let i = 0;
  const s = raw;
  const ind = () => '\n' + '  '.repeat(depth);
  let afterKey = false;
  let count = 0;
  while (i < s.length && count++ < 200000) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const tok = s.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (s[k] === ' ') k++;
      const isKey = s[k] === ':';
      pre.append(h('span', { class: isKey ? 'v-key' : 'v-str' }, tok));
      afterKey = isKey;
      continue;
    }
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      let k = i + 1;
      while (s[k] === ' ' || s[k] === '\n') k++;
      if (s[k] === close) {
        pre.append(c + close);
        i = k + 1;
        continue;
      }
      depth++;
      pre.append(c + ind());
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      pre.append(ind() + c);
      i++;
      continue;
    }
    if (c === ',') {
      pre.append(',' + ind());
      i++;
      continue;
    }
    if (c === ':') {
      pre.append(': ');
      i++;
      continue;
    }
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && !',}] \n'.includes(s[j])) j++;
    const tok = s.slice(i, j);
    const cls = tok === 'true' || tok === 'false' ? 'v-bool' : tok === 'null' ? 'v-null' : 'v-num';
    pre.append(h('span', { class: cls }, tok));
    i = j;
    void afterKey;
  }
  return pre;
}
