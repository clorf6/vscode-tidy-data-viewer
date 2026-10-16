// Minimal stand-in for the `vscode` module so views can be exercised headlessly (see test/harness.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */

export class EventEmitter<T> {
  private ls = new Set<(v: T) => void>();
  event = (l: (v: T) => void) => {
    this.ls.add(l);
    return { dispose: () => this.ls.delete(l) };
  };
  fire(v: T) {
    for (const l of [...this.ls]) l(v);
  }
  dispose() {
    this.ls.clear();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum TextEditorRevealType {
  InCenterIfOutsideViewport = 2,
}
export enum ProgressLocation {
  Window = 10,
  Notification = 15,
}
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}
export enum ConfigurationTarget {
  Global = 1,
}

export class TreeItem {
  id?: string;
  description?: string;
  iconPath?: any;
  contextValue?: string;
  tooltip?: any;
  command?: any;
  constructor(
    public label: any,
    public collapsibleState: TreeItemCollapsibleState = 0,
  ) {}
}
export class ThemeIcon {
  constructor(
    public id: string,
    public color?: ThemeColor,
  ) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class MarkdownString {
  value = '';
  isTrusted: any;
  constructor(v = '', public supportThemeIcons = false) {
    this.value = v;
  }
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
  appendCodeblock(s: string, lang = '') {
    this.value += '\n```' + lang + '\n' + s + '\n```\n';
    return this;
  }
  appendText(s: string) {
    this.value += s;
    return this;
  }
}
export class Range {
  /** set when constructed from two Positions (tree module) */
  start: any;
  end: any;
  constructor(...a: any[]) {
    if (a.length === 2) [this.start, this.end] = a;
  }
}
export class Uri {
  constructor(
    public scheme: string,
    public path: string,
    public query = '',
  ) {}
  get fsPath() {
    return this.path;
  }
  static file(p: string) {
    return new Uri('file', p);
  }
  static parse(s: string) {
    return new Uri(s.split(':')[0], s);
  }
  static from(c: { scheme: string; path: string; query?: string }) {
    return new Uri(c.scheme, c.path, c.query);
  }
  static joinPath(u: Uri, ...p: string[]) {
    return new Uri(u.scheme, [u.path, ...p].join('/'));
  }
  toString() {
    return `${this.scheme}:${this.path}`;
  }
  with() {
    return this;
  }
}

export const registry = {
  views: new Map<string, any>(),
  commands: new Map<string, (...a: any[]) => any>(),
  context: new Map<string, unknown>(),
  statusItems: [] as any[],
  messages: [] as string[],
  terminals: [] as any[],
  config: {} as Record<string, unknown>,
  configEmitter: new EventEmitter<any>(),
  focusEmitter: new EventEmitter<any>(),
  /** Webview view providers by view id (see test/overview-host.ts). */
  webviewViews: new Map<string, { provider: any; options: any }>(),
  /** Every executeCommand id, in order. */
  executed: [] as string[],
};

function format(msg: string, args: any[]) {
  return msg.replace(/\{(\d+)\}/g, (_, i) => String(args[+i]));
}

export const l10n = { t: (msg: string, ...args: any[]) => format(msg, args) };

const visEmitters = new Map<string, EventEmitter<any>>();

export const window = {
  state: { focused: true },
  onDidChangeWindowState: registry.focusEmitter.event,
  visibleTextEditors: [] as any[],
  activeTerminal: undefined,
  activeTextEditor: undefined,
  createTreeView(id: string, opts: any) {
    const em = new EventEmitter<any>();
    visEmitters.set(id, em);
    const view = { id, provider: opts.treeDataProvider, visible: false, message: undefined, description: undefined, badge: undefined, onDidChangeVisibility: em.event, dispose() {} };
    registry.views.set(id, view);
    return view;
  },
  createStatusBarItem() {
    const it = { text: '', tooltip: undefined as any, backgroundColor: undefined, shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
    registry.statusItems.push(it);
    return it;
  },
  showInformationMessage: async (m: string) => (registry.messages.push('info: ' + m), undefined),
  showWarningMessage: async (m: string) => (registry.messages.push('warn: ' + m), undefined),
  showErrorMessage: async (m: string) => (registry.messages.push('error: ' + m), undefined),
  setStatusBarMessage: (m: string) => (registry.messages.push('status: ' + m), { dispose() {} }),
  withProgress: async (_o: any, fn: any) => fn({ report() {} }, { isCancellationRequested: false }),
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  createTerminal: (o: any) => {
    const t = { ...o, show() {}, sendText(s: string) { (t as any).sent = s; } };
    registry.terminals.push(t);
    return t;
  },
  createWebviewPanel: () => {
    throw new Error('no webviews in harness');
  },
  registerWebviewPanelSerializer: () => ({ dispose() {} }),
  showTextDocument: async () => ({ revealRange() {} }),
  registerWebviewViewProvider: (id: string, provider: any, options: any) => {
    registry.webviewViews.set(id, { provider, options });
    return { dispose: () => registry.webviewViews.delete(id) };
  },
  createQuickPick: () => {
    throw new Error('no quick picks in harness');
  },
};

export function setVisible(id: string, v: boolean) {
  const view = registry.views.get(id);
  view.visible = v;
  visEmitters.get(id)!.fire(v);
}

export const commands = {
  registerCommand(id: string, fn: any) {
    if (registry.commands.has(id)) throw new Error('duplicate command ' + id);
    registry.commands.set(id, fn);
    return { dispose: () => registry.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: any[]) {
    if (id === 'setContext') return void registry.context.set(args[0], args[1]);
    registry.executed.push(id);
    const fn = registry.commands.get(id);
    if (fn) return fn(...args);
  },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: () => ({ get: (k: string, d: unknown) => (k in registry.config ? registry.config[k] : d) }),
  onDidChangeConfiguration: registry.configEmitter.event,
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  onDidChangeTextDocument: () => ({ dispose() {} }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  openTextDocument: async () => ({ lineCount: 1 }),
};

export const env = {
  remoteName: 'ssh-remote',
  language: 'zh-cn',
  clipboard: { text: '', writeText: async (s: string) => void (env.clipboard.text = s) },
  asExternalUri: async (u: Uri) => u,
  openExternal: async () => true,
};

// ---- custom editors (table module); additive ------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-var-requires */
export enum ViewColumn {
  Active = -1,
  One = 1,
}
export class TabInputCustom {
  constructor(
    public uri: Uri,
    public viewType: string,
  ) {}
}
export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {}
}
export const customEditors = new Map<string, { provider: any; options: any }>();
Object.assign(window, {
  tabGroups: { activeTabGroup: { activeTab: undefined as any }, all: [] as any[] },
  registerCustomEditorProvider(viewType: string, provider: any, options: any) {
    customEditors.set(viewType, { provider, options });
    return { dispose: () => customEditors.delete(viewType) };
  },
  showSaveDialog: async () => (registry as any).saveDialogResult,
});
Object.assign(env.clipboard, { readText: async () => env.clipboard.text });
{
  const nodeFs = require('fs') as typeof import('fs');
  Object.assign(workspace, {
    fs: {
      readFile: async (u: Uri) => new Uint8Array(await nodeFs.promises.readFile(u.fsPath)),
      writeFile: async (u: Uri, b: Uint8Array) => nodeFs.promises.writeFile(u.fsPath, b),
      delete: async (u: Uri) => nodeFs.promises.rm(u.fsPath, { force: true }),
      stat: async (u: Uri) => nodeFs.promises.stat(u.fsPath),
    },
  });
}
/** A fake WebviewPanel: messages posted by the extension are collected in `sent`; `receive` plays the webview. */
export function createTestPanel() {
  const listeners: ((m: any) => void)[] = [];
  const viewState: ((e: any) => void)[] = [];
  const disposeLs: (() => void)[] = [];
  const panel = {
    sent: [] as any[],
    visible: true,
    active: true,
    viewColumn: 1,
    webview: {
      html: '',
      options: {} as any,
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: Uri) => u,
      postMessage: async (m: any) => (panel.sent.push(m), true),
      onDidReceiveMessage: (l: (m: any) => void) => (listeners.push(l), { dispose() {} }),
    },
    onDidChangeViewState: (l: (e: any) => void) => (viewState.push(l), { dispose() {} }),
    onDidDispose: (l: () => void) => (disposeLs.push(l), { dispose() {} }),
    dispose: () => disposeLs.forEach((l) => l()),
    /** Deliver a message from the "webview" and wait for the extension to handle it. */
    receive: async (m: any) => {
      for (const l of listeners) await l(m);
    },
  };
  return panel;
}

// ---- text documents and workspace edits (tree module); additive -----------------------------------------------
export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}
export class WorkspaceEdit {
  readonly edits: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string) {
    this.edits.push({ uri, range, text });
  }
}
Object.assign(ViewColumn, { Beside: -2 });
const textChange = new EventEmitter<any>();
/** Documents applyEdit can change, by uri string. */
export const textDocuments = new Map<string, TestTextDocument>();
/** Every applied WorkspaceEdit as offset edits, in order. */
export const appliedEdits: { uri: string; edits: { start: number; end: number; text: string }[] }[] = [];

/** A TextDocument stand-in backed by a string; edits through workspace.applyEdit fire onDidChangeTextDocument. */
export class TestTextDocument {
  version = 1;
  readonly uri: Uri;
  constructor(
    private text: string,
    path: string,
    public languageId = 'json',
  ) {
    this.uri = Uri.file(path);
    textDocuments.set(this.uri.toString(), this);
  }
  get fileName() {
    return this.uri.path;
  }
  getText() {
    return this.text;
  }
  positionAt(offset: number) {
    const o = Math.max(0, Math.min(offset, this.text.length));
    const before = this.text.slice(0, o);
    const line = before.split('\n').length - 1;
    return new Position(line, o - (before.lastIndexOf('\n') + 1));
  }
  offsetAt(p: Position) {
    let off = 0;
    for (let l = 0; l < p.line; l++) {
      const nl = this.text.indexOf('\n', off);
      if (nl < 0) return this.text.length;
      off = nl + 1;
    }
    return Math.min(this.text.length, off + p.character);
  }
  /** Replace the whole text as if edited elsewhere (e.g. a side-by-side text editor). */
  setText(text: string) {
    const old = this.text;
    this.text = text;
    this.version++;
    textChange.fire({ document: this, contentChanges: [{ rangeOffset: 0, rangeLength: old.length, text }] });
  }
  applyOffsets(edits: { start: number; end: number; text: string }[]) {
    for (const e of [...edits].sort((a, b) => b.start - a.start)) this.text = this.text.slice(0, e.start) + e.text + this.text.slice(e.end);
    this.version++;
    textChange.fire({ document: this, contentChanges: edits.map((e) => ({ rangeOffset: e.start, rangeLength: e.end - e.start, text: e.text })) });
  }
}
Object.assign(workspace, {
  onDidChangeTextDocument: textChange.event,
  applyEdit: async (we: WorkspaceEdit) => {
    const byDoc = new Map<string, { start: number; end: number; text: string }[]>();
    for (const e of we.edits) {
      const doc = textDocuments.get(e.uri.toString());
      if (!doc) return false;
      const list = byDoc.get(e.uri.toString()) ?? [];
      list.push({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.text });
      byDoc.set(e.uri.toString(), list);
    }
    for (const [uri, edits] of byDoc) {
      appliedEdits.push({ uri, edits });
      textDocuments.get(uri)!.applyOffsets(edits);
    }
    return true;
  },
});

// ---- markdown editor; additive --------------------------------------------------------------------------------
/** Fire to simulate a text editor scrolling: { textEditor: { document }, visibleRanges: [{ start: { line } }] }. */
export const visibleRangesEmitter = new EventEmitter<any>();
Object.assign(window, { onDidChangeTextEditorVisibleRanges: visibleRangesEmitter.event });
/** Installed extensions (vscode.extensions.all); tests may push stand-ins. */
export const extensions = { all: [] as any[], getExtension: (id: string) => extensions.all.find((e) => e.id === id) };
