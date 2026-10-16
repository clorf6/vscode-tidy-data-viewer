// Table module, host level: provider + document with the vscode mock (open → window request → edit → undo/redo →
// save; queries, find, export, JSONL editing, log follow).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createTestPanel, customEditors, registry } from './vscode-mock';
import { registerTableEditor, TableEditorProvider } from '../src/table/provider';
import type { TableDocument } from '../src/table/document';
import type { RowData, ToView } from '../src/table/protocol';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-host-'));
const ctx = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;
const provider: TableEditorProvider = registerTableEditor(ctx);
const edits: vscode.CustomDocumentEditEvent<TableDocument>[] = [];
provider.onDidChangeCustomDocument((e) => edits.push(e as vscode.CustomDocumentEditEvent<TableDocument>));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(2);
  }
}

async function open(name: string, content: string | Buffer) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  const uri = vscode.Uri.file(f);
  const doc = (await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined } as vscode.CustomDocumentOpenContext)) as TableDocument;
  const panel = createTestPanel();
  await provider.resolveCustomEditor(doc, panel as unknown as vscode.WebviewPanel);
  await panel.receive({ type: 'ready' });
  await until(() => doc.loaded);
  const last = <T extends ToView['type']>(type: T) => [...panel.sent].reverse().find((m) => m.type === type) as Extract<ToView, { type: T }>;
  const rows = async (b = 0, bs = 64): Promise<RowData[]> => {
    const n = panel.sent.length;
    await panel.receive({ type: 'rows', vv: doc.vv, blocks: [b], bs });
    await until(() => panel.sent.slice(n).some((m) => m.type === 'rows' && m.b === b));
    return (panel.sent.slice(n).find((m) => m.type === 'rows' && m.b === b) as Extract<ToView, { type: 'rows' }>).rows;
  };
  return { f, uri, doc, panel, last, rows };
}

test('registers the custom editor and commands', () => {
  assert.ok(customEditors.has('dataViewer.table'));
  assert.equal(customEditors.get('dataViewer.table')!.options.supportsMultipleEditorsPerDocument, false);
  for (const c of ['dataViewer.table.find', 'dataViewer.table.goToRow', 'dataViewer.table.exportAs']) assert.ok(registry.commands.has(c), c);
});

test('CSV: open → init → rows → edit → undo/redo → save preserves style', async () => {
  const src = 'name,qty,note\r\n"Apple",3,"fresh, red"\r\nPear,10,plain\r\nFig,7,"multi\r\nline"\r\n';
  const { f, doc, panel, last, rows } = await open('fruit.csv', src);
  const init = panel.sent.find((m) => m.type === 'init') as Extract<ToView, { type: 'init' }>;
  assert.ok(init, 'init sent');
  assert.equal(init.file.kind, 'csv');
  assert.equal(init.meta.hasHeader, true);
  assert.deepEqual(
    init.meta.columns.map((c) => [c.name, c.type]),
    [
      ['name', 'string'],
      ['qty', 'int'],
      ['note', 'string'],
    ],
  );
  assert.equal(init.meta.eol, 'CRLF');
  assert.equal(doc.editable, true);
  let r = await rows();
  assert.equal(r.length, 3);
  assert.deepEqual(r[2].c, ['Fig', '7', 'multi\r\nline']);

  await panel.receive({ type: 'edit', edit: { op: 'set', row: 1, key: 1, value: '11' } });
  assert.equal(edits.length, 1);
  assert.equal(doc.dirty, true);
  r = await rows();
  assert.equal(r[1].c[1], '11');
  assert.equal(r[1].f, 2);
  edits[0].undo();
  r = await rows();
  assert.equal(r[1].c[1], '10');
  edits[0].redo();
  await provider.saveCustomDocument(doc);
  assert.equal(doc.dirty, false);
  const out = fs.readFileSync(f, 'utf8');
  assert.equal(out, src.replace('Pear,10,plain', 'Pear,11,plain'), 'only the edited row changed; quotes and CRLF kept');
  assert.equal(last('meta').meta.dirty, false);

  // insert + delete rows, insert/rename/delete columns
  await panel.receive({ type: 'edit', edit: { op: 'insertRows', at: 1, count: 1 } });
  await panel.receive({ type: 'edit', edit: { op: 'set', row: 1, key: 0, value: 'Kiwi, gold' } });
  await panel.receive({ type: 'edit', edit: { op: 'deleteRows', rows: [3] } });
  await panel.receive({ type: 'edit', edit: { op: 'renameCol', key: 2, name: 'remark' } });
  await panel.receive({ type: 'edit', edit: { op: 'insertCol', at: 1, name: 'color' } });
  const colorKey = doc.model.columns[1].key;
  await panel.receive({ type: 'edit', edit: { op: 'set', row: 0, key: colorKey, value: 'red' } });
  await provider.saveCustomDocument(doc);
  assert.equal(fs.readFileSync(f, 'utf8'), 'name,color,qty,remark\r\n"Apple",red,3,"fresh, red"\r\n"Kiwi, gold",,,\r\nPear,,11,plain\r\n');
  // undo everything back to the saved-at-11 state
  for (let i = edits.length - 1; i >= 1; i--) edits[i].undo();
  await provider.saveCustomDocument(doc);
  assert.equal(fs.readFileSync(f, 'utf8'), src.replace('Pear,10,plain', 'Pear,11,plain'));
  edits.length = 0;
});

test('CSV: paste block extends the table; clear; copy range formats', async () => {
  const { f, doc, panel } = await open('paste.csv', 'a,b\n1,2\n');
  await panel.receive({ type: 'edit', edit: { op: 'paste', row: 0, keys: [0, 1], rows: [['x', 'y'], ['p', 'q, r']] } });
  await panel.receive({ type: 'edit', edit: { op: 'clear', rows: [0], keys: [1] } });
  await provider.saveCustomDocument(doc);
  assert.equal(fs.readFileSync(f, 'utf8'), 'a,b\nx,\np,"q, r"\n');
  await panel.receive({ type: 'copyRange', r0: 0, r1: 2, keys: [0, 1], format: 'markdown', header: true });
  assert.equal((vscode.env.clipboard as unknown as { text: string }).text, '| a | b |\n| --- | --- |\n| x |  |\n| p | q, r |\n');
  await panel.receive({ type: 'copyRange', r0: 0, r1: 2, keys: [0, 1], format: 'json', header: true });
  assert.deepEqual(JSON.parse((vscode.env.clipboard as unknown as { text: string }).text), [
    { a: 'x', b: '' },
    { a: 'p', b: 'q, r' },
  ]);
  edits.length = 0;
});

test('CSV: typed stable sort, filters, stats, find over the whole file', async () => {
  const lines = ['id,score,city'];
  for (let i = 0; i < 5000; i++) lines.push(`${i},${(i * 37) % 101},${['Boston', 'Paris', 'Tokyo'][i % 3]}`);
  const { doc, panel, last, rows } = await open('q.csv', lines.join('\n') + '\n');
  await panel.receive({ type: 'query', query: { filters: [], sort: { key: 1, dir: 'desc' } } });
  let r = await rows(0, 64);
  assert.equal(r[0].c[1], '100');
  // stable: equal scores keep document order
  const same = r.filter((x) => x.c[1] === '100').map((x) => Number(x.c[0]));
  assert.deepEqual(same, [...same].sort((a, b) => a - b));
  await panel.receive({ type: 'query', query: { filters: [{ key: 2, op: 'equals', value: 'Paris' }, { key: 1, op: 'gte', value: '50' }], sort: null } });
  const m = last('meta').meta;
  assert.ok(m.count > 0 && m.count < 5000 / 3);
  r = await rows(0, 64);
  assert.ok(r.every((x) => x.c[2] === 'Paris' && Number(x.c[1]) >= 50));
  await panel.receive({ type: 'stats', key: 1, top: 5 });
  const st = last('stats').stats;
  assert.equal(st.count, m.count);
  assert.ok(st.numeric && st.numeric.min >= 50 && st.numeric.max <= 100);
  // find: whole file, streamed, cell-level hits in view coordinates
  await panel.receive({ type: 'query', query: { filters: [] } });
  const n0 = panel.sent.length;
  await panel.receive({ type: 'search', id: 7, q: 'tokyo', regex: false, matchCase: false, word: false, keys: [0, 1, 2], from: 0 });
  const res = panel.sent.slice(n0).filter((x) => x.type === 'searchResult' && x.id === 7) as Extract<ToView, { type: 'searchResult' }>[];
  assert.ok(res.at(-1)!.done);
  const hits = res.flatMap((x) => x.hits);
  assert.equal(res.at(-1)!.total, Math.ceil((5000 - 2) / 3));
  assert.equal(hits[0], 2);
  assert.equal(hits[1], 2);
  assert.equal(doc.timings.searchMode, 1, 'fast path');
  // starting from a row wraps around
  const n1 = panel.sent.length;
  await panel.receive({ type: 'search', id: 8, q: 'Tokyo', regex: false, matchCase: true, word: true, keys: [2], from: 4000 });
  const res2 = (panel.sent.slice(n1).filter((x) => x.type === 'searchResult' && x.id === 8) as Extract<ToView, { type: 'searchResult' }>[]).flatMap((x) => x.hits);
  assert.equal(res2[0], 4001);
  // invalid regex reports an error
  const n2 = panel.sent.length;
  await panel.receive({ type: 'search', id: 9, q: '([', regex: true, matchCase: false, word: false, keys: [], from: 0 });
  assert.ok((panel.sent.slice(n2).find((x) => x.type === 'searchResult') as Extract<ToView, { type: 'searchResult' }>).error);
  // filter rows to matches (text filter) reuses the engine
  await panel.receive({ type: 'query', query: { filters: [], text: 'bost', keys: [2] } });
  assert.equal(last('meta').meta.count, Math.ceil(5000 / 3));
  // export the view
  const target = path.join(dir, 'out.jsonl');
  const n = await doc.exportTo(vscode.Uri.file(target), 'jsonl');
  assert.equal(n, Math.ceil(5000 / 3));
  const first = JSON.parse(fs.readFileSync(target, 'utf8').split('\n')[0]);
  assert.deepEqual(first, { id: 0, score: 0, city: 'Boston' });
});

test('CSV: header toggle, delimiter sniffing, ragged rows', async () => {
  const { doc, panel, last, rows } = await open('semi.csv', 'a;b;c\n1;2;3\n4;5\n6;7;8;9\n');
  assert.equal(last('meta').meta.delimiter, 'Semicolon');
  assert.equal(doc.model.columns.length, 4, 'columns extended to the widest row');
  assert.match(last('meta').meta.warnings.join(' '), /2 rows/);
  await panel.receive({ type: 'header', value: false });
  const r = await rows();
  assert.equal(r.length, 4);
  assert.deepEqual(r[0].c.slice(0, 3), ['a', 'b', 'c']);
  assert.equal(last('meta').meta.columns[0].name, 'A');
});

test('JSONL: union columns, invalid lines, primitive edits re-serialize one line', async () => {
  const src = '{"id": 1, "name": "a", "big": 12345678901234567890}\n{"id": 2, "extra": {"x": [1, 2]}}\nnot json\n{"id": 3, "name": null}\n';
  const { f, doc, panel, last, rows } = await open('d.jsonl', src);
  await until(() => last('meta').meta.invalid !== undefined);
  assert.equal(last('meta').meta.invalid, 1);
  const cols = doc.model.columns.map((c) => c.name);
  assert.deepEqual(cols.slice(0, 4), ['id', 'name', 'big', 'extra']);
  const r = await rows();
  assert.equal(r[0].c[2], '12345678901234567890', 'big integers keep their digits');
  assert.equal(r[1].c[3], '{"x":[1,2]}');
  assert.equal(r[1].k?.[1], 'u');
  assert.equal(r[2].f, 1, 'invalid line flagged');
  assert.equal(r[3].k?.[1], 'z');
  await panel.receive({ type: 'edit', edit: { op: 'set', row: 0, key: 0, value: '10' } });
  await panel.receive({ type: 'edit', edit: { op: 'set', row: 3, key: 1, value: 'c' } });
  await panel.receive({ type: 'edit', edit: { op: 'renameCol', key: 2, name: 'large' } });
  await provider.saveCustomDocument(doc);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"id": 10, "name": "a", "large": 12345678901234567890}\n{"id": 2, "extra": {"x": [1, 2]}}\nnot json\n{"id": 3, "name": "c"}\n');
  edits.length = 0;
});

test('logs: read-only, levels, level filter + text filter, follow appends', async () => {
  const lines = ['2026-10-15 10:00:00 INFO start', '2026-10-15 10:00:01 \x1b[31mERROR\x1b[0m failed: x', 'Traceback (most recent call last):', '  File "a.py", line 1', '2026-10-15 10:00:02 WARN slow', 'progress\r 50%\r100%'];
  const { f, doc, panel, last, rows } = await open('app.log', lines.join('\n') + '\n');
  assert.equal(doc.editable, false);
  const m = last('meta').meta;
  assert.deepEqual(m.levelCounts, [1, 0, 0, 1, 1, 3, 0]);
  const r = await rows(0, 256);
  assert.equal(r[1].c[0], '2026-10-15 10:00:01 ERROR failed: x');
  assert.ok(r[1].log?.sp?.length);
  assert.deepEqual(r[1].log?.lt, [20, 25]);
  assert.equal(r[5].c[0], '100%');
  await panel.receive({ type: 'query', query: { filters: [], levels: 1 << 5 } });
  assert.equal(last('meta').meta.count, 3);
  await panel.receive({ type: 'query', query: { filters: [], levels: 0x7f, text: 'fail' } });
  assert.equal(last('meta').meta.count, 1);
  await panel.receive({ type: 'query', query: { filters: [] } });
  // follow: appended lines show up
  fs.appendFileSync(f, '2026-10-15 10:00:03 ERROR again\n');
  await doc.checkDisk();
  assert.equal(last('meta').meta.total, lines.length + 1);
  assert.equal(last('meta').meta.levelCounts![5], 4);
  // first/next error navigation
  await panel.receive({ type: 'findLevel', from: -1, dir: 1, mask: 1 << 5, vv: doc.vv });
  assert.equal(last('found').row, 1);
});

test('parquet: schema, rows, sort (read-only)', async (t) => {
  const pq = '/tmp/claude-1024/-home-songlin7/15d2b370-5738-4b55-8dc7-0ba68d7091ed/scratchpad/table/data/small.parquet';
  if (!fs.existsSync(pq)) return t.skip('no parquet sample');
  const { doc, panel, last, rows } = await open('s.parquet', fs.readFileSync(pq));
  const m = last('meta').meta;
  assert.equal(m.total, 5000);
  assert.equal(m.parquet?.rowGroups, 3);
  assert.equal(doc.editable, false);
  const names = m.columns.map((c) => c.name);
  assert.deepEqual(names.slice(0, 4), ['id', 'name', 'price', 'qty']);
  assert.equal(m.columns.find((c) => c.name === 'created')!.type, 'date');
  const r = await rows(0, 64);
  assert.equal(r[0].c[0], '0');
  assert.match(r[0].c[names.indexOf('created')], /^2026-01-01 00:00:00/);
  assert.equal(r[0].k?.[names.indexOf('tags')], 'a');
  await panel.receive({ type: 'query', query: { filters: [], sort: { key: 0, dir: 'desc' } } });
  const r2 = await rows(0, 64);
  assert.equal(r2[0].c[0], '4999');
});

test('UTF-8 BOM + CRLF + quotes survive an edit; undo restores the exact bytes', async () => {
  const src = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名前,值\r\n"a ""q""",1\r\nb,2\r\n', 'utf8')]);
  const { f, doc, panel, rows } = await open('bom.csv', src);
  const r = await rows();
  assert.equal(r[0].c[0], 'a "q"');
  assert.equal(doc.model.columns[0].name, '名前', 'BOM is not part of the first header');
  await panel.receive({ type: 'edit', edit: { op: 'set', row: 1, key: 1, value: '3,5' } });
  await provider.saveCustomDocument(doc);
  const out = fs.readFileSync(f);
  assert.deepEqual([...out.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(out.subarray(3).toString('utf8'), '名前,值\r\n"a ""q""",1\r\nb,"3,5"\r\n');
  edits.at(-1)!.undo();
  await provider.saveCustomDocument(doc);
  assert.deepEqual(fs.readFileSync(f), src);
  edits.length = 0;
});

test('commands: go to row validates input, export writes the picked format', async () => {
  const { dir: _d, doc, panel } = { dir, ...(await open('cmd.csv', 'a,b\n1,x\n2,y\n3,z\n')) };
  const win = vscode.window as unknown as Record<string, unknown>;
  const saved = { showInputBox: win.showInputBox, showQuickPick: win.showQuickPick, showSaveDialog: win.showSaveDialog };
  let validate: ((s: string) => string | undefined) | undefined;
  win.showInputBox = async (o: { validateInput: (s: string) => string | undefined }) => ((validate = o.validateInput), '2');
  await provider.goToRow(doc);
  assert.ok(validate!('9'), 'out of range rejected');
  assert.equal(validate!('3'), undefined);
  assert.deepEqual(panel.sent.at(-1), { type: 'goTo', row: 1 });
  const target = path.join(dir, 'cmd.view.md');
  win.showQuickPick = async (items: { id: string }[]) => items.find((i) => i.id === 'markdown');
  win.showSaveDialog = async () => vscode.Uri.file(target);
  await provider.exportAs(doc);
  assert.equal(fs.readFileSync(target, 'utf8'), '| a | b |\n| --- | --- |\n| 1 | x |\n| 2 | y |\n| 3 | z |\n');
  Object.assign(win, saved);
});

test('files matching dataViewer.openAsTextPatterns reopen in the text editor', async () => {
  registry.config.openAsTextPatterns = ['**/raw-*.csv'];
  const f = path.join(dir, 'raw-data.csv');
  fs.writeFileSync(f, 'a\n1\n');
  const uri = vscode.Uri.file(f);
  const doc = (await provider.openCustomDocument(uri, { backupId: undefined } as vscode.CustomDocumentOpenContext)) as TableDocument;
  const panel = createTestPanel();
  let disposed = false;
  (panel as unknown as { dispose: () => void }).dispose = () => (disposed = true);
  const n = registry.executed.length;
  await provider.resolveCustomEditor(doc, panel as unknown as vscode.WebviewPanel);
  assert.deepEqual(registry.executed.slice(n), ['vscode.openWith']);
  assert.ok(disposed);
  assert.equal(panel.webview.html, '', 'no webview content was set up');
  delete registry.config.openAsTextPatterns;
  doc.dispose();
});

test('backup and revert', async () => {
  const { f, doc, panel } = await open('b.csv', 'a\n1\n');
  await panel.receive({ type: 'edit', edit: { op: 'set', row: 0, key: 0, value: '2' } });
  const dest = vscode.Uri.file(path.join(dir, 'backup.bin'));
  const b = await provider.backupCustomDocument(doc, { destination: dest } as vscode.CustomDocumentBackupContext);
  assert.equal(fs.readFileSync(dest.fsPath, 'utf8'), 'a\n2\n');
  // reopen from the backup
  const doc2 = (await provider.openCustomDocument(vscode.Uri.file(f), { backupId: b.id } as vscode.CustomDocumentOpenContext)) as TableDocument;
  await until(() => doc2.loaded);
  assert.equal(doc2.dirty, true);
  const [row] = await doc2.model.getRows([doc2.viewId(0)], true);
  assert.equal(row.c[0], '2');
  await provider.revertCustomDocument(doc);
  assert.equal(doc.dirty, false);
  const [row1] = await doc.model.getRows([doc.viewId(0)], true);
  assert.equal(row1.c[0], '1');
  doc.dispose();
  doc2.dispose();
  edits.length = 0;
});

test.after(() => {
  for (const d of provider.panels.keys()) d.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});
