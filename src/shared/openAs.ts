import * as vscode from 'vscode';
import { l10n } from 'vscode';

export const TABLE_VIEW = 'dataViewer.table';
export const TREE_VIEW = 'dataViewer.tree';
export const MARKDOWN_VIEW = 'dataViewer.markdown';

const TABLE_RE = /\.(csv|tsv|tab|psv|jsonl|ndjson|log|parquet)$|^(nohup|slurm-.*)\.out$/i;
const TREE_RE = /\.(json|geojson|ya?ml|toml|ini|env|xml)$|^\.env(\..*)?$/i;
const MARKDOWN_RE = /\.(md|markdown|mdown|mkd)$/i;

/** Which Data Viewer editor handles this file, if any. */
export function viewTypeFor(uri: vscode.Uri): string | undefined {
  const name = uri.path.split('/').pop() ?? '';
  if (TABLE_RE.test(name)) return TABLE_VIEW;
  if (TREE_RE.test(name)) return TREE_VIEW;
  if (MARKDOWN_RE.test(name)) return MARKDOWN_VIEW;
  return undefined;
}

/** Minimal glob → RegExp (`**`, `*`, `?`, `{a,b}`), matched against the full path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re.replace(/^\.\*/, '.*')}$`);
}

/** Files that should open as plain text even though a Data Viewer editor is the default for their extension. */
export function prefersText(uri: vscode.Uri): boolean {
  if (uri.scheme === 'vscode-userdata' || uri.scheme === 'vscode-settings') return true;
  const patterns = vscode.workspace.getConfiguration('dataViewer').get<string[]>('openAsTextPatterns', []);
  return patterns.some((p) => globToRegExp(p).test(uri.path));
}

/**
 * Reopen `uri` in the plain text editor in place of a Data Viewer editor. Call from resolveCustom(Text)Editor when
 * prefersText() says so, or from the "Open as Text" button.
 */
export async function reopenAsText(uri: vscode.Uri, panel?: vscode.WebviewPanel): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { viewColumn: panel?.viewColumn ?? vscode.ViewColumn.Active, preview: false });
  panel?.dispose();
}

function activeCustomUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

export function registerSharedCommands(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('dataViewer.openAsText', async (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : activeCustomUri();
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
    vscode.commands.registerCommand('dataViewer.openInViewer', async (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const view = viewTypeFor(target);
      if (!view) return void vscode.window.showInformationMessage(l10n.t('Data Viewer does not handle this file type.'));
      await vscode.commands.executeCommand('vscode.openWith', target, view);
    }),
  );
}
