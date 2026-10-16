// Log lines: level and timestamp detection, ANSI SGR parsing, carriage-return (progress bar) collapsing.
import { LogLine, LV_DEBUG, LV_ERROR, LV_FATAL, LV_INFO, LV_NONE, LV_TRACE, LV_WARN } from './protocol';

const WORDS: Record<string, number> = {
  FATAL: LV_FATAL,
  CRITICAL: LV_FATAL,
  CRIT: LV_FATAL,
  EMERG: LV_FATAL,
  PANIC: LV_FATAL,
  ALERT: LV_FATAL,
  ERROR: LV_ERROR,
  ERR: LV_ERROR,
  SEVERE: LV_ERROR,
  WARNING: LV_WARN,
  WARN: LV_WARN,
  NOTICE: LV_INFO,
  INFO: LV_INFO,
  DEBUG: LV_DEBUG,
  DBG: LV_DEBUG,
  VERBOSE: LV_DEBUG,
  FINE: LV_DEBUG,
  TRACE: LV_TRACE,
  FINEST: LV_TRACE,
};

// Upper-case level words anywhere in the head of the line.
const UPPER = /(?:^|[^A-Za-z0-9_])(FATAL|CRITICAL|CRIT|EMERG|PANIC|SEVERE|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|DBG|VERBOSE|TRACE)(?![A-Za-z0-9_])/;
// Lower/mixed case only in structured positions: [error], level=warn, "level":"info", <Error>, error: …
const STRUCT =
  /(?:\[|<|\blevel[=:]\s*"?|\bseverity[=:]\s*"?|"(?:level|severity|lvl|levelname)"\s*:\s*")(fatal|critical|crit|error|err|warning|warn|notice|info|debug|trace|verbose)\b|\b(fatal|error|warning|warn)(?=:)/i;
// Lines that are errors by shape.
const SHAPE = /^\s*(?:Traceback \(most recent call last\)|(?:[\w.]+\.)?\w*(?:Error|Exception)\b(?::|$)|panic:|Segmentation fault|Killed\b|FAILED\b|terminate called|CUDA error|RuntimeError\b|AssertionError\b)/;
const GLOG = /^([IWEF])\d{4} \d\d:\d\d:\d\d/;

const TS =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?|\d{4}\/\d{2}\/\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b|\b\d{10}(?:\.\d{3,6})\b/;

const HEAD = 240;

/** Level of a (stripped) line: [level, tokenStart, tokenEnd]; tokenStart = -1 when the level comes from the shape. */
export function detectLevel(text: string): [number, number, number] {
  const head = text.length > HEAD ? text.slice(0, HEAD) : text;
  const g = GLOG.exec(head);
  if (g) return [{ I: LV_INFO, W: LV_WARN, E: LV_ERROR, F: LV_FATAL }[g[1] as 'I'] ?? LV_NONE, 0, 1];
  let best: [number, number, number] | undefined;
  const u = UPPER.exec(head);
  if (u) {
    const s = u.index + u[0].length - u[1].length;
    best = [WORDS[u[1]], s, s + u[1].length];
  }
  const st = STRUCT.exec(head);
  if (st) {
    const word = (st[1] ?? st[2]).toUpperCase();
    const s = st.index + st[0].length - (st[1] ?? st[2]).length;
    if (!best || s < best[1]) best = [WORDS[word] ?? LV_NONE, s, s + word.length];
  }
  if (best) return best;
  if (SHAPE.test(head)) return [LV_ERROR, -1, -1];
  return [LV_NONE, -1, -1];
}

export function detectTimestamp(text: string): [number, number] | undefined {
  const m = TS.exec(text.length > 64 ? text.slice(0, 64) : text);
  if (!m || m.index > 40) return undefined;
  return [m.index, m.index + m[0].length];
}

/** Keep the last visible state of a line rewritten with carriage returns (tqdm, curl, pip progress). */
export function collapseCR(s: string): string {
  if (s.indexOf('\r') < 0) return s;
  const parts = s.split('\r');
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() !== '') return parts[i];
  return '';
}

const ANSI = /\x1b(?:\[([0-9;:?<=>]*)([ -/]*[@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_]|\(.)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** Same sequences as ANSI, but never across a line break or \r (collapseCR splits there first): strips a block of whole lines so that each line contains its parseAnsi(collapseCR()) text. */
export const ANSI_LINES = /\x1b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\x07\x1b\n\r]*(?:\x07|\x1b\\)?|[@-Z\\-_]|\(.)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

interface Sgr {
  fg: string;
  bg: string;
  b: boolean;
  d: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  inv: boolean;
}

function styleCode(st: Sgr): string {
  const flags = (st.b ? 'b' : '') + (st.d ? 'd' : '') + (st.i ? 'i' : '') + (st.u ? 'u' : '') + (st.s ? 's' : '');
  const fg = st.inv ? st.bg || 'inv' : st.fg;
  const bg = st.inv ? st.fg || 'inv' : st.bg;
  return fg || bg || flags ? `${fg};${bg};${flags}` : '';
}

function rgbHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}

function color256(n: number): string {
  if (n < 16) return String(n);
  if (n < 232) {
    n -= 16;
    const v = (x: number) => (x ? x * 40 + 55 : 0);
    return rgbHex(v(Math.floor(n / 36)), v(Math.floor(n / 6) % 6), v(n % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgbHex(g, g, g);
}

function applySgr(st: Sgr, params: string): void {
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10)));
  for (let k = 0; k < p.length; k++) {
    const c = p[k];
    if (c === 0) Object.assign(st, { fg: '', bg: '', b: false, d: false, i: false, u: false, s: false, inv: false });
    else if (c === 1) st.b = true;
    else if (c === 2) st.d = true;
    else if (c === 3) st.i = true;
    else if (c === 4) st.u = true;
    else if (c === 7) st.inv = true;
    else if (c === 9) st.s = true;
    else if (c === 22) st.b = st.d = false;
    else if (c === 23) st.i = false;
    else if (c === 24) st.u = false;
    else if (c === 27) st.inv = false;
    else if (c === 29) st.s = false;
    else if (c >= 30 && c <= 37) st.fg = String(c - 30);
    else if (c === 39) st.fg = '';
    else if (c >= 40 && c <= 47) st.bg = String(c - 40);
    else if (c === 49) st.bg = '';
    else if (c >= 90 && c <= 97) st.fg = String(c - 90 + 8);
    else if (c >= 100 && c <= 107) st.bg = String(c - 100 + 8);
    else if (c === 38 || c === 48) {
      let col = '';
      if (p[k + 1] === 5) {
        col = color256(p[k + 2] ?? 0);
        k += 2;
      } else if (p[k + 1] === 2) {
        col = rgbHex(p[k + 2] ?? 0, p[k + 3] ?? 0, p[k + 4] ?? 0);
        k += 4;
      }
      if (c === 38) st.fg = col;
      else st.bg = col;
    }
  }
}

/** Strip escape sequences; return the plain text and SGR style runs. */
export function parseAnsi(s: string): { text: string; spans?: [number, number, string][] } {
  if (s.indexOf('\x1b') < 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return { text: s };
  const st: Sgr = { fg: '', bg: '', b: false, d: false, i: false, u: false, s: false, inv: false };
  let text = '';
  const spans: [number, number, string][] = [];
  let cur = '';
  let curStart = 0;
  let last = 0;
  ANSI.lastIndex = 0;
  const flush = () => {
    if (cur && text.length > curStart) spans.push([curStart, text.length, cur]);
  };
  for (let m: RegExpExecArray | null; (m = ANSI.exec(s)); ) {
    text += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[2] === 'm') {
      flush();
      applySgr(st, m[1] ?? '');
      cur = styleCode(st);
      curStart = text.length;
    } else if (m[0] === '\t') text += '\t';
  }
  text += s.slice(last);
  flush();
  return { text, spans: spans.length ? spans : undefined };
}

/** Full analysis of one log line for display. */
export function analyzeLine(raw: string, inherited: number): { text: string; log: LogLine } {
  const { text, spans } = parseAnsi(collapseCR(raw));
  const [lv, ls, le] = detectLevel(text);
  const ts = detectTimestamp(text);
  const log: LogLine = { lv: lv || inherited };
  if (spans) log.sp = spans;
  if (ts) log.ts = ts;
  if (lv && ls >= 0) log.lt = [ls, le];
  return { text, log };
}

/** Fast level detection on raw bytes of a line (indexing pass). `prev` is the previous line's level. */
export function levelOfRaw(head: string, prev: number): number {
  let s = head;
  if (s.indexOf('\x1b') >= 0 || s.indexOf('\r') >= 0) s = parseAnsi(collapseCR(s)).text;
  const [lv] = detectLevel(s);
  if (lv) return lv;
  // continuation lines (stack frames, wrapped messages) inherit the level of the record they belong to
  const c = s.charCodeAt(0);
  if ((c === 32 || c === 9) && s.trim() !== '' && !detectTimestamp(s)) return prev;
  return LV_NONE;
}
