// Runs inside VS Code's built-in Markdown preview (contributed as markdown.previewScripts). The preview owns the page:
// it renders `.markdown-body`, diffs it on every edit (morphdom) and then fires `vscode.markdown.updateContent`.
// Everything here is therefore either event delegation (copy buttons, image zoom — nothing to re-attach) or idempotent
// work re-run after each update (table sizing). Nothing is added to `.markdown-body` itself, so scroll sync, link and
// checkbox handling stay the preview's own. Our own UI (lightbox, back-to-top) lives directly under <body>.
import { createBackToTop, createTableLayout, defaultStrings, installCopyAndZoom } from './md/features';

(() => {
  const w = window as Window & { __dataViewerMdPreview?: boolean };
  if (w.__dataViewerMdPreview) return;
  w.__dataViewerMdPreview = true;

  const T = defaultStrings();
  installCopyAndZoom(T);
  const top = createBackToTop(T.top);
  const tables = createTableLayout();
  window.addEventListener('vscode.markdown.updateContent', () => {
    tables.now(); // synchronously, before the browser paints the diffed content
    top.update();
  });

  function start() {
    if (!top.el.isConnected) document.body.appendChild(top.el);
    // The preview inserts its content on DOMContentLoaded, and our async script may run before or after that; it also
    // swaps the whole `.markdown-body` when another document is shown. Watch <body>'s direct children only.
    new MutationObserver(tables.queue).observe(document.body, { childList: true });
    tables.queue();
    top.update();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
