// Markdown editor, host level: the custom text editor provider with the vscode mock. `markdown.api.render` (VS Code's
// own engine in real life) is stubbed by markdown-it + our plugin + the preview's source-map rule.
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { appliedEdits, createTestPanel, customEditors, extensions, registry, TestTextDocument, visibleRangesEmitter } from './vscode-mock';
import { registerMarkdownEditor } from '../src/markdown/editor';
import { extendMarkdownIt } from '../src/markdown/plugin';
import type { ToView } from '../src/markdown/protocol';
import { replaceCell, splitLines } from '../src/markdown/source';

const md = extendMarkdownIt(new MarkdownIt({ html: true }));
md.core.ruler.push('source_map_data_attribute', (state) => {
  for (const t of state.tokens)
    if (t.map && t.type !== 'inline') {
      t.attrSet('data-line', String(t.map[0]));
      t.attrJoin('class', 'code-line');
    }
});
let renders = 0;
vscode.commands.registerCommand('markdown.api.render', (d: { getText(): string } | string) => (renders++, md.render(typeof d === 'string' ? d : d.getText())));

const store = new Map<string, unknown>();
const ctx = {
  subscriptions: [] as { dispose(): void }[],
  extensionUri: vscode.Uri.file('/ext'),
  globalState: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v) },
} as unknown as vscode.ExtensionContext;
const provider = registerMarkdownEditor(ctx);

const opened: string[] = [];
Object.assign(vscode.env, { openExternal: async (u: vscode.Uri) => (opened.push(u.toString()), true) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => unknown, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(3);
  }
}

type Panel = ReturnType<typeof createTestPanel>;
const rendersOf = (p: Panel) => p.sent.filter((m: ToView) => m.type === 'render') as Extract<ToView, { type: 'render' }>[];
const lastRender = (p: Panel) => rendersOf(p).at(-1)!;

let n = 0;
async function open(text: string) {
  const doc = new TestTextDocument(text, `/ws/docs/note${++n}.md`, 'markdown');
  const panel = createTestPanel();
  await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel);
  await panel.receive({ type: 'ready' });
  await until(() => rendersOf(panel).length);
  return { doc, panel };
}
async function nextRender(panel: Panel, after: number) {
  await until(() => rendersOf(panel).length > after);
  return lastRender(panel);
}

test('registers the editor (find widget on, no hidden-context retention) and its commands', () => {
  const reg = customEditors.get('dataViewer.markdown');
  assert.ok(reg);
  assert.equal(reg!.options.webviewOptions.enableFindWidget, true);
  assert.equal(reg!.options.webviewOptions.retainContextWhenHidden, false);
  for (const c of ['dataViewer.markdown.editSource', 'dataViewer.markdown.showPreview']) assert.ok(registry.commands.has(c), c);
});

test('page shell: strict CSP with a nonce, preview styles, our script; the render carries source and line ranges', async () => {
  extensions.all.push({ id: 'vscode.markdown-language-features', extensionUri: vscode.Uri.file('/vsc/mlf'), packageJSON: { contributes: { 'markdown.previewStyles': ['./media/markdown.css', './media/highlight.css'] } } });
  const { panel } = await open('# Title\n\nSome *text*.\n\n![pic](<img/a b.png>)\n\n<script>alert(1)</script>\n<p onclick="x()">raw</p>\n');
  const html = panel.webview.html;
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9]+'/);
  assert.doesNotMatch(csp.split(';').find((p) => p.includes('script-src'))!, /unsafe/);
  assert.match(html, /md-editor\.js/);
  assert.match(html, /media\/md-editor\.css/);
  assert.match(html, /\/vsc\/mlf\/(\.\/)?media\/markdown\.css[\s\S]*\/vsc\/mlf\/(\.\/)?media\/highlight\.css[\s\S]*md-editor\.css/, 'preview styles first, in order');
  assert.match(html, /<body class="vscode-body dv-md-editor/);
  const r = lastRender(panel);
  assert.equal(r.source.split('\n')[0], '# Title');
  assert.match(r.html, /<h1 data-line-end="1" data-line="0" class="code-line" id="title">/);
  const src = /<img src="([^"]+)"/.exec(r.html)![1];
  assert.equal(path.posix.normalize(src.replace(/^file:/, '')), '/ws/docs/img/a b.png', 'relative image → document folder (webview URI)');
  assert.doesNotMatch(r.html, /<script|onclick/);
});

test('task checkbox: clickable in the editor; toggling edits exactly that line and re-renders', async () => {
  const { doc, panel } = await open('Intro\n\n- [ ] first\n- [x] second\n  - [ ] third\n');
  const r0 = lastRender(panel);
  assert.match(r0.html, /<input type="checkbox" class="task-list-item-checkbox" aria-checked="false" data-task-line="2">/);
  const before = rendersOf(panel).length;
  await panel.receive({ type: 'toggleTask', line: 4, checked: true });
  assert.equal(doc.getText(), 'Intro\n\n- [ ] first\n- [x] second\n  - [x] third\n');
  const r1 = await nextRender(panel, before);
  assert.match(r1.html, /checked aria-checked="true" data-task-line="4"/);
  await panel.receive({ type: 'toggleTask', line: 3, checked: false });
  assert.equal(splitLines(doc.getText())[3], '- [ ] second');
  // a line that is no longer a task: refused, nothing edited
  const edits = appliedEdits.length;
  await panel.receive({ type: 'toggleTask', line: 0, checked: true });
  assert.equal(appliedEdits.length, edits);
  assert.ok(panel.sent.some((m: ToView) => m.type === 'refused'));
});

test('block edits replace exactly their lines; stale ranges are refused and the text goes to the clipboard', async () => {
  const { doc, panel } = await open('# A\n\npara one\nline two\n\n> quote\n\nlast line');
  await panel.receive({ type: 'editLines', start: 2, end: 4, original: 'para one\nline two', text: 'new para' });
  assert.equal(doc.getText(), '# A\n\nnew para\n\n> quote\n\nlast line');
  // block at the end of a file without a final newline
  await panel.receive({ type: 'editLines', start: 6, end: 7, original: 'last line', text: 'final\nwords' });
  assert.equal(doc.getText(), '# A\n\nnew para\n\n> quote\n\nfinal\nwords');
  // delete a block
  await panel.receive({ type: 'editLines', start: 4, end: 5, original: '> quote', text: '' });
  assert.equal(doc.getText(), '# A\n\nnew para\n\n\nfinal\nwords');
  // stale: the lines no longer read what the webview showed
  const edits = appliedEdits.length;
  await panel.receive({ type: 'editLines', start: 2, end: 3, original: 'para one', text: 'clobber' });
  assert.equal(appliedEdits.length, edits);
  assert.equal((vscode.env.clipboard as unknown as { text: string }).text, 'clobber');
  assert.match((panel.sent.filter((m: ToView) => m.type === 'refused').at(-1) as { message: string }).message, /changed while you were editing/);
});

test('table cell edits rewrite one row line (escaped pipes kept); CRLF documents keep CRLF', async () => {
  const { doc, panel } = await open('| a | b |\r\n|---|---|\r\n| x \\| y | 2 |\r\n');
  const row = splitLines(doc.getText())[2];
  await panel.receive({ type: 'editLines', start: 2, end: 3, original: row, text: replaceCell(row, 1, '3|4') });
  assert.equal(doc.getText(), '| a | b |\r\n|---|---|\r\n| x \\| y | 3\\|4 |\r\n');
  await panel.receive({ type: 'editLines', start: 0, end: 1, original: '| a | b |', text: '| A | B |\n' + '| new | row |' });
  assert.equal(doc.getText(), '| A | B |\r\n| new | row |\r\n|---|---|\r\n| x \\| y | 3\\|4 |\r\n');
});

test('external edits (a text editor beside) re-render after a short debounce', async () => {
  const { doc, panel } = await open('one');
  const before = rendersOf(panel).length;
  doc.setText('one\n\ntwo');
  doc.setText('one\n\ntwo\n\nthree');
  const r = await nextRender(panel, before);
  await sleep(160);
  assert.equal(rendersOf(panel).length, before + 1, 'coalesced');
  assert.match(r.html, /three/);
});

test('links: web links open externally, relative Markdown opens in this editor, commands never run', async () => {
  const { panel } = await open('x');
  await panel.receive({ type: 'openLink', href: 'https://example.com/a?b=1' });
  assert.deepEqual(opened.slice(-1), ['https:https://example.com/a?b=1']);
  registry.executed.length = 0;
  await panel.receive({ type: 'openLink', href: 'other.md#intro' });
  assert.ok(registry.executed.includes('vscode.openWith'));
  assert.equal([...provider.pendingFragments.values()].at(-1), 'intro');
  const count = opened.length;
  registry.executed.length = 0;
  await panel.receive({ type: 'openLink', href: 'command:workbench.action.quit' });
  await panel.receive({ type: 'openLink', href: '#local' });
  assert.equal(opened.length, count);
  assert.deepEqual(registry.executed, []);
});

test('scroll sync both ways, without echoing', async () => {
  const { doc, panel } = await open('a\n\nb\n\nc\n\nd\n\ne');
  const revealed: number[] = [];
  const editor = { document: doc, viewColumn: 2, revealRange: (r: vscode.Range) => revealed.push(r.start.line) };
  (vscode.window as unknown as { visibleTextEditors: unknown[] }).visibleTextEditors = [editor];
  // webview scrolled → the text editor follows
  await panel.receive({ type: 'revealLine', line: 6.4 });
  assert.deepEqual(revealed, [6]);
  // …and the visible-range change that causes is not sent back
  visibleRangesEmitter.fire({ textEditor: editor, visibleRanges: [{ start: { line: 6 } }] });
  assert.ok(!panel.sent.some((m: ToView) => m.type === 'scrollTo'));
  await sleep(450);
  // the user scrolls the text editor → the webview follows, and its own scroll echo is ignored
  visibleRangesEmitter.fire({ textEditor: editor, visibleRanges: [{ start: { line: 2 } }] });
  assert.deepEqual(panel.sent.filter((m: ToView) => m.type === 'scrollTo').at(-1), { type: 'scrollTo', line: 2 });
  await panel.receive({ type: 'revealLine', line: 2 });
  assert.deepEqual(revealed, [6]);
  (vscode.window as unknown as { visibleTextEditors: unknown[] }).visibleTextEditors = [];
});

test('UI preferences (outline, reading width) persist for the next editor', async () => {
  const a = await open('# x');
  const b = await open('# y');
  await a.panel.receive({ type: 'ui', ui: { outline: true, wide: false } });
  assert.deepEqual(provider.ui, { outline: true, wide: false });
  assert.ok(b.panel.sent.some((m: ToView) => m.type === 'ui' && m.ui.outline));
  const c = await open('# z');
  assert.match(c.panel.webview.html, /data-ui="\{&quot;outline&quot;:true/);
});
