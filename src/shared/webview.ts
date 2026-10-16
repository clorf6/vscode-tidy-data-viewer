import * as vscode from 'vscode';

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export interface HtmlOptions {
  /** Bundle under dist/, e.g. 'table.js'. */
  script: string;
  /** Stylesheets under media/, e.g. ['base.css', 'table.css']. */
  styles: string[];
  title: string;
}

/**
 * Standard page shell for every Data Viewer webview: strict CSP (nonce-only scripts, no inline styles — dynamic styles
 * go through CSSOM), local resources only, and the UI language on <html lang> so the webview can pick its strings.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, o: HtmlOptions): string {
  const n = nonce();
  const css = o.styles.map((s) => `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', s))}">`).join('\n');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', o.script));
  const csp = [`default-src 'none'`, `img-src ${webview.cspSource} data:`, `style-src ${webview.cspSource}`, `font-src ${webview.cspSource}`, `script-src 'nonce-${n}'`].join('; ');
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${css}
<title>${o.title.replace(/[<>&"]/g, '')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')] };
}
