import { alertIcons } from './icons';
import { uiStrings } from './settings';
import type { Gate, Md, StateCore, Token } from './util';

// GitHub-style alerts:  > [!NOTE]  /  > [!TIP]  /  > [!IMPORTANT]  /  > [!WARNING]  /  > [!CAUTION]
// The marker must open the first line of the quote. Text after it on the same line becomes a custom title
// (Obsidian-style `> [!tip] Faster builds`); without one the localised kind name is used.
const MARKER = /^\[!(note|tip|important|warning|caution)\](?:[ \t]+(.*))?$/i;

export function installAlerts(md: Md, on: Gate): void {
  md.core.ruler.after('block', 'dv_alerts', (state) => {
    if (on()) rewrite(state);
  });
  md.renderer.rules.dv_alert_title_open = (tokens, idx) => `<p class="markdown-alert-title" dir="auto">${alertIcons[tokens[idx].meta.kind] ?? ''}`;
  md.renderer.rules.dv_alert_title_close = () => '</p>\n';
}

function rewrite(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'blockquote_open' || open.meta?.dvAlert) continue;
    if (/\bmarkdown-alert\b/.test(open.attrGet('class') ?? '')) continue; // already handled by another plugin
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (para?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
    const nl = inline.content.indexOf('\n');
    const first = (nl < 0 ? inline.content : inline.content.slice(0, nl)).trim();
    const m = MARKER.exec(first);
    if (!m) continue;
    const close = matchingClose(tokens, i);
    if (!close) continue;

    const kind = m[1].toLowerCase();
    open.tag = close.tag = 'div';
    open.attrJoin('class', `markdown-alert markdown-alert-${kind}`);
    open.meta = { ...(open.meta ?? {}), dvAlert: kind };

    const rest = nl < 0 ? '' : inline.content.slice(nl + 1);
    if (rest.trim()) {
      // The marker line is gone: the paragraph now starts one source line later (keeps scroll sync exact).
      inline.content = rest;
      if (para.map) para.map = [para.map[0] + 1, para.map[1]];
      if (inline.map) inline.map = [inline.map[0] + 1, inline.map[1]];
    } else {
      tokens.splice(i + 1, 3); // the paragraph held only the marker
    }

    const level = open.level + 1;
    const tOpen = new state.Token('dv_alert_title_open', 'p', 1);
    tOpen.meta = { kind };
    tOpen.block = true;
    tOpen.level = level;
    const tText = new state.Token('inline', '', 0);
    tText.content = m[2]?.trim() || uiStrings().alert[kind];
    tText.children = [];
    tText.level = level + 1;
    const tClose = new state.Token('dv_alert_title_close', 'p', -1);
    tClose.block = true;
    tClose.level = level;
    tokens.splice(i + 1, 0, tOpen, tText, tClose);
  }
}

function matchingClose(tokens: Token[], start: number): Token | undefined {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    if (tokens[j].type === 'blockquote_open') depth++;
    else if (tokens[j].type === 'blockquote_close' && --depth === 0) return tokens[j];
  }
  return undefined;
}
