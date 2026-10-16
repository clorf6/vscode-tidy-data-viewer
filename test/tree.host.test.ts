// Tree module host: the custom text editor end to end against the vscode stand-in — open → expand → edit →
// the TextDocument changes minimally and the view follows; search, copy, commands, errors, open-as-text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { appliedEdits, commands, createTestPanel, customEditors, env, registry, TestTextDocument } from './vscode-mock';
import { registerTreeEditor } from '../src/tree/provider';
import type { HostMsg, Row, SearchMsg, ViewMsg } from '../src/tree/protocol';

const ctx = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;
registerTreeEditor(ctx);
const provider = customEditors.get('dataViewer.tree')!.provider as vscode.CustomTextEditorProvider;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(text: string, path: string, lang = 'json') {
  const doc = new TestTextDocument(text, path, lang);
  const panel = createTestPanel();
  await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, { isCancellationRequested: false } as vscode.CancellationToken);
  await panel.receive({ type: 'ready' });
  const last = <T extends HostMsg['type']>(type: T) => [...panel.sent].reverse().find((m) => m.type === type) as Extract<HostMsg, { type: T }>;
  const view = () => last('view') as ViewMsg;
  const row = (k: string | number) => view().rows.find((r: Row) => r.k === k)!;
  return { doc, panel, last, view, row };
}

test('host: open → view with init strings, status and the first window of rows', async () => {
  const { panel, view, row } = await open('{\n  "a": 1,\n  "b": {"c": [1, 2]},\n  "s": "x"\n}\n', '/w/data.json');
  assert.equal(panel.sent[0].type, 'init');
  assert.ok(Object.keys(panel.sent[0].strings).length > 50);
  assert.ok(panel.webview.html.includes('tree.js') && panel.webview.html.includes('tree.css'));
  const v = view();
  assert.equal(v.status.format, 'json');
  assert.equal(v.status.errors.length, 0);
  assert.equal(v.status.nodes, 7);
  assert.equal(v.total, 6); // a, b, c, 1, 2, s (depth 2)
  assert.equal(row('b').n, 1);
  assert.ok(v.status.canFormat && v.status.canMinify && v.status.canSort);
});

test('host: expand/collapse, depth, edit → minimal document change → re-render keeps state', async () => {
  const src = '{\n  // settings\n  "name": "demo",\n  "nested": {\n    "deep": {"x": 1}\n  },\n  "list": [1, 2]\n}\n';
  const { doc, panel, view, row } = await open(src, '/w/settings.data.json');
  await panel.receive({ type: 'depth', depth: 0 });
  assert.equal(view().total, 3);
  await panel.receive({ type: 'toggle', id: row('nested').id, expand: true });
  assert.equal(view().total, 4);
  assert.equal(row('deep').x, undefined);
  // set a value: only the literal changes
  const before = appliedEdits.length;
  await panel.receive({ type: 'edit', edit: { op: 'set', id: row('name').id, value: 'renamed', type: 'string' } });
  assert.equal(appliedEdits.length, before + 1);
  assert.deepEqual(appliedEdits[appliedEdits.length - 1].edits, [{ start: src.indexOf('"demo"'), end: src.indexOf('"demo"') + 6, text: '"renamed"' }]);
  assert.equal(doc.getText(), src.replace('"demo"', '"renamed"'));
  await sleep(60);
  // re-parsed: expansion kept, selection on the edited node
  assert.equal(view().total, 4);
  assert.equal(row('name').v, 'renamed');
  assert.equal(view().selId, row('name').id);
  // rename a key: the comment above stays, and the renamed node keeps its expansion
  await panel.receive({ type: 'edit', edit: { op: 'rename', id: row('nested').id, key: 'inner' } });
  await sleep(60);
  assert.ok(doc.getText().includes('// settings\n  "name": "renamed",\n  "inner": {'));
  assert.equal(row('inner').x, 1);
  // add, delete
  await panel.receive({ type: 'edit', edit: { op: 'add', id: row('list').id, value: '3', type: 'number' } });
  await sleep(60);
  assert.ok(doc.getText().includes('"list": [1, 2, 3]'));
  await panel.receive({ type: 'edit', edit: { op: 'delete', id: row('inner').id } });
  await sleep(60);
  assert.equal(doc.getText(), '{\n  // settings\n  "name": "renamed",\n  "list": [1, 2, 3]\n}\n');
  // invalid input is refused with a notice, nothing applied
  const n = appliedEdits.length;
  await panel.receive({ type: 'edit', edit: { op: 'set', id: row('name').id, value: 'abc', type: 'number' } });
  assert.equal(appliedEdits.length, n);
  assert.equal([...panel.sent].reverse().find((m) => m.type === 'notice')?.text, 'Not a valid number');
});

test('host: external text changes re-render; broken text keeps the last good tree read-only', async () => {
  const { doc, view, row } = await open('{"a": 1, "b": [1]}', '/w/ext.json');
  doc.setText('{"a": 1, "b": [1], "c": true}');
  await sleep(60);
  assert.equal(row('c').t, 4);
  doc.setText('{"a": 1, "b": [1], "c": tru');
  await sleep(60);
  const v = view();
  assert.ok(v.status.stale);
  assert.ok(v.status.errors.length >= 1);
  assert.equal(v.status.errors[0].line, 1);
  assert.ok(v.status.readOnly);
  assert.equal(row('c').t, 4, 'still the last valid tree');
  assert.equal(row('c').ro, 1);
});

test('host: search streams counts, jumps to the first hit and navigates', async () => {
  const data = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, label: i % 50 === 0 ? `needle ${i}` : `hay ${i}` })) };
  const { panel, view, last } = await open(JSON.stringify(data, null, 2), '/w/search.json');
  await panel.receive({ type: 'depth', depth: 0 });
  await panel.receive({ type: 'search', query: { text: 'NEEDLE', regex: false, caseSensitive: false, filter: false } });
  const s = last('search') as SearchMsg;
  assert.equal(s.count, 6);
  assert.equal(s.current, 0);
  assert.ok(!s.busy);
  // the first match was revealed (ancestors expanded) and selected
  const v = view();
  const sel = v.rows.find((r) => r.id === v.selId);
  assert.equal(sel?.v, 'needle 0');
  await panel.receive({ type: 'searchNav', dir: 1 });
  assert.equal((last('search') as SearchMsg).current, 1);
  await panel.receive({ type: 'searchNav', dir: -1 });
  await panel.receive({ type: 'searchNav', dir: -1 });
  assert.equal((last('search') as SearchMsg).current, 5);
  // filter: only matching branches
  await panel.receive({ type: 'search', query: { text: 'needle', regex: false, caseSensitive: false, filter: true } });
  assert.equal(view().total, 1 + 6 + 6); // items + 6 elements + 6 labels
  await panel.receive({ type: 'search', query: { text: '', regex: false, caseSensitive: false, filter: false } });
  assert.equal((last('search') as SearchMsg).count, 0);
});

test('host: copy value / path / YAML, commands, YAML and INI editing', async () => {
  const { panel, row } = await open('{"server": {"host": "a.example.com", "ports": [80, 443]}}', '/w/copy.json');
  await panel.receive({ type: 'copyNode', id: row('host').id, what: 'path', style: 'jq' });
  assert.equal(env.clipboard.text, '.server.host');
  await panel.receive({ type: 'copyNode', id: row('server').id, what: 'yaml' });
  assert.equal(env.clipboard.text, 'host: a.example.com\nports:\n  - 80\n  - 443\n');
  await panel.receive({ type: 'copyNode', id: row('host').id, what: 'value' });
  assert.equal(env.clipboard.text, 'a.example.com');
  // palette commands act on the active tree editor
  await commands.executeCommand('dataViewer.tree.format');
  await sleep(60);
  const y = await open('b: 1  # one\na:\n  - x\n', '/w/c.yaml', 'yaml');
  await y.panel.receive({ type: 'edit', edit: { op: 'set', id: y.row('b').id, value: '2', type: 'number' } });
  await sleep(60);
  assert.equal(y.doc.getText(), 'b: 2  # one\na:\n  - x\n');
  await commands.executeCommand('dataViewer.tree.sortKeys');
  await sleep(60);
  assert.equal(y.doc.getText(), 'a:\n  - x\nb: 2 # one\n');
  const ini = await open('[db]\nhost = x\n', '/w/a.ini', 'ini');
  assert.equal(ini.view().layout, 'ini');
  await ini.panel.receive({ type: 'edit', edit: { op: 'set', id: ini.row('host').id, value: 'db.local', type: 'string' } });
  assert.equal(ini.doc.getText(), '[db]\nhost = db.local\n');
  // find focuses the active editor's search box
  await commands.executeCommand('dataViewer.tree.find');
  assert.equal(ini.panel.sent[ini.panel.sent.length - 1].type, 'focusSearch');
});

test('host: format command rewrites JSON with the configured indent', async () => {
  registry.config['tree.indent'] = 4;
  const { doc, panel } = await open('{"a":[1,{"b":2}]}', '/w/fmt.json');
  await panel.receive({ type: 'action', name: 'format' });
  assert.equal(doc.getText(), '{\n    "a": [\n        1,\n        {\n            "b": 2\n        }\n    ]\n}');
  await sleep(60);
  await panel.receive({ type: 'action', name: 'minify' });
  assert.equal(doc.getText(), '{"a":[1,{"b":2}]}');
  delete registry.config['tree.indent'];
});

test('host: config files open as text', async () => {
  const doc = new TestTextDocument('{}', '/w/package.json');
  const panel = createTestPanel();
  let disposed = false;
  panel.onDidDispose(() => (disposed = true));
  registry.config['openAsTextPatterns'] = ['**/package.json'];
  await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  assert.ok(registry.executed.includes('vscode.openWith'));
  assert.ok(disposed);
  delete registry.config['openAsTextPatterns'];
});
