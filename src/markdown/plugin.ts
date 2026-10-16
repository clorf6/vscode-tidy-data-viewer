import type MarkdownIt from 'markdown-it';
import { installAlerts } from './alerts';
import { installCodeBlocks, installFigures, installLateBlockRanges, installTables, installTaskLists } from './blocks';
import { installFootnotes } from './footnotes';
import { installFrontMatter } from './frontMatter';
import { settings } from './settings';
import { installToc } from './toc';

const INSTALLED = Symbol.for('dataViewer.markdown');

/**
 * Enhancements for VS Code's built-in Markdown preview (returned from activate() as `extendMarkdownIt`; the preview
 * passes its own markdown-it instance). Every feature is gated on `dataViewer.markdown.enhance`, at parse time for
 * token rewrites and at render time for wrappers, so turning the setting off yields the stock output.
 *
 * Scroll sync: the preview's `source_map_data_attribute` core rule runs after all plugins and stamps data-line on
 * every block token with a `map`. Rewrites here keep (or deliberately adjust) those maps, and wrapper elements are
 * added as markup around the original tokens, never instead of them.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
  const tagged = md as MarkdownIt & { [INSTALLED]?: boolean };
  if (tagged[INSTALLED]) return md;
  tagged[INSTALLED] = true;

  const on = () => settings().enhance;
  installFrontMatter(md, on);
  installAlerts(md, on); //    core: after 'block'
  installTaskLists(md, on); // core: after 'dv_alerts'
  installTables(md, on); //    core: after 'dv_tasks'
  installToc(md, on); //       core: after 'dv_tables'; also heading ids/anchors and the render wrapper
  installFigures(md, on); //   core: after 'inline'
  installCodeBlocks(md, on);
  installFootnotes(md, on);
  installLateBlockRanges(md, on);
  // Where each block ends in the source (exclusive), next to the preview's data-line: lets our Markdown editor map a
  // rendered block back to exactly its lines. Pushed before the preview's own source-map rule, attribute-only, inert
  // in the stock preview — and emitted even when the enhancements are off, so editing keeps working.
  md.core.ruler.push('dv_line_end', (state) => {
    for (const t of state.tokens) if (t.map && t.type !== 'inline') t.attrSet('data-line-end', String(t.map[1]));
  });
  return md;
}
