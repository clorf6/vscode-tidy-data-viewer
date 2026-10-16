import { listIcon } from './icons';
import { uiStrings } from './settings';
import { attrsWith, esc, headingLabel, headingText, previous, type Gate, type Md, type Token } from './util';

// Table of contents:  [[toc]]  ·  [toc]  ·  [[_TOC_]]  on a line of its own.
//
// Heading ids are assigned by VS Code's preview while it renders each heading_open (its wrapper runs before ours, as it
// is installed after every plugin), so the TOC is rendered as a placeholder and filled in once the whole document has
// been rendered, with exactly the ids the preview produced. Elsewhere (tests, other hosts) headings without an id get
// one from a copy of the preview's slug algorithm.

const MARKER = /^(?:\[\[_?toc_?\]\]|\[toc\])$/i;
const KEY = '__dataViewerMd';
const NONCE = Math.random().toString(36).slice(2, 10);
const PLACEHOLDER = new RegExp(`<!--dv-toc-${NONCE}:(\\d+)-->`, 'g');

interface Heading {
  level: number;
  id: string;
  label: string;
}
interface RenderState {
  depth: number;
  headings: Heading[];
  tocs: { token: Token; before: number }[];
  slugs: Map<string, number>;
}

function renderState(env: Record<string, unknown>): RenderState {
  return (env[KEY] ??= { depth: 0, headings: [], tocs: [], slugs: new Map() }) as RenderState;
}

// --- the preview's slugifier (markdown-language-features: github-slugger's character class, then whitespace → '-') -----
// It keeps letters, marks, decimal digits, connector punctuation, space and '-', and strips everything else (emoji
// included). Expressed with Unicode properties this matches the preview exactly for every character assigned up to
// Unicode 13 (the preview's table), BMP and astral alike — see test/markdown.test.ts.
const STRIP = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu;

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(STRIP, '').replace(/\s/g, '-');
}

/** Same de-duplication as the preview: the 2nd "Intro" is intro-1, the 3rd intro-2 (suffixed ids are not reserved). */
export function uniqueSlug(seen: Map<string, number>, text: string): string {
  const base = slugify(text);
  const n = seen.get(base);
  if (n === undefined) {
    seen.set(base, 0);
    return base;
  }
  seen.set(base, n + 1);
  return slugify(`${base}-${n + 1}`);
}

export function installToc(md: Md, on: Gate): void {
  md.core.ruler.after('dv_tables', 'dv_toc', (state) => {
    if (!on()) return;
    const tokens = state.tokens;
    const refs = (state.env as { references?: Record<string, unknown> } | undefined)?.references;
    for (let i = 0; i + 2 < tokens.length; i++) {
      const [p, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]];
      if (p.type !== 'paragraph_open' || inline.type !== 'inline' || close.type !== 'paragraph_close') continue;
      const text = inline.content.trim();
      if (!MARKER.test(text) || (text.toLowerCase() === '[toc]' && refs?.TOC)) continue;
      const toc = new state.Token('dv_toc', 'nav', 0);
      toc.block = true;
      toc.map = p.map;
      toc.level = p.level;
      tokens.splice(i, 3, toc);
    }
  });

  md.renderer.rules.dv_toc = (tokens, idx, _options, env) => {
    const st = renderState(env ?? {});
    st.tocs.push({ token: tokens[idx], before: st.headings.length });
    return `<!--dv-toc-${NONCE}:${st.tocs.length - 1}-->\n`;
  };

  const open = previous(md, 'heading_open');
  const close = previous(md, 'heading_close');
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    if (!on() || !env) return open(tokens, idx, options, env, self);
    const st = renderState(env);
    const tok = tokens[idx];
    let id = tok.attrGet('id');
    if (!id) {
      id = uniqueSlug(st.slugs, headingText(tokens[idx + 1]));
      tok.attrSet('id', id);
    }
    st.headings.push({ level: Number(tok.tag.slice(1)) || 1, id, label: headingLabel(tokens[idx + 1]) });
    return open(tokens, idx, options, env, self);
  };
  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const html = close(tokens, idx, options, env, self);
    const id = on() ? findOpen(tokens, idx)?.attrGet('id') : null;
    if (!id) return html;
    const label = esc(uiStrings().linkToSection);
    return `<a class="dv-anchor" href="#${esc(encodeURIComponent(id))}" title="${label}" aria-label="${label}" tabindex="-1"></a>` + html;
  };

  // Fill the placeholders once every heading has been rendered (outermost render call only).
  const renderer = md.renderer;
  const render = renderer.render;
  renderer.render = function (tokens, options, env) {
    const e = (env ?? {}) as Record<string, unknown>;
    const fresh = !e[KEY] || (e[KEY] as RenderState).depth === 0;
    if (fresh) delete e[KEY];
    const st = renderState(e);
    st.depth++;
    let html: string;
    try {
      html = render.call(this, tokens, options, e);
    } finally {
      st.depth--;
    }
    if (st.depth > 0 || !st.tocs.length) return html;
    return html.replace(PLACEHOLDER, (_, n: string) => tocHtml(st, Number(n)));
  };
}

function findOpen(tokens: Token[], closeIdx: number): Token | undefined {
  for (let j = closeIdx - 1; j >= 0; j--) if (tokens[j].type === 'heading_open') return tokens[j];
  return undefined;
}

function tocHtml(st: RenderState, n: number): string {
  const toc = st.tocs[n];
  let items = st.headings;
  // A single H1 above the marker is the document title: list what is below it instead of nesting everything under it.
  const h1 = items.filter((h) => h.level === 1);
  if (h1.length === 1 && items.indexOf(h1[0]) < toc.before) items = items.filter((h) => h !== h1[0]);
  if (!items.length) return '';
  const top = Math.min(...items.map((h) => h.level));
  items = items.filter((h) => h.level <= top + 2);

  let list = '';
  const stack: number[] = [];
  for (const h of items) {
    if (!stack.length || h.level > stack[stack.length - 1]) {
      list += '<ul>';
      stack.push(h.level);
    } else {
      list += '</li>';
      while (stack.length > 1 && h.level < stack[stack.length - 1]) {
        stack.pop();
        list += '</ul></li>';
      }
    }
    list += `<li><a href="#${esc(encodeURIComponent(h.id))}">${h.label || esc(h.id)}</a>`;
  }
  while (stack.pop() !== undefined) list += '</li></ul>';
  const title = esc(uiStrings().contents);
  const cls = items.length > 14 ? 'dv-toc dv-toc-cols' : 'dv-toc'; // long lists flow into two columns on wide screens
  return `<nav${attrsWith(toc.token, cls)} aria-label="${title}"><div class="dv-toc-title">${listIcon}<span>${title}</span></div>${list}</nav>\n`;
}
