import type MarkdownIt from 'markdown-it';

export type Md = MarkdownIt;
export type Token = MarkdownIt.Token;
export type StateCore = MarkdownIt.StateCore;
export type StateBlock = MarkdownIt.StateBlock;
export type RenderRule = MarkdownIt.Renderer.RenderRule;

/** Is the enhancement layer on right now? Checked at parse time (token rewrites) and render time (wrappers). */
export type Gate = () => boolean;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Render a token's attributes (data-line, code-line class, dir… added by the preview's source-map rule) plus an extra
 * class, without mutating the token: tokens are cached by the preview and re-rendered on every update.
 */
export function attrsWith(token: Token, cls: string): string {
  let out = '';
  let hasClass = false;
  for (const [k, v] of token.attrs ?? []) {
    if (k === 'class') {
      hasClass = true;
      out += ` class="${esc(cls + ' ' + v)}"`;
    } else out += ` ${esc(k)}="${esc(v)}"`;
  }
  return hasClass ? out : ` class="${esc(cls)}"` + out;
}

/** Wrap an existing render rule; `fallback` renders the token the default way when no rule was set before. */
export function previous(md: Md, type: string): RenderRule {
  const prev = md.renderer.rules[type];
  return prev ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
}

/** Plain text of a heading the way VS Code's preview computes it for slugs (text, emoji, inline code; recursive). */
export function headingText(token: Token | undefined): string {
  if (!token) return '';
  if (token.children) return token.children.map(headingText).join('');
  switch (token.type) {
    case 'text':
    case 'emoji':
    case 'code_inline':
      return token.content;
    default:
      return '';
  }
}

/** Small inline label for a heading (used by the TOC): text and inline code only — no links, images or notes. */
export function headingLabel(token: Token | undefined): string {
  if (!token?.children) return esc(token?.content ?? '');
  let out = '';
  const walk = (ts: Token[]) => {
    for (const t of ts) {
      if (t.type === 'text' || t.type === 'emoji') out += esc(t.content);
      else if (t.type === 'code_inline') out += `<code>${esc(t.content)}</code>`;
      else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
      else if (t.type === 'image') continue;
      else if (t.children) walk(t.children);
    }
  };
  walk(token.children);
  return out.trim();
}
