// Messages between the Markdown editor's extension host side (src/markdown/editor.ts) and its webview
// (webview/md-editor.ts).

export interface UiState {
  outline: boolean;
  /** Full-width reading instead of the comfortable measure. */
  wide: boolean;
}

export type ToView =
  /** A fresh rendering: VS Code's own Markdown engine output, post-processed for the webview, plus the source it came from. */
  | { type: 'render'; html: string; source: string; version: number; scrollToLine?: number; fragment?: string }
  /** Scroll to a heading / footnote id (a `#fragment` link into this document). */
  | { type: 'reveal'; fragment: string }
  /** The text editor beside us scrolled: follow it. */
  | { type: 'scrollTo'; line: number }
  /** An edit we asked for was refused (stale range, read-only document…). */
  | { type: 'refused'; message: string }
  | { type: 'style'; vars: string; classes: string }
  | { type: 'ui'; ui: UiState };

export type ToHost =
  | { type: 'ready' }
  /** Replace lines [start, end) — which must still read `original` — with `text` (\n-separated, no final newline). */
  | { type: 'editLines'; start: number; end: number; original: string; text: string }
  | { type: 'toggleTask'; line: number; checked: boolean }
  | { type: 'openLink'; href: string }
  /** The webview scrolled to this (fractional) source line. */
  | { type: 'revealLine'; line: number }
  | { type: 'command'; id: 'editSource' | 'openAsText' | 'showPreview' }
  | { type: 'ui'; ui: UiState };
