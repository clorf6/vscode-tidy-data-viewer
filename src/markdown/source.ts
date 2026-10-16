// Pure helpers for editing Markdown source from the rendered view (no vscode imports: shared by the extension host,
// the editor webview and the tests).

// ---- task list items --------------------------------------------------------------------------------------------

/** `- [ ] x`, `* [x] x`, `1. [ ] x`, `> - [ ] x` (quotes and indentation allowed before the marker). */
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/;

export function isTaskLine(line: string): boolean {
  return TASK_LINE.test(line);
}

/** Toggle (or set) the checkbox on a task line; undefined when the line holds no task marker. */
export function toggleTaskLine(line: string, checked?: boolean): string | undefined {
  const m = TASK_LINE.exec(line);
  if (!m) return undefined;
  const next = checked ?? m[2] === ' ';
  return m[1] + (next ? '[x]' : '[ ]') + line.slice(m[0].length);
}

// ---- table rows -------------------------------------------------------------------------------------------------

export interface RowCell {
  /** Offsets of the cell's raw text in the line (between the pipes, untrimmed). */
  start: number;
  end: number;
  /** Raw source of the cell, trimmed (escapes such as `\|` kept). */
  raw: string;
}

/** Quote / list indentation in front of a table row (tables may live in blockquotes and list items). */
const ROW_PREFIX = /^(?:[ \t]*>)*[ \t]*/;

/**
 * Split a table row the way markdown-it does (GFM: only a backslash escapes a pipe — code spans do not protect it), so
 * cell i here is cell i in the rendered table. A leading and a trailing pipe are optional.
 */
export function splitRow(line: string): RowCell[] {
  const base = ROW_PREFIX.exec(line)![0].length;
  const pipes: number[] = [];
  for (let i = base; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '|') pipes.push(i);
  }
  const bounds = [base - 1, ...pipes, line.length];
  const cells: RowCell[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const start = bounds[k] + 1;
    const end = bounds[k + 1];
    cells.push({ start, end, raw: line.slice(start, end).trim() });
  }
  if (cells.length && !cells[0].raw && pipes.length && pipes[0] === firstNonSpace(line, base)) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1].raw && pipes.length && lastNonSpace(line) === pipes[pipes.length - 1]) cells.pop();
  return cells;
}

function firstNonSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}
function lastNonSpace(s: string): number {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i;
}

/** Text typed into a cell → cell source: one line, unescaped pipes escaped. */
export function escapeCell(text: string): string {
  let out = '';
  const t = text.replace(/\r?\n/g, '<br>');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && i + 1 < t.length) {
      out += t[i] + t[i + 1];
      i++;
    } else out += t[i] === '|' ? '\\|' : t[i];
  }
  return out.trim();
}

/** Cell source → the text it displays (for an optimistic update while the real render is on its way). */
export function unescapeCell(raw: string): string {
  return raw.replace(/\\\|/g, '|');
}

/** Replace cell `col` of a row line (padding with empty cells when the row is short). */
export function replaceCell(line: string, col: number, text: string): string {
  const cells = splitRow(line);
  const value = escapeCell(text);
  if (col < cells.length) {
    const c = cells[col];
    return line.slice(0, c.start) + ' ' + value + ' ' + line.slice(c.end);
  }
  // Short row: append the missing cells before a trailing pipe (or at the end).
  const missing = col - cells.length;
  const add = ' |'.repeat(missing) + ' ' + value + ' |';
  const trimmed = line.replace(/[ \t]+$/, '');
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) return trimmed + add;
  return trimmed + ' |' + add.replace(/ \|$/, '');
}

/** A new empty row shaped like `like` (same prefix and number of cells). */
export function emptyRow(like: string, cells: number): string {
  const prefix = ROW_PREFIX.exec(like)![0];
  return prefix + '|' + '   |'.repeat(Math.max(1, cells));
}

/** Append a column to every line of a table (header, delimiter row, body rows). */
export function addColumn(lines: string[], header = ''): string[] {
  return lines.map((line, i) => {
    const cells = splitRow(line);
    const value = i === 1 ? '---' : i === 0 ? escapeCell(header) || ' ' : '';
    return replaceCell(line, cells.length, value);
  });
}

// ---- line ranges ------------------------------------------------------------------------------------------------

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** The lines [start, end) as one string (\n-joined), or undefined when the range is outside the text. */
export function sliceLines(lines: string[], start: number, end: number): string | undefined {
  if (start < 0 || end < start || end > lines.length) return undefined;
  return lines.slice(start, end).join('\n');
}

// ---- rendered HTML: safety and resources ------------------------------------------------------------------------

/**
 * Defence in depth for raw HTML inside Markdown (the webview's CSP already blocks inline scripts and handlers):
 * drop script/meta/base/iframe/object/embed elements, form wrappers, on* handlers and javascript: URLs.
 */
export function sanitizeHtml(html: string): string {
  let out = html
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    .replace(/<(iframe|object|frameset|frame)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/?(?:meta|base|embed|form|link)\b[^>]*>/gi, '');
  // on*= handlers and javascript: URLs inside any start tag
  out = out.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?(\/?)>/g, (all, tag: string, attrs: string | undefined, slash: string) => {
    if (!attrs) return all;
    const clean = attrs
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(\s(?:href|src|xlink:href|action|formaction|poster|data)\s*=\s*)(["']?)\s*(?:javascript|vbscript):[^"'\s>]*\2/gi, '$1$2#$2');
    return `<${tag}${clean}${slash}>`;
  });
  return out;
}

const MEDIA_TAG = /<(img|video|audio|source|track)\b([^>]*)>/gi;
const MEDIA_ATTR = /(\s(?:src|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi;

const decodeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encodeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rewrite src/poster of media elements through `resolve` (null → leave the value alone). */
export function rewriteMedia(html: string, resolve: (src: string) => string | null): string {
  return html.replace(MEDIA_TAG, (_all, tag: string, attrs: string) => {
    const next = attrs.replace(MEDIA_ATTR, (a, pre: string, _q: string, dq: string | undefined, sq: string | undefined) => {
      const value = decodeAttr(dq ?? sq ?? '');
      const r = value ? resolve(value) : null;
      return r === null ? a : `${pre}"${encodeAttr(r)}"`;
    });
    return `<${tag}${next}>`;
  });
}

/** Classify a media/link reference: kept as is (remote, data…), a file: URI, or a path (absolute or relative). */
export function classifyRef(ref: string): { kind: 'keep' } | { kind: 'file'; uri: string } | { kind: 'path'; path: string; suffix: string } {
  if (/^(?:https?|data|blob|vscode-webview-resource|vscode-resource|vscode-file):/i.test(ref) || ref.startsWith('//')) return { kind: 'keep' };
  if (/^file:/i.test(ref)) return { kind: 'file', uri: ref };
  if (/^[a-z][\w+.-]*:/i.test(ref)) return { kind: 'keep' };
  const cut = ref.search(/[?#]/);
  const p = cut < 0 ? ref : ref.slice(0, cut);
  const suffix = cut < 0 ? '' : ref.slice(cut);
  let decoded = p;
  try {
    decoded = decodeURI(p);
  } catch {
    /* keep it raw */
  }
  return { kind: 'path', path: decoded, suffix };
}
