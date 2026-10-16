import footnote from 'markdown-it-footnote';
import { uiStrings } from './settings';
import { esc, type Gate, type Md } from './util';

type AnyFn = (...args: never[]) => unknown;

function hasRule(ruler: unknown, name: string): boolean {
  return !!(ruler as { __rules__?: { name: string }[] }).__rules__?.some((r) => r.name === name);
}

/**
 * markdown-it-footnote, with every parse rule gated on the setting (so turning the enhancement off really turns
 * footnotes off) and a few presentation tweaks. Skipped when another footnote plugin is already installed.
 */
export function installFootnotes(md: Md, on: Gate): void {
  if (hasRule(md.block.ruler, 'footnote_def')) return;
  const gate = <F extends AnyFn>(fn: F): F => ((...a: Parameters<F>) => (on() ? fn(...a) : false)) as unknown as F;
  // The plugin only touches md.{block,inline,core}.ruler, md.renderer, md.helpers and md.utils; hand it a view of
  // `md` whose rulers wrap each rule it registers.
  const shim = Object.create(md) as Md;
  const wrap = (ruler: { before?: AnyFn; after?: AnyFn }, method: 'before' | 'after') => ({
    [method]: (anchor: string, name: string, fn: AnyFn, opts?: unknown) => (ruler[method] as unknown as (...a: unknown[]) => void).call(ruler, anchor, name, gate(fn), opts),
  });
  Object.defineProperties(shim, {
    block: { value: { ruler: wrap(md.block.ruler as never, 'before') } },
    inline: { value: { ruler: wrap(md.inline.ruler as never, 'after') } },
    core: { value: { ruler: wrap(md.core.ruler as never, 'after') } },
  });
  footnote(shim);

  // [1] → 1 (the superscript is enough), a titled section instead of a bare <hr>.
  md.renderer.rules.footnote_caption = (tokens, idx) => {
    const meta = tokens[idx].meta as { id: number; subId?: number };
    return String(meta.id + 1) + (meta.subId ? `:${meta.subId}` : '');
  };
  md.renderer.rules.footnote_block_open = () => {
    const t = esc(uiStrings().footnotes);
    return `<section class="footnotes" aria-label="${t}">\n<div class="dv-footnotes-title">${t}</div>\n<ol class="footnotes-list">\n`;
  };

  // Definitions are moved to the end of the document but keep their source lines; left alone they would make the
  // preview's line→position mapping non-monotonic (scrolling into the notes would jump the editor back up). Without a
  // data-line the notes simply belong to the end of the document.
  md.core.ruler.after('footnote_tail', 'dv_footnote_lines', (state) => {
    if (!on()) return;
    let inside = false;
    for (const t of state.tokens) {
      if (t.type === 'footnote_block_open') inside = true;
      else if (t.type === 'footnote_block_close') inside = false;
      else if (inside) {
        t.map = null;
        for (const c of t.children ?? []) c.map = null;
      }
    }
  });
}
