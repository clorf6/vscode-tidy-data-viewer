// Data Viewer's Markdown editor (custom text editor `dataViewer.markdown`): VS Code's own Markdown engine renders the
// document (so it looks exactly like the enhanced built-in preview), and because we own the webview, the rendering is
// editable in place — task checkboxes, any block, table cells — through WorkspaceEdits on the TextDocument, so dirty
// state, undo/redo, save, hot exit and a text editor beside all keep working as usual.
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { MARKDOWN_VIEW, prefersText, reopenAsText } from '../shared/openAs';
import { nonce } from '../shared/webview';
import type { ToHost, ToView, UiState } from './protocol';
import { classifyRef, rewriteMedia, sanitizeHtml, sliceLines, splitLines, toggleTaskLine } from './source';

const UI_KEY = 'dataViewer.markdown.ui';
const MD_FILE = /\.(md|markdown|mdown|mkd|mkdn|mdwn)$/i;
const RENDER_DELAY = 120;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirOf = (uri: vscode.Uri) => vscode.Uri.joinPath(uri, '..');

/** Strings for the webview UI (localised here: webviews have no l10n API). */
function webviewStrings() {
  return {
    outline: l10n.t('Outline'),
    noHeadings: l10n.t('No headings'),
    width: l10n.t('Toggle reading width'),
    editSource: l10n.t('Edit Source'),
    openAsText: l10n.t('Open as Text'),
    showPreview: l10n.t('Open in Built-in Preview'),
    more: l10n.t('More actions'),
    editBlock: l10n.t('Edit block (double-click or Enter)'),
    editing: l10n.t('Editing lines {0}–{1}'),
    editingLine: l10n.t('Editing line {0}'),
    save: l10n.t('Save'),
    cancel: l10n.t('Cancel'),
    saveHint: l10n.t('{0}+Enter to save · Esc to cancel'),
    saving: l10n.t('Saving…'),
    addRow: l10n.t('Add row below'),
    addColumn: l10n.t('Add column'),
    tableSource: l10n.t('Edit table source'),
    cellHint: l10n.t('Enter to save · Tab next cell · Esc to cancel'),
    top: l10n.t('Back to top'),
    close: l10n.t('Close (Esc)'),
    empty: l10n.t('This document is empty. Double-click here to start writing.'),
    selChars: l10n.t('{0} characters selected'),
    selLines: l10n.t('{0} characters, {1} lines selected'),
  };
}
export type EditorStrings = ReturnType<typeof webviewStrings>;

/** markdown.api.render with the TextDocument (relative links, token cache); falls back to its text. */
async function renderWithVsCode(doc: vscode.TextDocument): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const arg of [doc, doc.getText()]) {
      try {
        const html = await vscode.commands.executeCommand<unknown>('markdown.api.render', arg);
        if (typeof html === 'string') return html;
      } catch {
        /* try the next form / attempt */
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // the Markdown extension may still be activating
  }
  throw new Error(l10n.t("VS Code's built-in Markdown extension is not available (is it disabled?)."));
}

/** Every `markdown.previewStyles` contribution, in the order the built-in preview loads them (ours included). */
function previewStyleSheets(): { sheets: vscode.Uri[]; roots: vscode.Uri[] } {
  const sheets: vscode.Uri[] = [];
  const roots: vscode.Uri[] = [];
  for (const ext of vscode.extensions?.all ?? []) {
    const list = (ext.packageJSON as { contributes?: Record<string, unknown> } | undefined)?.contributes?.['markdown.previewStyles'];
    if (!Array.isArray(list) || !list.length) continue;
    roots.push(ext.extensionUri);
    for (const p of list) if (typeof p === 'string') sheets.push(vscode.Uri.joinPath(ext.extensionUri, p));
  }
  return { sheets, roots };
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  readonly sessions = new Set<MarkdownSession>();
  active?: MarkdownSession;
  /** `other.md#section` links: the fragment to reveal once that document's editor has rendered. */
  readonly pendingFragments = new Map<string, string>();

  constructor(readonly ctx: vscode.ExtensionContext) {}

  get ui(): UiState {
    return { outline: false, wide: false, ...(this.ctx.globalState?.get<Partial<UiState>>(UI_KEY) ?? {}) };
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (prefersText(document.uri)) return reopenAsText(document.uri, panel);
    const session = new MarkdownSession(this, document, panel);
    this.sessions.add(session);
    this.active = session;
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      if (this.active === session) this.active = undefined;
      session.dispose();
    });
  }

  current(uri?: unknown): MarkdownSession | undefined {
    if (uri instanceof vscode.Uri) for (const s of this.sessions) if (s.document.uri.toString() === uri.toString()) return s;
    return this.active;
  }
}

export class MarkdownSession {
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rendering = false;
  private again = false;
  private ready = false;
  private stale = true;
  private revealedAt = 0; // we scrolled a text editor (ignore its visible-range echo)
  private followedAt = 0; // we scrolled the webview after a text editor (ignore its revealLine echo)
  /** Top source line currently shown in the webview. */
  line = 0;
  /** Messages posted to the webview (kept for tests). */
  readonly posted: ToView[] = [];

  constructor(
    private readonly provider: MarkdownEditorProvider,
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
  ) {
    const w = panel.webview;
    w.options = { enableScripts: true, localResourceRoots: this.roots() };
    w.html = this.html();
    this.subs.push(
      w.onDidReceiveMessage((m: ToHost) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.document && e.contentChanges.length) this.schedule(RENDER_DELAY);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (['markdown.preview.fontFamily', 'markdown.preview.fontSize', 'markdown.preview.lineHeight', 'editor.wordWrap'].some((k) => e.affectsConfiguration(k)))
          void this.post({ type: 'style', vars: this.fontVars(), classes: this.bodyClasses() });
        if (e.affectsConfiguration('markdown.styles')) w.html = this.html();
        // after our settings listener has cleared the engine's token cache (markdown.preview.refresh)
        else if (e.affectsConfiguration('markdown') || e.affectsConfiguration('dataViewer.markdown')) this.schedule(60);
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.followEditor(e)),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.provider.active = this;
        // Hidden webviews are discarded (retainContextWhenHidden: false); the reloaded page says 'ready' again.
        if (!panel.visible) this.ready = false;
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
  }

  // ---- webview page -------------------------------------------------------------------------------------------

  private roots(): vscode.Uri[] {
    const ext = this.provider.ctx.extensionUri;
    const roots = [vscode.Uri.joinPath(ext, 'dist'), vscode.Uri.joinPath(ext, 'media'), ...previewStyleSheets().roots];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    roots.push(dirOf(this.document.uri));
    return roots;
  }

  private config(section: string) {
    return vscode.workspace.getConfiguration(section, this.document.uri);
  }

  /** The preview's CSS variables for markdown.preview.fontFamily / fontSize / lineHeight. */
  fontVars(): string {
    const c = this.config('markdown');
    const family = c.get<string>('preview.fontFamily');
    const size = Math.max(8, Number(c.get<number>('preview.fontSize', NaN)));
    const height = Math.max(0.6, Number(c.get<number>('preview.lineHeight', NaN)));
    return [family ? `--markdown-font-family: ${family};` : '', isNaN(size) ? '' : `--markdown-font-size: ${size}px;`, isNaN(height) ? '' : `--markdown-line-height: ${height};`].join(' ');
  }

  bodyClasses(): string {
    const wrap = vscode.workspace.getConfiguration('editor', this.document).get<string>('wordWrap', 'off');
    return wrap && wrap !== 'off' ? 'wordWrap' : '';
  }

  private userStyles(): vscode.Uri[] {
    const list = this.config('markdown').get<string[]>('styles', []) ?? [];
    const folder = vscode.workspace.getWorkspaceFolder?.(this.document.uri);
    return list.flatMap((s) => {
      if (/^https?:/i.test(s)) return [vscode.Uri.parse(s)];
      if (/^file:/i.test(s)) return [vscode.Uri.parse(s)];
      if (s.startsWith('/')) return [vscode.Uri.file(s)];
      return [vscode.Uri.joinPath(folder?.uri ?? dirOf(this.document.uri), s)];
    });
  }

  private html(): string {
    const w = this.panel.webview;
    const ext = this.provider.ctx.extensionUri;
    const n = nonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} https: data:`,
      `media-src ${w.cspSource} https: data:`,
      `style-src ${w.cspSource} 'unsafe-inline' https:`, // KaTeX positions glyphs with inline styles
      `font-src ${w.cspSource} https: data:`,
      `script-src 'nonce-${n}'`,
    ].join('; ');
    const href = (u: vscode.Uri) => (/^https?:/i.test(u.scheme) ? u.toString() : w.asWebviewUri(u).toString());
    const sheets = [...previewStyleSheets().sheets, ...this.userStyles(), vscode.Uri.joinPath(ext, 'media', 'md-editor.css')];
    const name = path.posix.basename(this.document.uri.path);
    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language)}" style="${esc(this.fontVars())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${sheets.map((u) => `<link rel="stylesheet" type="text/css" href="${esc(href(u))}">`).join('\n')}
<meta id="dv-md-data" data-strings="${esc(JSON.stringify(webviewStrings()))}" data-ui="${esc(JSON.stringify(this.provider.ui))}" data-title="${esc(name)}">
<title>${esc(name)}</title>
</head>
<body class="vscode-body dv-md-editor ${this.bodyClasses()}">
<div class="markdown-body" dir="auto"></div>
<script nonce="${n}" src="${w.asWebviewUri(vscode.Uri.joinPath(ext, 'dist', 'md-editor.js'))}"></script>
</body>
</html>`;
  }

  private async post(m: ToView): Promise<void> {
    this.posted.push(m);
    if (this.posted.length > 50) this.posted.splice(0, this.posted.length - 50);
    await this.panel.webview.postMessage(m);
  }

  // ---- rendering ----------------------------------------------------------------------------------------------

  schedule(delay: number): void {
    this.stale = true;
    if (!this.ready || !this.panel.visible) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), delay);
  }

  async render(): Promise<void> {
    if (this.rendering) {
      this.again = true;
      return;
    }
    this.rendering = true;
    this.stale = false;
    try {
      const version = this.document.version;
      const source = this.document.getText();
      let html: string;
      try {
        html = this.postProcess(await renderWithVsCode(this.document));
      } catch (e) {
        html = `<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">${esc(e instanceof Error ? e.message : String(e))}</p></div><pre><code>${esc(source)}</code></pre>`;
      }
      const msg: ToView = { type: 'render', html, source, version };
      const fragment = this.provider.pendingFragments.get(this.document.uri.toString());
      if (fragment) {
        this.provider.pendingFragments.delete(this.document.uri.toString());
        msg.fragment = fragment;
      }
      await this.post(msg);
    } finally {
      this.rendering = false;
      if (this.again) {
        this.again = false;
        void this.render();
      }
    }
  }

  /** The engine's HTML, made safe and pointed at webview resources; task checkboxes become clickable. */
  postProcess(html: string): string {
    let out = sanitizeHtml(html);
    out = out.replace(/(<input type="checkbox" class="task-list-item-checkbox") disabled/g, '$1');
    out = rewriteMedia(out, (src) => this.resolveMedia(src));
    return out;
  }

  /** A document-relative (or workspace-root-relative, or file:) reference → webview URI; null keeps it. */
  resolveMedia(src: string): string | null {
    const target = this.resolveRef(src);
    if (!target) return null;
    return this.panel.webview.asWebviewUri(target.uri).toString() + target.suffix;
  }

  private resolveRef(ref: string): { uri: vscode.Uri; suffix: string } | undefined {
    const c = classifyRef(ref);
    if (c.kind === 'keep') return undefined;
    if (c.kind === 'file') {
      const u = vscode.Uri.parse(c.uri);
      return { uri: u, suffix: '' };
    }
    const p = c.path;
    if (p.startsWith('/')) {
      // The engine already joins root-relative paths onto the workspace folder when it renders a document.
      const folders = vscode.workspace.workspaceFolders ?? [];
      const resolved = folders.some((f) => p === f.uri.path || p.startsWith(f.uri.path.replace(/\/$/, '') + '/'));
      const folder = vscode.workspace.getWorkspaceFolder?.(this.document.uri);
      return { uri: resolved || !folder ? this.document.uri.with({ path: p, query: '', fragment: '' }) : vscode.Uri.joinPath(folder.uri, p), suffix: c.suffix };
    }
    return { uri: vscode.Uri.joinPath(dirOf(this.document.uri), p), suffix: c.suffix };
  }

  // ---- messages -----------------------------------------------------------------------------------------------

  async onMessage(m: ToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.schedule(0);
        return;
      case 'editLines':
        return this.editLines(m.start, m.end, m.original, m.text);
      case 'toggleTask':
        return this.toggleTask(m.line, m.checked);
      case 'openLink':
        return this.openLink(m.href);
      case 'revealLine':
        this.line = m.line;
        return this.revealInEditors(m.line);
      case 'command':
        if (m.id === 'editSource') return this.editSource();
        if (m.id === 'openAsText') return void vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
        if (m.id === 'showPreview') return void vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'vscode.markdown.preview.editor');
        return;
      case 'ui':
        await this.provider.ctx.globalState?.update(UI_KEY, m.ui);
        for (const s of this.provider.sessions) if (s !== this) void s.post({ type: 'ui', ui: m.ui });
        return;
    }
  }

  private refuse(message: string): Promise<void> {
    void vscode.window.showWarningMessage(message);
    this.schedule(0);
    return this.post({ type: 'refused', message });
  }

  /** Lines [start, end) as a range: up to the start of line `end`, or to the end of the text for the last block. */
  private lineRange(lines: string[], start: number, end: number): vscode.Range {
    const pos = (l: number, c: number) => new vscode.Position(l, c);
    if (end < lines.length) return new vscode.Range(pos(start, 0), pos(end, 0));
    const last = lines.length - 1;
    return new vscode.Range(pos(start, 0), pos(last, lines[last].length));
  }

  async editLines(start: number, end: number, original: string, text: string): Promise<void> {
    const doc = this.document;
    const all = doc.getText();
    const lines = splitLines(all);
    const current = sliceLines(lines, start, end);
    if (current === undefined || current !== original) {
      await vscode.env.clipboard.writeText(text);
      return this.refuse(l10n.t('The document changed while you were editing, so nothing was saved. Your text has been copied to the clipboard.'));
    }
    if (current === text) return this.schedule(0);
    const eol = all.includes('\r\n') ? '\r\n' : '\n';
    const body = splitLines(text).join(eol);
    const replacement = end < lines.length ? (text === '' ? '' : body + eol) : body;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, this.lineRange(lines, start, end), replacement);
    if (!(await vscode.workspace.applyEdit(edit))) return this.refuse(l10n.t('The document could not be edited (it may be read-only).'));
    this.schedule(0);
  }

  async toggleTask(line: number, checked: boolean): Promise<void> {
    const doc = this.document;
    const text = splitLines(doc.getText())[line] ?? '';
    const next = toggleTaskLine(text, checked);
    if (next === undefined) return this.refuse(l10n.t('That task is no longer on line {0}; the view has been refreshed.', line + 1));
    if (next === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, text.length)), next);
    if (!(await vscode.workspace.applyEdit(edit))) return this.refuse(l10n.t('The document could not be edited (it may be read-only).'));
    this.schedule(0);
  }

  async openLink(href: string): Promise<void> {
    if (!href || href.startsWith('#')) return;
    if (/^command:/i.test(href)) return; // never run commands from document content
    const target = this.resolveRef(href);
    if (!target) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(href));
      } catch {
        /* malformed */
      }
      return;
    }
    const hash = target.suffix.includes('#') ? target.suffix.slice(target.suffix.indexOf('#') + 1) : '';
    const uri = target.uri.with({ fragment: '', query: '' });
    if (uri.toString() === this.document.uri.toString()) {
      if (hash) await this.post({ type: 'reveal', fragment: decodeURIComponent(hash) });
      return;
    }
    const lineMatch = /^L(\d+)/i.exec(hash);
    if (MD_FILE.test(uri.path) && !lineMatch) {
      if (hash) this.provider.pendingFragments.set(uri.toString(), decodeURIComponent(hash));
      await vscode.commands.executeCommand('vscode.openWith', uri, MARKDOWN_VIEW);
      return;
    }
    if (lineMatch) {
      const l = Math.max(0, Number(lineMatch[1]) - 1);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(new vscode.Position(l, 0), new vscode.Position(l, 0)), preview: false });
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  // ---- source editor beside & scroll sync ---------------------------------------------------------------------

  async editSource(): Promise<void> {
    const existing = vscode.window.visibleTextEditors.find((e) => e.document === this.document);
    const line = Math.max(0, Math.floor(this.line));
    const at = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0));
    const editor = await vscode.window.showTextDocument(this.document, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside, preview: false, selection: at });
    this.revealedAt = Date.now();
    editor?.revealRange?.(at, vscode.TextEditorRevealType.AtTop);
  }

  private followEditor(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (e.textEditor.document !== this.document || !this.panel.visible || !this.ready) return;
    if (!this.config('markdown').get<boolean>('preview.scrollPreviewWithEditor', true)) return;
    if (Date.now() - this.revealedAt < 400) return; // the echo of our own revealRange
    const r = e.visibleRanges[0];
    if (!r) return;
    this.followedAt = Date.now();
    this.line = r.start.line;
    void this.post({ type: 'scrollTo', line: r.start.line });
  }

  private revealInEditors(line: number): void {
    if (!this.config('markdown').get<boolean>('preview.scrollEditorWithPreview', true)) return;
    if (Date.now() - this.followedAt < 400) return; // the webview is following the editor, not leading
    const l = Math.max(0, Math.min(Math.floor(line), (this.document.lineCount ?? Infinity) - 1));
    const at = new vscode.Range(new vscode.Position(l, 0), new vscode.Position(l, 0));
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document !== this.document) continue;
      this.revealedAt = Date.now();
      ed.revealRange(at, vscode.TextEditorRevealType.AtTop);
    }
  }
}

export function registerMarkdownEditor(ctx: vscode.ExtensionContext): MarkdownEditorProvider {
  const provider = new MarkdownEditorProvider(ctx);
  const target = (uri: unknown): vscode.Uri | undefined => (uri instanceof vscode.Uri ? uri : provider.active?.document.uri ?? vscode.window.activeTextEditor?.document.uri);
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MARKDOWN_VIEW, provider, {
      webviewOptions: { enableFindWidget: true, retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('dataViewer.markdown.editSource', async (uri?: unknown) => {
      const session = provider.current(uri);
      if (session) return session.editSource();
      const u = target(uri);
      if (u) await vscode.window.showTextDocument(u, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }),
    vscode.commands.registerCommand('dataViewer.markdown.showPreview', async (uri?: unknown) => {
      const u = target(uri);
      if (u) await vscode.commands.executeCommand('vscode.openWith', u, 'vscode.markdown.preview.editor');
    }),
  );
  return provider;
}
