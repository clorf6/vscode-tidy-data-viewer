import { tagIcon } from './icons';
import { settings, uiStrings } from './settings';
import { attrsWith, esc, previous, type Gate, type Md, type StateBlock } from './util';

// YAML front matter at the very top of the document → a compact "properties" card.
//
// VS Code's preview installs its own `front_matter` block rule (after every plugin) that hides the block. Ours runs
// first and produces the same token type, so the rest of the pipeline is unchanged; when the enhancement is off we
// step aside and the stock rule hides it as before. Unlike the stock rule we require a closing fence, so a document
// that merely starts with a horizontal rule is not swallowed whole.

export function installFrontMatter(md: Md, on: Gate): void {
  md.block.ruler.before('table', 'dv_front_matter', (state, startLine, endLine, silent) => frontMatterRule(state, startLine, endLine, silent, on), {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  const fallback = previous(md, 'front_matter');
  md.renderer.rules.front_matter = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    if (!on() || settings().frontMatter === 'hide') return tok.hidden ? '' : fallback(tokens, idx, options, env, self);
    return card(md, tok.meta as string, attrsWith(tok, 'dv-front-matter'));
  };
}

function frontMatterRule(state: StateBlock, startLine: number, endLine: number, silent: boolean, on: Gate): boolean {
  if (startLine !== 0 || state.blkIndent !== 0 || state.bMarks[0] + state.tShift[0] !== 0 || !on()) return false;
  const line = (n: number) => state.src.slice(state.bMarks[n], state.eMarks[n]);
  if (line(0).trimEnd() !== '---') return false;
  let end = 1;
  for (; end < endLine; end++) {
    const l = line(end).trimEnd();
    if (l === '---' || l === '...') break;
  }
  if (end >= endLine) {
    // Never closed: just a thematic break. (The stock rule would hide the entire document.)
    if (silent) return false;
    const hr = state.push('hr', 'hr', 0);
    hr.map = [0, 1];
    hr.markup = '---';
    state.line = 1;
    return true;
  }
  if (silent) return true;
  const tok = state.push('front_matter', '', 0);
  tok.hidden = true;
  tok.block = true;
  tok.markup = '---';
  tok.map = [0, end + 1];
  tok.meta = state.src.slice(state.bMarks[1], end > 1 ? state.eMarks[end - 1] : state.bMarks[1]);
  state.line = end + 1;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// A forgiving reader for the shapes front matter actually uses (scalars, quoted strings, block scalars, flow and block
// lists). Anything it does not understand is shown verbatim, so it never fails.

export type FmValue = { kind: 'text'; text: string } | { kind: 'list'; items: string[] } | { kind: 'raw'; text: string };
export interface FmEntry {
  key: string;
  value: FmValue;
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:][^:#]*?|-[^\s:][^:#]*?)\s*:(?:[ \t]+(.*?))?\s*$/;

export function parseFrontMatter(src: string): FmEntry[] | undefined {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: FmEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = KEY_LINE.exec(line);
    if (!m) return undefined; // not a plain mapping at the top level: show it raw
    const key = unquote(m[1]);
    const inline = stripComment(m[2] ?? '');
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s/.test(lines[i + 1]) || (!inline && /^-(\s|$)/.test(lines[i + 1])))) block.push(lines[++i]);
    while (block.length && !block[block.length - 1].trim()) block.pop();
    out.push({ key, value: value(inline, block) });
  }
  return out;
}

function value(inline: string, block: string[]): FmValue {
  const body = dedent(block);
  if (/^[|>][+-]?\d*$/.test(inline)) {
    const text = inline[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    return { kind: 'text', text: text.trim() };
  }
  if (inline) {
    if (/^\[.*\]$/.test(inline)) return { kind: 'list', items: splitFlow(inline.slice(1, -1)).map(unquote).filter(Boolean) };
    if (/^\{.*\}$/.test(inline) || /^[&*!]/.test(inline)) return { kind: 'raw', text: [inline, ...body].join('\n') };
    const text = [unquote(inline), ...body.map((l) => l.trim())].join(' ').trim(); // plain multi-line scalars fold
    return { kind: 'text', text };
  }
  if (!body.length) return { kind: 'text', text: '' };
  const items = body.filter((l) => l.trim());
  if (items.every((l) => /^-(\s|$)/.test(l))) {
    const vals = items.map((l) => stripComment(l.slice(1).trim()));
    if (vals.every((v) => !/^[[{|>]/.test(v) && !KEY_LINE.test(v))) return { kind: 'list', items: vals.map(unquote) };
  }
  return { kind: 'raw', text: body.join('\n') };
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n));
}

function stripComment(s: string): string {
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(s);
  if (quoted) return quoted[0];
  return s.replace(/\s+#.*$/, '').trim();
}

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\/nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c);
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  let depth = 0;
  for (const c of s) {
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

function card(md: Md, src: string, attrs: string): string {
  const entries = parseFrontMatter(src);
  const head = `<div class="dv-fm-head">${tagIcon}<span>${esc(uiStrings().properties)}</span></div>`;
  if (!entries?.length) {
    if (!src.trim()) return '';
    return `<div${attrs}>${head}<pre class="dv-fm-raw"><code>${esc(src)}</code></pre></div>\n`;
  }
  const rows = entries
    .map(({ key, value: v }) => {
      let dd: string;
      if (v.kind === 'list') dd = v.items.length ? v.items.map((x) => `<span class="dv-chip">${esc(x)}</span>`).join('') : '<span class="dv-fm-empty">[ ]</span>';
      else if (v.kind === 'raw') dd = `<code class="dv-fm-code">${esc(v.text)}</code>`;
      else dd = scalar(md, v.text);
      return `<dt>${esc(key)}</dt><dd class="dv-fm-${v.kind}">${dd}</dd>`;
    })
    .join('');
  return `<div${attrs}>${head}<dl>${rows}</dl></div>\n`;
}

function scalar(md: Md, text: string): string {
  if (!text || text === '~' || text === 'null') return '<span class="dv-fm-empty">—</span>';
  if (/^https?:\/\/\S+$/.test(text)) {
    const href = md.normalizeLink(text);
    if (md.validateLink(href)) return `<a href="${esc(href)}">${esc(text)}</a>`;
  }
  if (/^(?:true|false)$/i.test(text)) return `<span class="dv-fm-bool">${esc(text)}</span>`;
  return esc(text).replace(/\n/g, '<br>');
}
