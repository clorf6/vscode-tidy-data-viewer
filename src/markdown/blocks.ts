import { uiStrings } from './settings';
import { esc, previous, type Gate, type Md, type RenderRule, type StateCore, type Token } from './util';

// ---------------------------------------------------------------------------------------------------------------
// Task lists:  - [ ] todo  /  - [x] done   →  disabled checkboxes (GitHub's class names, so user styles keep working).
// The stock preview has no task-list support, so there is nothing to double-process; another plugin that already
// rewrote the item leaves no `[ ]` behind for us.

const TASK = /^\[([ xX])\](?:[ \t]+|(?=\n)|$)/;

export function installTaskLists(md: Md, on: Gate): void {
  md.core.ruler.after('dv_alerts', 'dv_tasks', (state) => {
    if (on()) taskLists(state);
  });
  // The checkbox goes in front of the item's inline content once that has been parsed.
  md.core.ruler.after('inline', 'dv_task_boxes', (state) => {
    if (!on()) return;
    for (const t of state.tokens) {
      if (t.type !== 'inline' || t.meta?.dvTask === undefined || !t.children) continue;
      const box = new state.Token('dv_task', 'input', 0);
      box.meta = { checked: t.meta.dvTask, line: t.meta.dvTaskLine };
      t.children.unshift(box);
    }
  });
  // data-task-line: the source line holding the `[ ]` (our Markdown editor toggles it there; inert in the preview).
  md.renderer.rules.dv_task = (tokens, idx) => {
    const { checked, line } = (tokens[idx].meta ?? {}) as { checked?: boolean; line?: number };
    const at = typeof line === 'number' ? ` data-task-line="${line}"` : '';
    return `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? ' checked' : ''} aria-checked="${!!checked}"${at}>`;
  };
}

function taskLists(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const m = TASK.exec(inline.content);
    if (!m) continue;
    const item = tokens[i - 2];
    const checked = m[1] !== ' ';
    inline.content = inline.content.slice(m[0].length);
    item.attrJoin('class', checked ? 'task-list-item task-list-item-checked' : 'task-list-item');
    const list = parentList(tokens, i - 2);
    if (list && !/\bcontains-task-list\b/.test(list.attrGet('class') ?? '')) list.attrJoin('class', 'contains-task-list');
    inline.meta = { ...(inline.meta ?? {}), dvTask: checked, dvTaskLine: item.map?.[0] };
  }
}

function parentList(tokens: Token[], itemIdx: number): Token | undefined {
  const level = tokens[itemIdx].level - 1;
  for (let j = itemIdx - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.level === level && (t.type === 'bullet_list_open' || t.type === 'ordered_list_open')) return t;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Tables: a scroll container around every <table> (the table itself keeps its data-line); right-aligned tabular
// figures for columns that hold only numbers (unless the author chose an alignment); cells with long text are marked
// so that a table too wide for the window keeps short cells on one line and lets only prose wrap.

// 42 · -1.5 · 1,234,567.89 · 3.2e-5 · 45% · $12.50 · 12 ms · 3.5GB · 2.5x   (dates, ranges and words do not match)
const NUMBER = /^[+\-−±]?[$€£¥₹]?\s?(?:\d[\d,_ \u00a0\u202f]*)?(?:\.\d+)?(?:[eE][+-]?\d+)?\s?(?:%|‰|[a-zA-Zµ°]{1,3})?$/;
const MISSING = /^(?:|-|–|—|n\/?a|null|none|nan|\?)$/i;

function isNumeric(raw: string): boolean {
  const s = raw.replace(/[*_`~]/g, '').trim();
  return /\d/.test(s) && NUMBER.test(s);
}

export function installTables(md: Md, on: Gate): void {
  md.core.ruler.after('dv_tasks', 'dv_tables', (state) => {
    if (on()) analyzeTables(state.tokens);
  });
  const open = previous(md, 'table_open');
  const close = previous(md, 'table_close');
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => (on() ? '<div class="dv-table-wrap">\n' : '') + open(tokens, idx, options, env, self);
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => close(tokens, idx, options, env, self) + (on() ? '</div>\n' : '');
}

/** Rough display width: CJK and other wide characters count double. */
function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1;
  return n;
}
const LONG_CELL = 48;

function analyzeTables(tokens: Token[]) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'table_open') continue;
    // Collect cells per column: [cellOpenToken, inlineToken][] per row.
    const cols: { head?: Token; cells: { open: Token; text: string }[] }[] = [];
    let col = 0;
    let inBody = false;
    let j = i + 1;
    for (; j < tokens.length && tokens[j].type !== 'table_close'; j++) {
      const t = tokens[j];
      if (t.type === 'tbody_open') inBody = true;
      else if (t.type === 'tr_open') col = 0;
      else if (t.type === 'th_open' || t.type === 'td_open') {
        const c = (cols[col] ??= { cells: [] });
        if (!inBody && t.type === 'th_open') c.head = t;
        else c.cells.push({ open: t, text: tokens[j + 1]?.type === 'inline' ? tokens[j + 1].content : '' });
        const text = tokens[j + 1]?.type === 'inline' ? tokens[j + 1].content : '';
        if (text.length > LONG_CELL / 2 && displayWidth(text.replace(/\]\([^)]*\)|[*_`~]/g, '')) > LONG_CELL) t.attrJoin('class', 'dv-long');
        col++;
      }
    }
    for (const c of cols) {
      if (!c?.cells.length || (c.head?.attrGet('style') ?? '').includes('text-align')) continue;
      const values = c.cells.filter((x) => !MISSING.test(x.text.trim()));
      if (!values.length || !values.every((x) => isNumeric(x.text))) continue;
      c.head?.attrJoin('class', 'dv-num');
      for (const x of c.cells) if (!(x.open.attrGet('style') ?? '').includes('text-align')) x.open.attrJoin('class', 'dv-num');
    }
    i = j;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Paragraphs that hold nothing but an image (optionally linked) become centred figures.

export function installFigures(md: Md, on: Gate): void {
  md.core.ruler.after('inline', 'dv_figures', (state) => {
    if (!on()) return;
    const tokens = state.tokens;
    for (let i = 1; i < tokens.length - 1; i++) {
      const p = tokens[i - 1];
      const inline = tokens[i];
      if (p.type !== 'paragraph_open' || p.hidden || inline.type !== 'inline' || !inline.children) continue;
      const kids = inline.children.filter((t) => !(t.type === 'text' && !t.content.trim()) && t.type !== 'softbreak');
      const names = kids.map((t) => t.type).join(',');
      if (names === 'image' || names === 'link_open,image,link_close') p.attrJoin('class', 'dv-figure');
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Code blocks: a header bar with the language and a copy button, rendered here (not by the preview script) so it is
// part of the HTML the preview diffs on every keystroke — no flicker, nothing to re-decorate. The <pre><code>
// produced by the previous rule is untouched, so the code element keeps its data-line for scroll sync.

const LANG_NAMES: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', mts: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python', py3: 'Python', ipython: 'IPython', sh: 'Shell', shell: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish', console: 'Console', shellsession: 'Console',
  ps1: 'PowerShell', powershell: 'PowerShell', pwsh: 'PowerShell', bat: 'Batch', cmd: 'Batch', json: 'JSON', jsonc: 'JSONC', json5: 'JSON5', jsonl: 'JSON Lines',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less', md: 'Markdown', markdown: 'Markdown',
  sql: 'SQL', c: 'C', h: 'C', cpp: 'C++', 'c++': 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', cuda: 'CUDA', cu: 'CUDA', cs: 'C#', csharp: 'C#', 'c#': 'C#',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin', scala: 'Scala', groovy: 'Groovy', go: 'Go', golang: 'Go', rs: 'Rust', rust: 'Rust', rb: 'Ruby', ruby: 'Ruby',
  php: 'PHP', swift: 'Swift', r: 'R', lua: 'Lua', perl: 'Perl', pl: 'Perl', dart: 'Dart', julia: 'Julia', jl: 'Julia', matlab: 'MATLAB', hs: 'Haskell', haskell: 'Haskell',
  ex: 'Elixir', elixir: 'Elixir', erl: 'Erlang', clj: 'Clojure', fs: 'F#', fsharp: 'F#', ocaml: 'OCaml', zig: 'Zig', nim: 'Nim', asm: 'Assembly', nasm: 'Assembly',
  dockerfile: 'Dockerfile', docker: 'Dockerfile', makefile: 'Makefile', make: 'Makefile', cmake: 'CMake', nginx: 'Nginx', diff: 'Diff', patch: 'Diff',
  tex: 'TeX', latex: 'LaTeX', bibtex: 'BibTeX', graphql: 'GraphQL', proto: 'Protobuf', protobuf: 'Protobuf', csv: 'CSV', tsv: 'TSV', vue: 'Vue', svelte: 'Svelte',
  text: 'Text', txt: 'Text', plaintext: 'Text', log: 'Log', http: 'HTTP', regex: 'Regex', vim: 'Vim script', mermaid: 'Mermaid', sol: 'Solidity', solidity: 'Solidity',
};

/** Languages another plugin (mermaid, math…) may render as something other than code. */
const NOT_CODE = /^(?:mermaid|math|katex|latex-display|plantuml|dot|graphviz|chart|vega(?:-lite)?|abc|flowchart|sequence)$/i;

export function installCodeBlocks(md: Md, on: Gate): void {
  const fence = previous(md, 'fence');
  const block = previous(md, 'code_block');
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = fence(tokens, idx, options, env, self);
    if (!on()) return html;
    const lang = md.utils.unescapeAll(tokens[idx].info || '').trim().split(/\s+/)[0] ?? '';
    if (NOT_CODE.test(lang)) return html;
    return chrome(html, lang);
  };
  md.renderer.rules.code_block = (tokens, idx, options, env, self) => {
    const html = block(tokens, idx, options, env, self);
    return on() ? chrome(html, '') : html;
  };
}

function chrome(html: string, lang: string): string {
  if (!/^\s*<pre[\s>]/.test(html)) return html; // replaced by another plugin (diagram, math…): leave it alone
  const s = uiStrings();
  const name = lang ? LANG_NAMES[lang.toLowerCase()] ?? lang : '';
  const label = name ? `<span class="dv-code-lang">${esc(name)}</span>` : '';
  // Icons are CSS masks (see media/markdown.css) to keep the per-block markup small.
  const button = `<button type="button" class="dv-copy" title="${esc(s.copyCode)}" aria-label="${esc(s.copyCode)}" data-copied="${esc(s.copied)}"><span class="dv-copy-text">${esc(s.copy)}</span></button>`;
  return `<div class="dv-code${name ? '' : ' dv-code-plain'}"${lang ? ` data-lang="${esc(lang.toLowerCase())}"` : ''}><div class="dv-code-bar">${label}${button}</div>${html.trim()}</div>\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Math blocks (the built-in markdown-math extension) render without data-line, so neither scroll sync nor our editor
// can place them. Their rules are installed by another plugin, possibly after ours, so they are wrapped lazily at the
// first render.

const WRAPPED = Symbol.for('dataViewer.lineWrapped');

export function installLateBlockRanges(md: Md, on: Gate): void {
  const renderer = md.renderer;
  const render = renderer.render;
  renderer.render = function (tokens, options, env) {
    for (const type of ['math_block', 'math_block_eqno']) {
      const rule = renderer.rules[type] as (RenderRule & { [WRAPPED]?: boolean }) | undefined;
      if (!rule || rule[WRAPPED]) continue;
      const wrapped: RenderRule & { [WRAPPED]?: boolean } = (ts, idx, opts, e, self) => {
        const html = rule(ts, idx, opts, e, self);
        const map = ts[idx].map;
        if (!on() || !map) return html;
        return html.replace(/^(\s*<[a-zA-Z][\w-]*)([^>]*)>/, (_m, open: string, attrs: string) => {
          const cls = /\sclass="([^"]*)"/.exec(attrs);
          const rest = cls ? attrs.replace(cls[0], ` class="${cls[1]} code-line"`) : `${attrs} class="code-line"`;
          return `${open} data-line="${map[0]}" data-line-end="${map[1]}"${rest}>`;
        });
      };
      wrapped[WRAPPED] = true;
      renderer.rules[type] = wrapped;
    }
    return render.call(this, tokens, options, env);
  };
}
