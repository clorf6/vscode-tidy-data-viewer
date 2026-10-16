// The table document: loads a file into a model, owns the current view (filter/sort), serves the webview,
// applies edits with undo/redo, saves, and watches the file on disk.
import * as fs from 'fs';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { delimiterLabel, serializeRow, toMarkdown, tsvField } from './csv';
import { CellSet, Change, CsvModel, JsonlModel, LogModel, TableModel } from './models';
import { ParquetModel } from './parquet';
import { CopyFormat, EditOp, Meta, Query, RowData, TableKind, ToHost, ToView } from './protocol';
import { runQuery, runStats } from './query';
import { cellsMatching, compileSpec, searchRows } from './search';
import { Slicer, Token, isCancel } from './sched';
import { TextRows, encodeOut } from './textrows';
import { DELIMS, detectEol, sniffDelimiter } from './csv';

export const RESIDENT_LIMIT = 512 * 1024 * 1024;
/** Backups written in this session (so reopening does not depend on parsing the id). */
const backupUris = new Map<string, vscode.Uri>();

export function kindFor(uri: vscode.Uri): TableKind {
  const name = (uri.path.split('/').pop() ?? '').toLowerCase();
  if (/\.(jsonl|ndjson)$/.test(name)) return 'jsonl';
  if (/\.parquet$/.test(name)) return 'parquet';
  if (/\.log$/.test(name) || name === 'nohup.out' || /^slurm-.*\.out$/.test(name)) return 'log';
  return 'csv';
}

interface Composite extends Change {
  view?: boolean;
}

export interface DocHost {
  /** Fire onDidChangeCustomDocument. */
  fireEdit(doc: TableDocument, change: Change): void;
  config<T>(key: string, def: T): T;
}

export class TableDocument implements vscode.CustomDocument {
  readonly kind: TableKind;
  model!: TableModel;
  rows?: TextRows;
  loaded = false;
  ready = false;
  progress = 0;
  error?: string;
  view: Uint32Array | null = null;
  vv = 1;
  query: Query = { filters: [] };
  viewCols: number[] = [];
  eol = '\n';
  readOnlyReason?: string;
  fromBackup = false;
  private pos = 0;
  private savedPos = 0;
  private gen = 0;
  private post: (m: ToView) => void = () => undefined;
  private attached = false;
  private loadToken = new Token();
  private queryToken?: Token;
  private searchToken?: Token;
  private rowQueue: { vv: number; b: number; bs: number }[] = [];
  private serving = false;
  private lastMetaPost = 0;
  private watcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private lastStat?: { size: number; mtimeMs: number };
  private ownWrite?: { size: number; mtimeMs: number };
  private changedOnDisk = false;
  follow = true;
  visible = true;
  private disposed = false;
  private headerPref?: boolean;
  private changeCheck?: Promise<void>;
  private readyWaiters: (() => void)[] = [];
  /** Performance marks (ms since open) for tests and the report. */
  timings: Record<string, number> = {};
  private t0 = performance.now();

  constructor(
    readonly uri: vscode.Uri,
    private host: DocHost,
    private backupId?: string,
  ) {
    this.kind = kindFor(uri);
    this.follow = host.config('log.follow', true);
  }

  get name(): string {
    return this.uri.path.split('/').pop() ?? '';
  }

  get dirty(): boolean {
    return this.fromBackup || this.pos !== this.savedPos;
  }

  get editable(): boolean {
    return !this.readOnlyReason;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loading

  private mark(k: string): void {
    this.timings[k] = Math.round(performance.now() - this.t0);
  }

  /** Resolves once the first rows are indexed (or the load failed). */
  whenReady(): Promise<void> {
    return this.ready || this.error ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r));
  }

  private setReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.mark('firstRows');
    for (const w of this.readyWaiters.splice(0)) w();
    if (this.attached) this.sendInit();
  }

  /** load() was called at least once (the provider skips it for files that reopen as text). */
  loadStarted = false;

  async load(): Promise<void> {
    this.loadStarted = true;
    const token = (this.loadToken = new Token());
    this.loaded = false;
    try {
      if (this.kind === 'parquet') await this.loadParquet();
      else await this.loadText(token);
      this.loaded = true;
      this.mark('indexed');
      if (this.model instanceof CsvModel) {
        if (this.rows?.resident) await this.model.analyze(new Slicer(token));
        else if (this.model.rows.count() > 3000) {
          await this.model.inferTypes();
          this.model.buildColumns();
        }
      }
      this.mark('analyzed');
      this.progress = 1;
      if (this.query.sort || this.query.filters.length || this.query.text || this.query.levels !== undefined) await this.applyQuery(this.query, false);
      this.postMeta(true);
      if (this.kind === 'jsonl') void this.validateJsonl(token);
      if (this.model instanceof LogModel && !this.model.levelsReady) void this.levelPass(this.model, token);
      this.startWatching();
    } catch (e) {
      if (isCancel(e)) return;
      this.error = e instanceof Error ? e.message : String(e);
      for (const w of this.readyWaiters.splice(0)) w();
      this.post({ type: 'error', message: this.error });
    }
  }

  private async loadParquet(): Promise<void> {
    const m = new ParquetModel(this.uri.fsPath);
    await m.open();
    this.model = m;
    this.readOnlyReason = l10n.t('Parquet files are read-only.');
    this.lastStat = await statOf(this.uri.fsPath);
    this.setReady();
  }

  private async loadText(token: Token): Promise<void> {
    const kind = this.kind;
    const rows = new TextRows({ quotes: kind === 'csv', delim: 44, skipBlank: kind === 'jsonl' });
    let model: TableModel;
    if (kind === 'csv') model = new CsvModel(rows);
    else if (kind === 'jsonl') model = new JsonlModel(rows);
    else model = new LogModel(rows);
    this.rows = rows;
    this.model = model;
    const maxMB = this.host.config('table.maxEditableMB', 64);
    let delim: string | undefined;
    if (kind === 'csv') {
      // the delimiter matters for quote detection while indexing, so decide it from the first bytes
      rows.onHead = (head) => {
        delim = pickDelimiter(this.name, this.host.config('table.delimiter', 'auto'), head);
        rows.opts.delim = delim.charCodeAt(0);
      };
    }
    let setupDone = false;
    const setup = async () => {
      if (setupDone) return;
      setupDone = true;
      if (kind === 'csv') await (model as CsvModel).setup(this.name, undefined, delim, this.headerPref);
      else if (kind === 'jsonl') await (model as JsonlModel).setup();
      this.eol = rows.resident ? detectEol(rows.buf.subarray(0, Math.min(rows.size, 1 << 20))) : '\n';
      this.setReady();
    };
    const onProgress = (first: boolean) => {
      this.progress = rows.fileSize ? Math.min(1, (rows.resident ? rows.size : rows.scanPos) / rows.fileSize) : 1;
      if (first && !setupDone) return; // handled after the await below
      this.postMeta(false);
    };
    const backup = this.backupId ? (backupUris.get(this.backupId) ?? vscode.Uri.parse(this.backupId)) : undefined;
    if (backup || this.uri.scheme !== 'file') {
      const bytes = await vscode.workspace.fs.readFile(backup ?? this.uri);
      if (backup) this.fromBackup = true;
      await rows.loadBytes(bytes, token);
      await setup();
    } else {
      const st = await fs.promises.stat(this.uri.fsPath);
      this.lastStat = { size: st.size, mtimeMs: st.mtimeMs };
      if (st.size > RESIDENT_LIMIT && model instanceof LogModel) model.deferLevels();
      const firstDone = new Promise<void>((resolve) => {
        const load = st.size > RESIDENT_LIMIT ? rows.openStreamed(this.uri.fsPath, (f) => (f ? resolve() : onProgress(f)), token) : rows.loadFile(this.uri.fsPath, (f) => (f ? resolve() : onProgress(f)), token, kind === 'log' ? 1 << 20 : 0);
        this.loading = load.then(
          () => resolve(),
          (e) => {
            resolve();
            throw e;
          },
        );
        // closed while loading: the rejection (cancelled) is handled by load(), never left unhandled
        this.loading.catch(() => undefined);
      });
      await firstDone;
      token.check();
      await setup();
      await this.loading;
    }
    if (!rows.resident) this.readOnlyReason = l10n.t('This file is larger than {0} MB, so it is opened read-only and streamed from disk.', Math.round(RESIDENT_LIMIT / 1048576));
    else if (kind === 'log') this.readOnlyReason = l10n.t('Logs are read-only.');
    else if (!rows.enc.writable) this.readOnlyReason = l10n.t('Opened read-only: {0} files cannot be saved by Data Viewer.', rows.enc.name);
    else if (rows.fileSize > maxMB * 1048576) this.readOnlyReason = l10n.t('This file is larger than {0} MB, so it is opened read-only.', maxMB);
    else this.readOnlyReason = undefined;
  }
  private loading?: Promise<void>;

  private levelsDone?: Promise<void>;
  private async levelPass(m: LogModel, token: Token): Promise<void> {
    this.levelsDone = m.levelPass(token, () => this.postMeta(false));
    try {
      await this.levelsDone;
      this.mark('levels');
      if (this.query.levels !== undefined) await this.applyQuery(this.query, false);
      this.postMeta(true);
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  }

  private async validateJsonl(token: Token): Promise<void> {
    const m = this.model as JsonlModel;
    try {
      await m.validate(new Slicer(token), () => undefined);
      this.postMeta(true);
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Webview session

  attach(post: (m: ToView) => void): void {
    this.post = post;
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
    this.post = () => undefined;
    this.rowQueue = [];
    this.searchToken?.cancel();
  }

  private settings() {
    return { density: this.host.config<'compact' | 'normal' | 'comfortable'>('table.rowHeight', 'normal'), wrap: this.host.config('table.wrapCells', false), follow: this.follow };
  }

  sendInit(): void {
    if (!this.ready) return;
    const { size } = this.lastStat ?? { size: this.rows?.fileSize ?? 0 };
    this.post({ type: 'init', strings: this.strings(), file: { name: this.name, path: this.uri.fsPath, size: this.rows?.fileSize ?? size, kind: this.kind }, settings: this.settings(), meta: this.meta() });
  }

  strings: () => Record<string, string> = () => ({});

  viewCount(): number {
    return this.view ? this.view.length : this.model.count();
  }

  viewId(p: number): number {
    return this.view ? this.view[p] : this.model.idAt(p);
  }

  viewIds(p0: number, p1: number): number[] {
    const out: number[] = [];
    for (let p = p0; p < p1; p++) out.push(this.viewId(p));
    return out;
  }

  meta(): Meta {
    const m = this.model;
    const warnings: string[] = [];
    let delimiter: string | undefined;
    let hasHeader = false;
    if (m instanceof CsvModel) {
      delimiter = delimiterLabel(m.delim);
      hasHeader = m.hasHeader;
      if (m.ragged) warnings.push(l10n.t('{0} rows have a different number of fields', m.ragged.toLocaleString()));
    }
    if (this.rows && !this.rows.resident) warnings.push(l10n.t('Streamed from disk'));
    const meta: Meta = {
      total: m ? m.count() : 0,
      count: m ? this.viewCount() : 0,
      vv: this.vv,
      columns: m ? m.columns : [],
      indexing: !this.loaded,
      progress: this.progress,
      hasHeader,
      delimiter,
      encoding: this.rows ? this.rows.enc.name : 'Parquet',
      eol: this.eol === '\r\n' ? 'CRLF' : 'LF',
      readOnly: !!this.readOnlyReason || !this.loaded,
      readOnlyReason: this.readOnlyReason,
      dirty: this.dirty,
      warnings,
      query: this.query,
      headerToggle: this.kind === 'csv',
    };
    if (m instanceof JsonlModel && m.validated) meta.invalid = m.invalidCount;
    if (m instanceof LogModel) {
      meta.levelCounts = m.counts.slice();
      if (!m.levelsReady) meta.levelsPending = true;
    }
    if (m instanceof ParquetModel) meta.parquet = { rowGroups: m.groups.length, createdBy: m.info.createdBy, compression: m.compression(), version: m.info.version };
    return meta;
  }

  postMeta(force: boolean, reset = false): void {
    if (!this.attached || !this.ready) return;
    const now = performance.now();
    if (!force && now - this.lastMetaPost < 120) return;
    this.lastMetaPost = now;
    if (this.model) this.model.columnsChanged = false;
    this.post({ type: 'meta', meta: this.meta(), reset });
  }

  async handle(msg: ToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.attached = true;
        if (msg.hasHeader !== undefined && this.model instanceof CsvModel && msg.hasHeader !== this.model.hasHeader) {
          this.headerPref = msg.hasHeader;
          if (this.ready) await this.setHeader(msg.hasHeader);
        }
        if (msg.query && this.ready) {
          if (JSON.stringify(msg.query) !== JSON.stringify(this.query)) {
            this.sendInit();
            await this.applyQuery(msg.query);
            return;
          }
        } else if (msg.query) this.query = msg.query;
        this.sendInit();
        if (this.changedOnDisk && this.dirty) this.post({ type: 'banner', kind: 'changed' });
        return;
      case 'rows':
        for (const b of msg.blocks) this.rowQueue.push({ vv: msg.vv, b, bs: msg.bs });
        if (this.rowQueue.length > 48) {
          const dropped = this.rowQueue.splice(0, this.rowQueue.length - 48);
          this.post({ type: 'dropped', vv: msg.vv, blocks: dropped.map((d) => d.b) });
        }
        void this.serveRows();
        return;
      case 'query':
        await this.applyQuery(msg.query);
        return;
      case 'search':
        await this.search(msg);
        return;
      case 'stats': {
        const st = await runStats(this.model, this.view ?? this.model.orderArray(), !this.view && this.model.isIdentity(), msg.key, msg.top, new Slicer());
        this.post({ type: 'stats', stats: st });
        return;
      }
      case 'record': {
        if (msg.row < 0 || msg.row >= this.viewCount()) return void this.post({ type: 'record', row: msg.row, vv: msg.vv, data: null });
        const [data] = await this.model.getRows([this.viewId(msg.row)], true);
        this.post({ type: 'record', row: msg.row, vv: msg.vv, data });
        return;
      }
      case 'edit':
        await this.edit(msg.edit);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        return;
      case 'copyRange':
        await vscode.env.clipboard.writeText(await this.rangeText(msg.r0, msg.r1, msg.keys, msg.format, msg.header));
        return;
      case 'pasteReq':
        this.post({ type: 'paste', text: await vscode.env.clipboard.readText() });
        return;
      case 'header':
        this.headerPref = msg.value;
        await this.setHeader(msg.value);
        return;
      case 'viewCols':
        this.viewCols = msg.keys;
        return;
      case 'follow':
        this.follow = msg.on;
        this.updateWatching();
        if (msg.on) void this.checkDisk();
        return;
      case 'findLevel':
      case 'findInvalid': {
        const row = await this.find(msg);
        this.post({ type: 'found', row });
        return;
      }
      case 'command':
        if (msg.id === 'reload') await this.reload();
        else await vscode.commands.executeCommand(msg.id === 'openAsText' ? 'dataViewer.openAsText' : msg.id === 'export' ? 'dataViewer.table.exportAs' : msg.id === 'goToRow' ? 'dataViewer.table.goToRow' : 'workbench.action.openSettings', msg.id === 'settings' ? 'dataViewer.table' : this.uri);
        return;
      case 'setting':
        return;
    }
  }

  /** Answer row requests in order. Every request gets exactly one reply: `rows`, or `dropped` (stale / failed). */
  private async serveRows(): Promise<void> {
    if (this.serving) return;
    this.serving = true;
    try {
      while (this.rowQueue.length) {
        const r = this.rowQueue.shift()!;
        if (r.vv !== this.vv || !this.model) {
          this.post({ type: 'dropped', vv: r.vv, blocks: [r.b] });
          continue;
        }
        try {
          const n = this.viewCount();
          const p0 = r.b * r.bs;
          const p1 = Math.min(n, p0 + r.bs);
          const rows = p0 < p1 ? await this.model.getRows(this.viewIds(p0, p1), false) : [];
          if (r.vv !== this.vv) {
            this.post({ type: 'dropped', vv: r.vv, blocks: [r.b] });
            continue;
          }
          if (this.model.columnsChanged) this.postMeta(true);
          this.post({ type: 'rows', vv: r.vv, b: r.b, bs: r.bs, rows });
        } catch (e) {
          if (isCancel(e)) {
            this.post({ type: 'dropped', vv: r.vv, blocks: [r.b] });
            continue;
          }
          console.error('[Data Viewer] rows', r.b, e);
          this.post({ type: 'dropped', vv: r.vv, blocks: [r.b] });
          this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.serving = false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Queries

  async applyQuery(q: Query, notify = true): Promise<void> {
    this.query = q;
    if (!this.loaded) {
      // applied when indexing completes
      if (notify) this.postMeta(true);
      return;
    }
    this.queryToken?.cancel();
    const token = (this.queryToken = new Token());
    if (q.levels !== undefined && this.model instanceof LogModel && !this.model.levelsReady) return; // re-applied after the level pass
    const t0 = performance.now();
    const slicer = new Slicer(token);
    try {
      let lastP = 0;
      const view = await runQuery(this.model, q, slicer, (task, f) => {
        const now = performance.now();
        if (now - lastP > 100) {
          lastP = now;
          this.post({ type: 'progress', task, pct: f });
        }
      });
      token.check();
      this.view = view;
      this.vv++;
      this.timings.lastQuery = Math.round(performance.now() - t0);
      this.timings.lastQueryMaxBlock = Math.round(slicer.maxBlock);
      this.post({ type: 'progress', task: '', pct: 1 });
      if (notify || this.attached) this.postMeta(true, true);
    } catch (e) {
      if (!isCancel(e)) {
        this.post({ type: 'progress', task: '', pct: 1 });
        this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async search(msg: Extract<ToHost, { type: 'search' }>): Promise<void> {
    this.searchToken?.cancel();
    const token = (this.searchToken = new Token());
    const { id } = msg;
    const t0 = performance.now();
    const comp = compileSpec({ q: msg.q, regex: msg.regex, matchCase: msg.matchCase, word: msg.word }, this.kind, this.model instanceof JsonlModel && this.model.unicodeEscapes);
    if (!comp) return void this.post({ type: 'searchResult', id, total: 0, hits: [], capped: false, done: true });
    if ('error' in comp) return void this.post({ type: 'searchResult', id, total: 0, hits: [], capped: false, done: true, error: comp.error });
    const CAP = 500_000;
    const cols = msg.keys.filter((k) => this.model.columns.some((c) => c.key === k));
    const keys = cols.length ? cols : this.model.columns.map((c) => c.key);
    const lm = this.model instanceof LogModel ? this.model : undefined;
    const levels = lm ? [0, 0, 0, 0, 0, 0, 0] : undefined;
    let hits: number[] = [];
    let total = 0;
    let capped = false;
    let lastPost = 0;
    let firstHit = -1;
    const flush = (done: boolean) => {
      this.post({ type: 'searchResult', id, total, hits, capped, done, levels: levels?.slice(), ms: Math.round(performance.now() - t0) });
      hits = [];
      lastPost = performance.now();
    };
    try {
      const mode = await searchRows(
        this.model,
        { view: this.view, ascending: !this.query.sort },
        comp,
        {
          keys,
          from: msg.from,
          onRow: (pos, rid, li) => {
            for (const c of li) {
              total++;
              if (total <= CAP) hits.push(pos, c);
              else capped = true;
            }
            if (levels) levels[lm!.levels[rid]]++;
            if (firstHit < 0) {
              firstHit = performance.now() - t0;
              flush(false);
            } else if (performance.now() - lastPost > 100) flush(false);
          },
        },
        new Slicer(token),
      );
      token.check();
      this.timings.searchFirstHit = Math.round(firstHit);
      this.timings.searchTotal = Math.round(performance.now() - t0);
      this.timings.searchMode = mode === 'fast' ? 1 : 0;
      flush(true);
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  }

  private async find(msg: Extract<ToHost, { type: 'findLevel' | 'findInvalid' }>): Promise<number> {
    const n = this.viewCount();
    if (msg.type === 'findLevel' && this.model instanceof LogModel) {
      const lv = this.model.levels;
      for (let p = msg.from + msg.dir; p >= 0 && p < n; p += msg.dir) if (msg.mask & (1 << lv[this.viewId(p)])) return p;
      return -1;
    }
    if (msg.type === 'findInvalid' && this.model instanceof JsonlModel) {
      for (let p = msg.from + msg.dir; p >= 0 && p < n; p += msg.dir) if (this.model.isInvalid(this.viewId(p))) return p;
    }
    return -1;
  }

  private async setHeader(on: boolean): Promise<void> {
    if (!(this.model instanceof CsvModel) || this.model.hasHeader === on) return;
    await this.model.setHeader(on);
    this.query = { ...this.query, sort: null, filters: [] };
    this.view = null;
    this.vv++;
    this.postMeta(true, true);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Copy / export

  private header(keys: number[]): string[] {
    return keys.map((k) => this.model.columns.find((c) => c.key === k)?.name ?? '');
  }

  async rowsFor(r0: number, r1: number, keys: number[]): Promise<string[][]> {
    const idx = keys.map((k) => this.model.columns.findIndex((c) => c.key === k));
    const out: string[][] = [];
    for (let p = r0; p < r1; p += 2000) {
      const rows = await this.model.getRows(this.viewIds(p, Math.min(r1, p + 2000)), true);
      for (const r of rows) out.push(idx.map((i) => (i >= 0 ? (r.c[i] ?? '') : '')));
    }
    return out;
  }

  async rangeText(r0: number, r1: number, keys: number[], format: CopyFormat, header: boolean): Promise<string> {
    r1 = Math.min(r1, this.viewCount(), r0 + 1_000_000);
    const rows = await this.rowsFor(r0, r1, keys);
    return formatRows(format, this.header(keys), rows, header, this.model instanceof CsvModel ? this.model.delim : ',');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Editing

  private fire(change: Change, structural: boolean): void {
    const gen = this.gen;
    const wrap = (fn: () => void, d: number) => () => {
      if (gen !== this.gen) return;
      fn();
      this.pos += d;
      // keep filters/sort meaningful after structural undo/redo
      if (structural && this.view) void this.applyQuery(this.query);
      else this.afterChange();
    };
    this.pos++;
    this.afterChange();
    this.host.fireEdit(this, { label: change.label, undo: wrap(change.undo, -1), redo: wrap(change.redo, 1) });
  }

  private afterChange(): void {
    this.vv++;
    this.postMeta(true, true);
  }

  async edit(op: EditOp): Promise<void> {
    if (!this.editable || !this.loaded) return;
    const m = this.model as CsvModel | JsonlModel;
    if (!(m instanceof CsvModel || m instanceof JsonlModel)) return;
    const n = this.viewCount();
    switch (op.op) {
      case 'set':
        if (op.row < n) this.fire(m.setCells([{ id: this.viewId(op.row), key: op.key, value: op.value }]), false);
        return;
      case 'clear': {
        const sets: CellSet[] = [];
        for (const r of op.rows) if (r < n) for (const key of op.keys) sets.push({ id: this.viewId(r), key, value: '' });
        if (sets.length) this.fire(m.setCells(sets, 'Clear Cells'), false);
        return;
      }
      case 'paste': {
        const parts: Change[] = [];
        const need = op.row + op.rows.length - n;
        const inserted: number[] = [];
        if (need > 0) {
          const afterId = n > 0 ? this.viewId(n - 1) : null;
          const r = m.insertRowsAfter(afterId, need);
          if (this.view) this.view = concatU32(this.view, r.ids);
          inserted.push(...r.ids);
          parts.push(r.change);
        }
        const sets: CellSet[] = [];
        op.rows.forEach((vals, i) => {
          const p = op.row + i;
          const id = p < n ? this.viewId(p) : inserted[p - n];
          vals.forEach((v, j) => {
            if (j < op.keys.length) sets.push({ id, key: op.keys[j], value: v });
          });
        });
        parts.push(m.setCells(sets, 'Paste'));
        this.fire(composite('Paste', parts), need > 0);
        return;
      }
      case 'insertRows': {
        const afterId = op.at > 0 && op.at - 1 < n ? this.viewId(op.at - 1) : null;
        const r = m.insertRowsAfter(afterId, op.count);
        if (this.view) this.view = insertU32(this.view, Math.min(op.at, this.view.length), r.ids);
        this.fire(r.change, true);
        return;
      }
      case 'deleteRows': {
        const ids = op.rows.filter((r) => r < n).map((r) => this.viewId(r));
        if (!ids.length) return;
        const ch = m.deleteRows(ids);
        if (this.view) {
          const set = new Set(ids);
          this.view = this.view.filter((id) => !set.has(id));
        }
        this.fire(ch, true);
        return;
      }
      case 'insertCol':
        if (m instanceof CsvModel && !m.hasHeader) return;
        this.fire(m.insertCol(op.at, op.name), false);
        return;
      case 'renameCol':
        if (m instanceof CsvModel && !m.hasHeader) return;
        this.fire(m.renameCol(op.key, op.name), false);
        return;
      case 'deleteCol': {
        const ch = m.deleteCol(op.key);
        if (this.query.sort?.key === op.key || this.query.filters.some((f) => f.key === op.key)) {
          this.query = { ...this.query, sort: this.query.sort?.key === op.key ? null : this.query.sort, filters: this.query.filters.filter((f) => f.key !== op.key) };
        }
        this.fire(ch, false);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Save / revert / backup

  serialize(): Uint8Array {
    const m = this.model;
    if (!(m instanceof CsvModel || m instanceof JsonlModel) || !this.rows) throw new Error('read-only');
    return encodeOut(m.serialize(this.eol), this.rows.enc);
  }

  async saveAs(target: vscode.Uri): Promise<void> {
    if (!this.editable) return;
    const bytes = this.serialize();
    if (target.scheme === 'file') {
      await fs.promises.writeFile(target.fsPath, bytes);
      if (target.toString() === this.uri.toString()) {
        const st = await fs.promises.stat(target.fsPath);
        this.ownWrite = this.lastStat = { size: st.size, mtimeMs: st.mtimeMs };
      }
    } else await vscode.workspace.fs.writeFile(target, bytes);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await this.saveAs(this.uri);
    this.savedPos = this.pos;
    this.fromBackup = false;
    this.changedOnDisk = false;
    this.postMeta(true);
    this.post({ type: 'banner', kind: 'none' });
  }

  async revert(): Promise<void> {
    this.gen++;
    this.pos = this.savedPos = 0;
    this.fromBackup = false;
    this.backupId = undefined;
    await this.reload();
  }

  async backup(dest: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(dest, this.serialize());
    backupUris.set(dest.toString(), dest);
    return {
      id: dest.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(dest);
        } catch {
          /* already gone */
        }
      },
    };
  }

  /** Reload from disk in place (keeps the query; the webview keeps its scroll position). */
  async reload(): Promise<void> {
    this.loadToken.cancel();
    this.queryToken?.cancel();
    if (this.model instanceof ParquetModel) this.model.dispose();
    const prev = this.model;
    const keepHeader = prev instanceof CsvModel && !prev.headerAuto ? prev.hasHeader : this.headerPref;
    this.headerPref = keepHeader;
    this.gen++;
    this.pos = this.savedPos = 0;
    this.changedOnDisk = false;
    this.backupId = undefined;
    this.fromBackup = false;
    this.ready = false;
    this.view = null;
    this.vv++;
    this.post({ type: 'banner', kind: 'none' });
    await this.load();
    this.postMeta(true, true);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Watching the file

  private startWatching(): void {
    if (this.uri.scheme !== 'file' || this.watcher || this.disposed) return;
    try {
      this.watcher = fs.watch(this.uri.fsPath, { persistent: false }, () => this.scheduleCheck());
      this.watcher.on('error', () => undefined);
    } catch {
      /* polling only */
    }
    this.updateWatching();
  }

  /** Poll while visible (cheap stat, ≤ 1 s) — fs.watch is unreliable on network filesystems. */
  updateWatching(): void {
    const want = this.visible && !this.disposed && this.uri.scheme === 'file';
    if (want && !this.poll) {
      this.poll = setInterval(() => this.scheduleCheck(), this.kind === 'log' ? 1000 : 2000);
      this.poll.unref?.();
    }
    else if (!want && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private scheduleCheck(): void {
    if (this.changeCheck || !this.loaded) return;
    void this.checkDisk();
  }

  /** Compare the file on disk with what is loaded (serialized: one check at a time). */
  async checkDisk(): Promise<void> {
    while (this.changeCheck) await this.changeCheck;
    this.changeCheck = this.checkDiskNow().finally(() => (this.changeCheck = undefined));
    return this.changeCheck;
  }

  private async checkDiskNow(): Promise<void> {
    if (this.disposed || !this.loaded || this.uri.scheme !== 'file') return;
    const st = await statOf(this.uri.fsPath);
    if (!st || !this.lastStat) return;
    if (st.size === this.lastStat.size && st.mtimeMs === this.lastStat.mtimeMs) return;
    if (this.ownWrite && st.size === this.ownWrite.size && st.mtimeMs === this.ownWrite.mtimeMs) return;
    if (this.kind === 'log') {
      if (!this.follow || !this.visible) return;
      const before = this.model.count();
      const ok = this.rows ? await this.rows.append(this.loadToken).catch(() => false) : false;
      this.lastStat = st;
      if (!ok) return void (await this.reload());
      if (this.model.count() !== before) {
        if (this.view) await this.extendView(before);
        this.postMeta(true);
      }
      return;
    }
    this.lastStat = st;
    if (this.dirty) {
      this.changedOnDisk = true;
      this.post({ type: 'banner', kind: 'changed' });
      return;
    }
    await this.reload();
  }

  /** Logs in follow mode with an active filter: filter the appended lines into the view. */
  private async extendView(from: number): Promise<void> {
    const n = this.model.count();
    const added: number[] = [];
    const sub = new Uint32Array(n - from);
    for (let i = 0; i < sub.length; i++) sub[i] = from + i;
    const lm = this.model as LogModel;
    const q = this.query;
    const mask = q.levels ?? 0x7f;
    const spec = q.text ? compileSpec({ q: q.text, regex: !!q.regex, matchCase: !!q.matchCase, word: !!q.word }, 'log') : undefined;
    const test = spec && !('error' in spec) ? spec.test : undefined;
    await lm.scan(sub, [0], new Slicer(), (_p, id, vals) => {
      if (!(mask & (1 << lm.levels[id]))) return;
      if (test && !cellsMatching(lm, id, vals[0] ?? '', [0], test).length) return;
      added.push(id);
    });
    if (added.length) this.view = concatU32(this.view!, added);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.updateWatching();
    if (v) this.scheduleCheck();
  }

  dispose(): void {
    this.disposed = true;
    this.loadToken.cancel();
    this.queryToken?.cancel();
    this.searchToken?.cancel();
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    if (this.model instanceof ParquetModel) this.model.dispose();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Export

  async exportTo(target: vscode.Uri, format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'markdown', progress?: (f: number) => void): Promise<number> {
    const keys = this.viewCols.length ? this.viewCols.filter((k) => this.model.columns.some((c) => c.key === k)) : this.model.columns.map((c) => c.key);
    const names = this.header(keys);
    const n = this.viewCount();
    const idx = keys.map((k) => this.model.columns.findIndex((c) => c.key === k));
    const chunks: string[] = [];
    const out = target.scheme === 'file' ? fs.createWriteStream(target.fsPath) : undefined;
    const write = async (s: string) => {
      if (out) {
        if (!out.write(s)) await new Promise<void>((r) => out.once('drain', () => r()));
      } else chunks.push(s);
    };
    const jsonTypes = keys.map((k) => this.model.colType(k));
    const toJson = (r: RowData) => {
      const o: Record<string, unknown> = {};
      idx.forEach((i, j) => {
        const v = r.c[i] ?? '';
        const kind = r.k?.[i];
        o[names[j]] = kind ? jsonValue(v, kind) : typedValue(v, jsonTypes[j]);
      });
      return o;
    };
    if (format === 'csv' || format === 'tsv') await write(serializeRow(names, format === 'csv' ? ',' : '\t') + '\n');
    if (format === 'markdown') await write(toMarkdown(names, []));
    if (format === 'json') await write('[\n');
    for (let p = 0; p < n; p += 5000) {
      const rows = await this.model.getRows(this.viewIds(p, Math.min(n, p + 5000)), true);
      let s = '';
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        const vals = idx.map((i) => (i >= 0 ? (r.c[i] ?? '') : ''));
        if (format === 'csv') s += serializeRow(vals, ',') + '\n';
        else if (format === 'tsv') s += vals.map(tsvField).join('\t') + '\n';
        else if (format === 'markdown') s += toMarkdown(names, [vals]).split('\n')[2] + '\n';
        else if (format === 'jsonl') s += JSON.stringify(toJson(r)) + '\n';
        else s += '  ' + JSON.stringify(toJson(r)) + (p + k < n - 1 ? ',' : '') + '\n';
      }
      await write(s);
      progress?.(Math.min(1, (p + 5000) / n));
    }
    if (format === 'json') await write(']\n');
    if (out) await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    else await vscode.workspace.fs.writeFile(target, Buffer.from(chunks.join('')));
    return n;
  }
}

export function pickDelimiter(name: string, setting: string, head: Uint8Array): string {
  if (setting && setting !== 'auto' && DELIMS.includes(setting)) return setting;
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'tsv' || ext === 'tab') return '\t';
  if (ext === 'psv') return '|';
  return sniffDelimiter(Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString('utf8'), ',');
}

function jsonValue(v: string, kind: string): unknown {
  switch (kind) {
    case 'n': {
      const x = Number(v);
      return Number.isSafeInteger(x) || !/^-?\d+$/.test(v) ? x : v;
    }
    case 'b':
      return v === 'true';
    case 'z':
    case 'u':
      return null;
    case 'o':
    case 'a':
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    default:
      return v;
  }
}

function typedValue(v: string, t: string): unknown {
  if (v === '') return null;
  if (t === 'int' || t === 'float') {
    const x = Number(v);
    if (!isNaN(x) && (t === 'float' || Number.isSafeInteger(x))) return x;
  }
  if (t === 'bool') return /^true$/i.test(v) ? true : /^false$/i.test(v) ? false : v;
  return v;
}

export function formatRows(format: CopyFormat, header: string[], rows: string[][], withHeader: boolean, delim: string): string {
  switch (format) {
    case 'csv': {
      const d = delim === '\t' ? ',' : delim;
      const lines = rows.map((r) => serializeRow(r, d));
      if (withHeader) lines.unshift(serializeRow(header, d));
      return lines.join('\n');
    }
    case 'markdown':
      return toMarkdown(header, rows);
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))),
        null,
        2,
      );
    default: {
      const lines = rows.map((r) => r.map(tsvField).join('\t'));
      if (withHeader) lines.unshift(header.map(tsvField).join('\t'));
      return lines.join('\n');
    }
  }
}

function composite(label: string, parts: Change[]): Composite {
  return {
    label,
    undo: () => {
      for (let i = parts.length - 1; i >= 0; i--) parts[i].undo();
    },
    redo: () => {
      for (const p of parts) p.redo();
    },
  };
}

function concatU32(a: Uint32Array, b: number[]): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function insertU32(a: Uint32Array, at: number, b: number[]): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  out.set(a.subarray(0, at));
  out.set(b, at);
  out.set(a.subarray(at), at + b.length);
  return out;
}

async function statOf(p: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const st = await fs.promises.stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

