// One open tree editor: owns the parse of its TextDocument, the visible-rows View, search, and turns webview
// requests into minimal WorkspaceEdits (VS Code then owns dirty state, save, undo/redo and hot exit).
import * as vscode from 'vscode';
import { Path, Store, TextEdit, detectEol } from './model';
import { EditError } from './json';
import { formatOf, parseDoc, Parsed } from './formats';
import { compileQuery, Searcher, View } from './view';
import { formatPath } from './paths';
import { toYaml } from './yaml';
import { toXml } from './xml';
import { hostMessage, hostStrings, webviewStrings } from './strings';
import { EditOp, ErrorInfo, Format, HostMsg, KeyKind, Kind, PathStyle, SearchQuery, Status, WebMsg, WebState } from './protocol';

const WINDOW = 400;
const MAX_ERRORS = 50;

export interface SessionHost {
  setActive(s: TreeSession | undefined): void;
}

export class TreeSession implements vscode.Disposable {
  readonly format: Format;
  private parsed?: Parsed;
  private shown?: Parsed;
  private good?: Parsed;
  private view?: View;
  private docVersion = -1;
  private bytes = 0;
  private parseGen = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private win = { start: 0, end: WINDOW };
  private selId = -1;
  private pendingSel?: Path;
  private pathMap?: (p: Path) => Path | null;
  private query?: SearchQuery;
  private searchGen = 0;
  private webState?: WebState;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;
  private hs = hostStrings();

  constructor(
    readonly doc: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private host: SessionHost,
  ) {
    this.format = formatOf(doc.uri.path, doc.languageId);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebMsg) => this.onMessage(m).catch((err) => this.notice(String((err as Error)?.message ?? err), 'error'))),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc && e.contentChanges.length) this.schedule();
      }),
      panel.onDidChangeViewState(() => this.host.setActive(panel.active ? this : undefined)),
      panel.onDidDispose(() => this.dispose()),
    );
    if (panel.active) this.host.setActive(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.parseGen++;
    this.searchGen++;
    this.host.setActive(undefined);
    for (const d of this.disposables) d.dispose();
  }

  private post(m: HostMsg): void {
    if (!this.disposed) void this.panel.webview.postMessage(m);
  }

  private notice(text: string, kind: 'info' | 'error' = 'info'): void {
    this.post({ type: 'notice', text, kind });
  }

  private config() {
    const c = vscode.workspace.getConfiguration('dataViewer');
    return { indent: c.get<number>('tree.indent', 2) === 4 ? 4 : 2, depth: Math.max(0, Math.min(10, c.get<number>('tree.expandDepth', 2))) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Parsing

  private schedule(): void {
    clearTimeout(this.timer);
    // size of the last parse: avoids materialising a big document's text on every keystroke
    const big = (this.parsed?.store.src.length ?? 0) > 2 * 1024 * 1024;
    this.timer = setTimeout(() => void this.parse(), big ? 300 : 20);
  }

  /** Parse the current text and refresh the view. Resolves when the new tree is on screen. */
  async parse(): Promise<void> {
    const gen = ++this.parseGen;
    const version = this.doc.version;
    const text = this.doc.getText();
    const big = text.length > 2 * 1024 * 1024;
    let busy = false;
    const busyTimer = setTimeout(() => {
      busy = true;
      this.post({ type: 'busy', on: true, text: 'Parsing…' });
    }, 120);
    let parsed: Parsed | undefined;
    try {
      parsed = await parseDoc(this.format, text, big ? () => new Promise<boolean>((r) => setImmediate(() => r(gen === this.parseGen && !this.disposed))) : undefined);
    } catch (err) {
      parsed = undefined;
      this.notice(this.hs.parseFailed + ': ' + String((err as Error)?.message ?? err), 'error');
    } finally {
      clearTimeout(busyTimer);
      if (busy) this.post({ type: 'busy', on: false });
    }
    if (!parsed || gen !== this.parseGen || this.disposed) return;
    this.parsed = parsed;
    this.docVersion = version;
    // UTF-8 size in slices (a 48 MB scan in one go would hold the extension host for ~50 ms)
    let bytes = 0;
    for (let a = 0; a < text.length; a += 4 * 1024 * 1024) {
      bytes += Buffer.byteLength(text.slice(a, a + 4 * 1024 * 1024), 'utf8');
      if (big) {
        await new Promise((r) => setImmediate(r));
        if (gen !== this.parseGen || this.disposed) return;
      }
    }
    this.bytes = bytes;
    const hasErr = parsed.errors.some((e) => !e.warning);
    if (!hasErr) this.good = parsed;
    const display = hasErr && this.good ? this.good : parsed;
    const old = this.view;
    const keepScroll = !!old;
    if (display !== this.shown || !old) {
      const snap = old?.snapshot();
      let selPath = this.selId >= 0 && old && this.selId < old.st.n ? old.st.path(this.selId) : undefined;
      // millions of nodes: start shallower so the first view stays a quick flatten (huge top-level lists collapsed)
      const st0 = display.store;
      const depth = st0.n > 1_000_000 ? Math.min(st0.count[0] > 1000 ? 0 : 1, this.config().depth) : this.config().depth;
      const v = new View(display.store, this.format, depth);
      if (snap) {
        const map = this.pathMap;
        if (map) {
          const m = <T>(list: [Path, T][]) => list.flatMap(([p, x]): [Path, T][] => {
            const q = map(p);
            return q ? [[q, x]] : [];
          });
          snap.over = m(snap.over);
          snap.fold = m(snap.fold);
          snap.tables = m(snap.tables);
          if (selPath) selPath = map(selPath) ?? undefined;
        }
        v.restore(snap);
      } else if (this.webState) {
        if (this.webState.mode) v.mode = this.webState.mode;
        if (this.webState.syntax && display.syntaxes.includes(this.webState.syntax)) v.syntax = this.webState.syntax;
        selPath = this.webState.selPath;
      }
      if (!display.syntaxes.includes(v.syntax)) v.syntax = display.syntaxes[0];
      if (this.pendingSel) selPath = this.pendingSel;
      this.shown = display;
      this.view = v;
      this.selId = selPath ? v.st.find(selPath) : -1;
      if (this.selId < 0 && selPath && selPath.length) {
        // fall back to the closest existing ancestor
        for (let k = selPath.length - 1; k >= 0 && this.selId < 0; k--) this.selId = v.st.find(selPath.slice(0, k));
      }
      if (this.pendingSel && this.selId >= 0) v.reveal(this.selId);
    }
    const scrollToSel = !!this.pendingSel;
    this.pendingSel = undefined;
    this.pathMap = undefined;
    const v = this.view!;
    v.flatten();
    const row = this.selId >= 0 ? v.rowOf(this.selId) : -1;
    this.sendView({ keepScroll, scrollTo: scrollToSel && row >= 0 ? row : !old && row >= 0 ? row : undefined });
    if (this.selId >= 0) this.sendSelection();
    if (this.query?.text) void this.runSearch(this.query, false);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Webview messages

  private get readOnly(): boolean {
    const p = this.parsed;
    return !p || p !== this.shown || p.errors.some((e) => !e.warning) || !!p.readOnly || p.partial;
  }

  private status(): Status {
    const p = this.parsed!;
    const s = this.shown!;
    const hs = this.hs;
    const label = s.format === 'yaml' && (s.docs ?? 1) > 1 ? hs.yamlDocs(s.docs!) : (hs as unknown as Record<string, string>)[s.label] ?? s.label;
    const errors: ErrorInfo[] = p.errors.slice(0, MAX_ERRORS).map((e) => {
      let line = e.line;
      let col = e.col;
      if (line === undefined) {
        const pos = this.doc.positionAt(e.offset);
        line = pos.line + 1;
        col = pos.character + 1;
      }
      return { message: hostMessage(e.message), line, col: col ?? 1, offset: e.offset, severity: e.warning ? 'warning' : 'error' };
    });
    const ro = this.readOnly;
    let readOnly = '';
    if (ro) readOnly = p.readOnly === 'xml' ? hs.xmlReadOnly : hs.fixToEdit;
    const editable = !ro;
    return {
      format: this.format,
      label,
      nodes: s.store.n,
      bytes: this.bytes,
      docs: s.docs,
      errors,
      stale: p !== s,
      readOnly,
      parseMs: Math.round(p.ms),
      canFormat: editable && !!p.formatDoc,
      canMinify: editable && !!p.minify,
      canSort: editable && !!p.sortKeys,
      pathStyles: s.pathStyles,
      syntaxes: s.syntaxes,
    };
  }

  private sendView(o: { keepScroll?: boolean; scrollTo?: number } = {}): void {
    const v = this.view;
    if (!v || !this.shown) return;
    let start = this.win.start;
    let end = this.win.end;
    if (o.scrollTo !== undefined && (o.scrollTo < start || o.scrollTo >= end)) {
      start = Math.max(0, o.scrollTo - WINDOW / 2);
      end = start + WINDOW;
    }
    end = Math.min(Math.max(end, start + 100), v.len);
    start = Math.max(0, Math.min(start, Math.max(0, v.len - (end - start))));
    const rows = v.rowsData(start, end, this.readOnly);
    this.post({
      type: 'view',
      version: v.version,
      mode: v.mode,
      syntax: v.syntax,
      total: v.len,
      start,
      rows,
      status: this.status(),
      depth: v.depth,
      sel: this.selId >= 0 ? v.rowOf(this.selId) : -1,
      selId: this.selId,
      scrollTo: o.scrollTo,
      keepScroll: o.keepScroll,
      layout: this.shown.layout === 'ini' && v.mode === 'tree' ? 'ini' : 'tree',
      keyWidth: this.shown.keyWidth,
      filter: v.filter,
    });
  }

  private sendSelection(): void {
    const v = this.view;
    if (!v || this.selId < 0 || this.selId >= v.st.n) return;
    const st = v.st;
    const id = this.selId;
    const chain = [...st.ancestors(id), id].filter((c) => c !== 0 || !st.isContainer(0));
    const crumbs = chain.map((c) => {
      const k = st.key(c);
      return { id: c, label: k === undefined ? '' : String(k), kk: st.kk[c] as KeyKind };
    });
    const style = this.shown!.pathStyles[0];
    this.post({ type: 'selection', id, crumbs, path: formatPath(st, id, style) });
  }

  private refresh(o: { keepScroll?: boolean; scrollTo?: number } = { keepScroll: true }): void {
    this.view?.flatten();
    this.sendView(o);
  }

  async onMessage(m: WebMsg): Promise<void> {
    const v = this.view;
    switch (m.type) {
      case 'ready': {
        this.webState = m.state;
        const cfg = this.config();
        this.post({ type: 'init', strings: webviewStrings(), fileName: this.doc.uri.path.split('/').pop() ?? '', format: this.format, indent: cfg.indent, expandDepth: cfg.depth });
        if (this.view && this.docVersion === this.doc.version) {
          this.sendView({ keepScroll: false });
          this.sendSelection();
          if (this.query?.text) this.postSearch();
        } else {
          if (m.state?.search?.text) this.query = m.state.search;
          await this.parse();
        }
        return;
      }
      case 'rows': {
        if (!v) return;
        this.win = { start: Math.max(0, m.start), end: Math.max(m.start, m.end) };
        if (m.version !== v.version) return;
        this.post({ type: 'rows', version: v.version, start: this.win.start, rows: v.rowsData(this.win.start, this.win.end, this.readOnly) });
        return;
      }
      case 'toggle': {
        if (!v || m.id < 0 || m.id >= v.st.n) return;
        const on = m.expand ?? !v.isExpanded(m.id);
        if (m.recursive) {
          v.setSubtree(m.id, on);
          v.flatten();
        } else v.setExpandedFast(m.id, on);
        this.sendView({ keepScroll: true });
        return;
      }
      case 'depth':
        if (!v) return;
        v.expandTo(m.depth);
        this.refresh({ keepScroll: true, scrollTo: this.selId >= 0 ? undefined : 0 });
        return;
      case 'mode': {
        if (!v) return;
        v.mode = m.mode;
        if (m.syntax && this.shown!.syntaxes.includes(m.syntax)) v.syntax = m.syntax;
        v.flatten();
        const row = this.selId >= 0 ? v.rowOf(this.selId) : -1;
        this.sendView({ scrollTo: row >= 0 ? row : 0 });
        return;
      }
      case 'table': {
        if (!v || v.st.kind[m.id] !== Kind.Arr) return;
        if (m.on) {
          v.tables.set(m.id, { col: -1, desc: false });
          v.setExpanded(m.id, true);
        } else v.tables.delete(m.id);
        this.refresh();
        return;
      }
      case 'tableSort': {
        const ts = v?.tables.get(m.id);
        if (!v || !ts) return;
        if (ts.col !== m.col) v.tables.set(m.id, { col: m.col, desc: false });
        else if (!ts.desc) v.tables.set(m.id, { col: m.col, desc: true });
        else v.tables.set(m.id, { col: -1, desc: false });
        this.refresh();
        return;
      }
      case 'select':
        if (!v || m.id < 0 || m.id >= v.st.n) return;
        this.selId = m.id;
        this.sendSelection();
        return;
      case 'reveal': {
        if (!v || m.id < 0 || m.id >= v.st.n) return;
        v.revealFast(m.id);
        if (m.select !== false) this.selId = m.id;
        this.sendView({ keepScroll: true, scrollTo: v.rowOf(m.id) });
        this.sendSelection();
        return;
      }
      case 'openCell': {
        if (!v || m.id < 0 || m.id >= v.st.n) return;
        const st = v.st;
        for (let a = st.parent[m.id]; a >= 0; a = st.parent[a]) if (v.tables.has(a)) v.tables.delete(a);
        v.reveal(m.id);
        if (st.isContainer(m.id)) v.setExpanded(m.id, true);
        this.selId = m.id;
        v.flatten();
        this.sendView({ keepScroll: true, scrollTo: v.rowOf(m.id) });
        this.sendSelection();
        return;
      }
      case 'search':
        await this.runSearch(m.query, true);
        return;
      case 'searchNav': {
        if (!v || !v.matchCount) return;
        const n = Math.min(v.matchCount, v.matches.length);
        this.gotoMatch((v.current + m.dir + n) % n);
        return;
      }
      case 'edit':
        await this.edit(m.edit);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
      case 'copyNode':
        await this.copyNode(m.id, m.what, m.style);
        return;
      case 'getValue': {
        if (!v || m.id < 0 || m.id >= v.st.n) return;
        const full = v.st.text(m.id, 4 * 1024 * 1024);
        this.post({ type: 'value', id: m.id, text: full, truncated: v.st.textLength(m.id) > full.length, purpose: m.purpose });
        return;
      }
      case 'openUrl':
        if (/^(https?|mailto|ftp):/i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url, true));
        return;
      case 'action':
        await this.action(m.name);
        return;
      case 'source':
        await this.revealSource(m.id);
        return;
      case 'gotoError': {
        const e = this.parsed?.errors[m.index];
        if (e) await this.showText(e.offset, e.offset);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Search

  private postSearch(error?: string, busy?: boolean, ms?: number): void {
    const v = this.view;
    this.post({ type: 'search', count: v?.matchCount ?? 0, current: v?.current ?? -1, capped: !!v && v.matchCount > v.matches.length, error, busy, ms: ms === undefined ? undefined : Math.round(ms) });
  }

  /** Focus the webview's search box (Ctrl/Cmd+F). */
  focusSearch(): void {
    this.post({ type: 'focusSearch' });
  }

  /**
   * Whole-document search in ≤20 ms slices (each new query cancels the previous one). The first match at or after
   * the selection is revealed as soon as the scan reaches it; the count streams in while the rest is scanned.
   */
  private async runSearch(q: SearchQuery, jump: boolean): Promise<void> {
    const gen = ++this.searchGen;
    this.query = q;
    const v = this.view;
    if (!v) return;
    if (!q.text) {
      const wasFilter = v.filter;
      v.setSearch(undefined);
      v.filter = false;
      if (wasFilter) v.flatten();
      this.sendView({ keepScroll: true });
      this.postSearch();
      return;
    }
    let re: RegExp;
    try {
      re = compileQuery(q);
    } catch (err) {
      this.postSearch(String((err as Error).message));
      return;
    }
    const t0 = performance.now();
    const prevId = v.current >= 0 ? v.matches[v.current] : -1;
    const s = new Searcher(v.st, re, q.scope, jump ? Math.max(0, this.selId) : 0);
    let jumped = !jump;
    let lastPost = t0;
    for (;;) {
      const done = s.step(20);
      if (gen !== this.searchGen || v !== this.view || this.disposed) return;
      if (!jumped && s.first >= 0) {
        // reveal the first hit right away; the count keeps streaming in
        jumped = true;
        const part = s.result();
        v.setSearch(part);
        v.filter = q.filter;
        this.gotoMatch(Math.max(0, part.matches.indexOf(s.first)), !done, performance.now() - t0);
        lastPost = performance.now();
      }
      if (done) break;
      if (performance.now() - lastPost > 100) {
        lastPost = performance.now();
        this.post({ type: 'search', count: s.found, current: jumped ? v.current : -1, busy: true, ms: Math.round(lastPost - t0) });
      }
      await new Promise((r) => setImmediate(r));
      if (gen !== this.searchGen || v !== this.view || this.disposed) return;
    }
    const res = s.result();
    const curId = jump ? s.first : prevId;
    v.setSearch(res);
    v.filter = q.filter;
    v.current = curId >= 0 ? Math.max(-1, res.matches.indexOf(curId)) : res.count ? 0 : -1;
    if (!res.count) v.current = -1;
    // final refresh so rows carry the complete match flags; only the filter needs the rows rebuilt
    if (v.filter && v.mode === 'tree') v.flatten();
    this.sendView({ keepScroll: true });
    this.postSearch(undefined, false, performance.now() - t0);
  }

  private gotoMatch(idx: number, busy = false, ms?: number): void {
    const v = this.view!;
    v.current = idx;
    const id = v.matches[idx];
    this.selId = id;
    if (v.filter && v.mode === 'tree') {
      v.reveal(id);
      v.flatten();
    } else v.revealFast(id);
    this.sendView({ keepScroll: true, scrollTo: v.rowOf(id) });
    this.sendSelection();
    this.postSearch(undefined, busy, ms);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Edits

  private editCtx() {
    // the parsed text is the document's current text (edits are refused when the versions differ)
    const text = this.parsed?.store.src ?? this.doc.getText();
    const ind = this.detectIndent(text);
    return { unit: ind, eol: detectEol(text) };
  }

  private detectIndent(text: string): string {
    const m = /\n([ \t]+)\S/.exec(text.slice(0, 64 * 1024));
    if (m) {
      if (m[1][0] === '\t') return '\t';
      // smallest indentation step among the first lines
      let step = m[1].length;
      const re = /\n( +)\S/g;
      const head = text.slice(0, 64 * 1024);
      for (let x; (x = re.exec(head)); ) if (x[1].length < step) step = x[1].length;
      if (step === 2 || step === 4 || step === 3 || step === 8) return ' '.repeat(step);
    }
    return ' '.repeat(this.config().indent);
  }

  private async applyEdits(edits: TextEdit[]): Promise<boolean> {
    if (!edits.length) return true;
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) we.replace(this.doc.uri, new vscode.Range(this.doc.positionAt(e.start), this.doc.positionAt(e.end)), e.text);
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) this.notice(this.hs.editFailed, 'error');
    return ok;
  }

  async edit(op: EditOp): Promise<void> {
    const p = this.parsed;
    if (!p || !this.view) return;
    if (this.docVersion !== this.doc.version) {
      await this.parse();
      return;
    }
    if (this.readOnly) {
      this.notice(this.status().readOnly || this.hs.fixToEdit, 'error');
      return;
    }
    let edits: TextEdit[];
    try {
      edits = p.edit(op, this.editCtx());
    } catch (err) {
      this.notice(err instanceof EditError ? hostMessage(err.message) : String((err as Error)?.message ?? err), 'error');
      return;
    }
    this.planSelection(p.store, op);
    if (!(await this.applyEdits(edits))) {
      this.pendingSel = undefined;
      this.pathMap = undefined;
    }
  }

  /** Where the selection goes after an edit, and how stored paths shift. */
  private planSelection(st: Store, op: EditOp): void {
    const i = op.id;
    const path = st.path(i);
    const parentPath = path.slice(0, -1);
    const isIndex = st.kk[i] === KeyKind.Index;
    const shift = (base: Path, from: number, delta: number, drop?: number) => (p: Path): Path | null => {
      if (p.length <= base.length || base.some((s, k) => p[k] !== s)) return p;
      const s = p[base.length];
      if (typeof s !== 'number') return p;
      if (drop !== undefined && s === drop) return null;
      if (s >= from) return [...base, s + delta, ...p.slice(base.length + 1)];
      return p;
    };
    switch (op.op) {
      case 'set':
        this.pendingSel = path;
        break;
      case 'rename': {
        const np = [...parentPath, op.key];
        this.pendingSel = np;
        this.pathMap = (p) => (p.length >= path.length && path.every((s, k) => p[k] === s) ? [...np, ...p.slice(path.length)] : p);
        break;
      }
      case 'delete': {
        const next = st.nextSibling(i);
        if (isIndex) {
          this.pendingSel = next >= 0 ? path : st.pos[i] > 0 ? [...parentPath, st.pos[i] - 1] : parentPath;
          this.pathMap = shift(parentPath, st.pos[i] + 1, -1, st.pos[i]);
        } else this.pendingSel = next >= 0 ? [...parentPath, st.seg(next)] : parentPath;
        break;
      }
      case 'add': {
        if (st.kind[i] === Kind.Arr) {
          const at = op.after !== undefined && op.after >= 0 && st.parent[op.after] === i ? st.pos[op.after] + 1 : st.count[i];
          this.pendingSel = [...path, at];
          this.pathMap = shift(path, at, 1);
        } else this.pendingSel = [...path, op.key ?? ''];
        break;
      }
      case 'duplicate':
        if (isIndex) {
          this.pendingSel = [...parentPath, st.pos[i] + 1];
          this.pathMap = shift(parentPath, st.pos[i] + 1, 1);
        } else this.pendingSel = path;
        break;
      case 'move': {
        if (isIndex) {
          const a = st.pos[i];
          const b = a + op.dir;
          this.pendingSel = [...parentPath, b];
          this.pathMap = (p) => {
            if (p.length <= parentPath.length || parentPath.some((s, k) => p[k] !== s)) return p;
            const s = p[parentPath.length];
            if (s === a) return [...parentPath, b, ...p.slice(parentPath.length + 1)];
            if (s === b) return [...parentPath, a, ...p.slice(parentPath.length + 1)];
            return p;
          };
        } else this.pendingSel = path;
        break;
      }
    }
  }

  async action(name: 'format' | 'minify' | 'sortKeys' | 'openText'): Promise<void> {
    if (name === 'openText') {
      await vscode.commands.executeCommand('vscode.openWith', this.doc.uri, 'default', this.panel.viewColumn);
      return;
    }
    const p = this.parsed;
    if (!p) return;
    if (this.docVersion !== this.doc.version) await this.parse();
    if (this.readOnly) {
      this.notice(this.status().readOnly || this.hs.fixToEdit, 'error');
      return;
    }
    const fmt = p.formatDoc;
    const fn = name === 'format' ? (fmt ? () => fmt(this.config().indent, this.editCtx().eol) : undefined) : name === 'minify' ? p.minify : p.sortKeys;
    if (!fn) return;
    let edits: TextEdit[];
    try {
      edits = fn();
    } catch (err) {
      this.notice(err instanceof EditError ? hostMessage(err.message) : String((err as Error)?.message ?? err), 'error');
      return;
    }
    if (!edits.length) {
      this.notice(this.hs.nothingToDo);
      return;
    }
    if (this.selId >= 0 && this.view) this.pendingSel = this.view.st.path(this.selId);
    await this.applyEdits(edits);
  }

  private async copyNode(id: number, what: 'value' | 'json' | 'yaml' | 'xml' | 'key' | 'path', style?: PathStyle): Promise<void> {
    const v = this.view;
    if (!v || id < 0 || id >= v.st.n) return;
    const st = v.st;
    let text: string;
    try {
      switch (what) {
        case 'key':
          text = String(st.key(id) ?? '');
          break;
        case 'path':
          text = formatPath(st, id, style ?? this.shown!.pathStyles[0]);
          break;
        case 'xml':
          text = toXml(st, id, this.config().indent);
          break;
        case 'yaml':
          text = toYaml(st.toValue(id), this.config().indent);
          break;
        case 'json':
          text = JSON.stringify(st.toValue(id), null, this.config().indent);
          break;
        default:
          text = st.isContainer(id) ? JSON.stringify(st.toValue(id), null, this.config().indent) : st.text(id);
      }
    } catch {
      this.notice(this.hs.tooLarge, 'error');
      return;
    }
    await vscode.env.clipboard.writeText(text);
  }

  private async revealSource(id: number): Promise<void> {
    const v = this.view;
    if (!v || id < 0 || id >= v.st.n) return;
    const st = v.st;
    const s = st.ks[id] >= 0 ? st.ks[id] : st.vs[id];
    const e = st.ve[id] >= s ? st.ve[id] : s;
    if (s < 0) return;
    await this.showText(s, st.kk[id] === KeyKind.Elem ? s : e);
  }

  private async showText(start: number, end: number): Promise<void> {
    const sel = new vscode.Range(this.doc.positionAt(start), this.doc.positionAt(end));
    await vscode.window.showTextDocument(this.doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: sel });
  }
}
