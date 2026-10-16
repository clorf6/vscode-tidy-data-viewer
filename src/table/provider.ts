// Custom editor for delimited text, JSON Lines, logs and Parquet (viewType dataViewer.table).
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { prefersText, reopenAsText, TABLE_VIEW } from '../shared/openAs';
import { webviewHtml, webviewOptions } from '../shared/webview';
import { DocHost, TableDocument } from './document';
import type { Change } from './models';
import type { ToHost } from './protocol';
import { webviewStrings } from './strings';

export class TableEditorProvider implements vscode.CustomEditorProvider<TableDocument>, DocHost {
  private readonly emitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<TableDocument>>();
  readonly onDidChangeCustomDocument = this.emitter.event;
  readonly panels = new Map<TableDocument, vscode.WebviewPanel>();
  active?: TableDocument;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  config<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration('dataViewer').get<T>(key, def);
  }

  fireEdit(doc: TableDocument, change: Change): void {
    this.emitter.fire({ document: doc, label: change.label, undo: change.undo, redo: change.redo });
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<TableDocument> {
    const doc = new TableDocument(uri, this, openContext.backupId);
    doc.strings = webviewStrings;
    // reopened as text right away (resolveCustomEditor): don't index a possibly huge file for nothing
    if (!prefersText(uri)) void doc.load();
    return doc;
  }

  async resolveCustomEditor(doc: TableDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (prefersText(doc.uri)) return reopenAsText(doc.uri, panel);
    if (!doc.loadStarted) void doc.load();
    const ext = this.ctx.extensionUri;
    panel.webview.options = webviewOptions(ext);
    panel.webview.html = webviewHtml(panel.webview, ext, { script: 'table.js', styles: ['base.css', 'table.css'], title: doc.name });
    this.panels.set(doc, panel);
    this.active = doc;
    doc.attach((m) => void panel.webview.postMessage(m));
    const subs = [
      panel.webview.onDidReceiveMessage((m: ToHost) =>
        doc.handle(m).catch((e) => {
          void panel.webview.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }),
      ),
      panel.onDidChangeViewState(() => {
        doc.setVisible(panel.visible);
        if (panel.active) this.active = doc;
      }),
    ];
    panel.onDidDispose(() => {
      subs.forEach((s) => s.dispose());
      doc.detach();
      doc.setVisible(false);
      this.panels.delete(doc);
      if (this.active === doc) this.active = undefined;
    });
  }

  saveCustomDocument(doc: TableDocument): Promise<void> {
    return doc.save();
  }

  saveCustomDocumentAs(doc: TableDocument, destination: vscode.Uri): Promise<void> {
    return doc.saveAs(destination);
  }

  revertCustomDocument(doc: TableDocument): Promise<void> {
    return doc.revert();
  }

  backupCustomDocument(doc: TableDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    return doc.backup(context.destination);
  }

  /** The table editor the commands act on. */
  current(uri?: unknown): TableDocument | undefined {
    if (uri instanceof vscode.Uri) for (const d of this.panels.keys()) if (d.uri.toString() === uri.toString()) return d;
    const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === TABLE_VIEW) for (const d of this.panels.keys()) if (d.uri.toString() === input.uri.toString()) return d;
    return this.active;
  }

  post(doc: TableDocument, msg: unknown): void {
    void this.panels.get(doc)?.webview.postMessage(msg);
  }

  async goToRow(doc: TableDocument): Promise<void> {
    const n = doc.viewCount();
    const v = await vscode.window.showInputBox({
      prompt: l10n.t('Go to row (1–{0})', n.toLocaleString()),
      validateInput: (s) => {
        const x = Number(s.replace(/[,\s_]/g, ''));
        return Number.isInteger(x) && x >= 1 && x <= n ? undefined : l10n.t('Enter a row number between 1 and {0}', n.toLocaleString());
      },
    });
    if (v) this.post(doc, { type: 'goTo', row: Number(v.replace(/[,\s_]/g, '')) - 1 });
  }

  async exportAs(doc: TableDocument): Promise<void> {
    const formats = [
      { label: 'CSV', ext: 'csv', id: 'csv' as const },
      { label: 'TSV', ext: 'tsv', id: 'tsv' as const },
      { label: 'JSON', ext: 'json', id: 'json' as const },
      { label: l10n.t('JSON Lines'), ext: 'jsonl', id: 'jsonl' as const },
      { label: 'Markdown', ext: 'md', id: 'markdown' as const },
    ];
    const pick = await vscode.window.showQuickPick(formats, { placeHolder: l10n.t('Export the current view (filtered, sorted, visible columns) as') });
    if (!pick) return;
    const base = doc.name.replace(/\.[^.]+$/, '');
    const dir = doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : undefined;
    const defaultUri = dir ? vscode.Uri.file(path.join(dir, `${base}.view.${pick.ext}`)) : undefined;
    const target = await vscode.window.showSaveDialog({ defaultUri, filters: { [pick.label]: [pick.ext] } });
    if (!target) return;
    const n = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('Exporting…'), cancellable: false }, async (p) => {
      let last = 0;
      return doc.exportTo(target, pick.id, (f) => {
        const pct = Math.round(f * 100);
        if (pct > last) {
          p.report({ increment: pct - last });
          last = pct;
        }
      });
    });
    void vscode.window.showInformationMessage(l10n.t('Exported {0} rows to {1}', n.toLocaleString(), path.basename(target.path)));
  }
}

export function registerTableEditor(ctx: vscode.ExtensionContext): TableEditorProvider {
  const provider = new TableEditorProvider(ctx);
  const withDoc = (fn: (d: TableDocument) => unknown) => (uri?: unknown) => {
    const d = provider.current(uri);
    if (d) return fn(d);
    void vscode.window.showInformationMessage(l10n.t('No table is active.'));
    return undefined;
  };
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(TABLE_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: false }),
    vscode.commands.registerCommand(
      'dataViewer.table.find',
      withDoc((d) => provider.post(d, { type: 'focusSearch' })),
    ),
    vscode.commands.registerCommand(
      'dataViewer.table.goToRow',
      withDoc((d) => provider.goToRow(d)),
    ),
    vscode.commands.registerCommand(
      'dataViewer.table.exportAs',
      withDoc((d) => provider.exportAs(d)),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dataViewer.table') && !e.affectsConfiguration('dataViewer.log')) return;
      for (const d of provider.panels.keys()) d.sendInit();
    }),
  );
  return provider;
}
