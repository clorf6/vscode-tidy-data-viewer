// Tree editor for JSON / YAML / TOML / INI / .env / XML (viewType dataViewer.tree), a CustomTextEditorProvider so
// VS Code keeps owning the TextDocument (dirty state, save, undo/redo, hot exit, side-by-side text editors).
import * as vscode from 'vscode';
import { prefersText, reopenAsText, TREE_VIEW } from '../shared/openAs';
import { webviewHtml, webviewOptions } from '../shared/webview';
import { TreeSession } from './session';

export class TreeEditorProvider implements vscode.CustomTextEditorProvider {
  active: TreeSession | undefined;
  readonly sessions = new Set<TreeSession>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (prefersText(document.uri)) {
      await reopenAsText(document.uri, panel);
      return;
    }
    const uri = this.ctx.extensionUri;
    panel.webview.options = webviewOptions(uri);
    const name = document.uri.path.split('/').pop() ?? 'Data Viewer';
    panel.webview.html = webviewHtml(panel.webview, uri, { script: 'tree.js', styles: ['base.css', 'tree.css'], title: name });
    const session = new TreeSession(document, panel, {
      setActive: (s) => {
        if (s) this.active = s;
        else if (this.active === session && !panel.active) this.active = undefined;
      },
    });
    this.sessions.add(session);
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      if (this.active === session) this.active = undefined;
    });
  }
}

export function registerTreeEditor(ctx: vscode.ExtensionContext): TreeEditorProvider {
  const provider = new TreeEditorProvider(ctx);
  const run = (name: 'format' | 'minify' | 'sortKeys') => async () => {
    const s = provider.active ?? [...provider.sessions].find((x) => x.panel.active);
    if (s) await s.action(name);
  };
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(TREE_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: true }),
    vscode.commands.registerCommand('dataViewer.tree.format', run('format')),
    vscode.commands.registerCommand('dataViewer.tree.minify', run('minify')),
    vscode.commands.registerCommand('dataViewer.tree.sortKeys', run('sortKeys')),
    vscode.commands.registerCommand('dataViewer.tree.find', () => (provider.active ?? [...provider.sessions].find((x) => x.panel.active))?.focusSearch()),
  );
  return provider;
}
