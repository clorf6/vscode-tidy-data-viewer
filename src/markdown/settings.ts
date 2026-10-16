import * as vscode from 'vscode';

export interface MarkdownSettings {
  /** dataViewer.markdown.enhance — master switch for everything this module adds to the preview. */
  enhance: boolean;
  /** Show YAML front matter as a properties card ('card') or hide it like the stock preview ('hide'). */
  frontMatter: 'card' | 'hide';
}

let cached: MarkdownSettings | undefined;
let listening = false;

function read(): MarkdownSettings {
  const dv = vscode.workspace.getConfiguration('dataViewer');
  const enhance = dv.get<boolean>('markdown.enhance', true) !== false;
  // `markdown.previewFrontMatter` was a built-in setting in older VS Code releases; honour it when users still have it.
  const legacy = vscode.workspace.getConfiguration('markdown').get<string>('previewFrontMatter');
  const fm = dv.get<string>('markdown.frontMatter', legacy === 'hide' ? 'hide' : 'card');
  return { enhance, frontMatter: fm === 'hide' ? 'hide' : 'card' };
}

/** Current settings, cached; the cache is refreshed (and open previews re-rendered) when they change. */
export function settings(): MarkdownSettings {
  if (!cached) {
    cached = read();
    listen();
  }
  return cached;
}

function listen() {
  if (listening) return;
  listening = true;
  try {
    vscode.workspace.onDidChangeConfiguration((e) => {
      const affects = typeof e?.affectsConfiguration === 'function' ? e.affectsConfiguration('dataViewer.markdown') || e.affectsConfiguration('markdown.previewFrontMatter') : true;
      if (!affects) return;
      cached = read();
      // The preview caches tokens per document version and does not watch our settings: clear its cache and re-render.
      Promise.resolve(vscode.commands.executeCommand('markdown.preview.refresh')).catch(() => undefined);
    });
  } catch {
    /* no configuration events in this host — settings are read once */
  }
}

/** Localised UI strings rendered into the preview (computed once; VS Code's display language cannot change at runtime). */
export interface Strings {
  alert: Record<string, string>;
  contents: string;
  footnotes: string;
  properties: string;
  copy: string;
  copyCode: string;
  copied: string;
  linkToSection: string;
}

let strings: Strings | undefined;

export function uiStrings(): Strings {
  return (strings ??= {
    alert: {
      note: vscode.l10n.t('Note'),
      tip: vscode.l10n.t('Tip'),
      important: vscode.l10n.t('Important'),
      warning: vscode.l10n.t('Warning'),
      caution: vscode.l10n.t('Caution'),
    },
    contents: vscode.l10n.t('Contents'),
    footnotes: vscode.l10n.t('Footnotes'),
    properties: vscode.l10n.t('Properties'),
    copy: vscode.l10n.t('Copy'),
    copyCode: vscode.l10n.t('Copy code'),
    copied: vscode.l10n.t('Copied'),
    linkToSection: vscode.l10n.t('Link to this section'),
  });
}
