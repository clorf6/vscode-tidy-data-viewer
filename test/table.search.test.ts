// Table module: find engine. The raw-text (Latin-1 / byte-level) prefilter must never miss a cell that the plain
// per-cell check finds — compared here against a naive scan on files with quotes, multi-line cells, CJK, accents and
// JSON \u escapes. Also: wrap-around order, cancellation, and that the host is never blocked for long.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { TableDocument } from '../src/table/document';
import type { ToView } from '../src/table/protocol';
import { compileSpec, searchRows } from '../src/table/search';
import { Slicer, Token } from '../src/table/sched';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-search-'));
const host = { fireEdit() {}, config: <T>(_k: string, d: T) => d };

async function load(name: string, content: string): Promise<{ doc: TableDocument; sent: ToView[] }> {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  const doc = new TableDocument(vscode.Uri.file(f), host);
  const sent: ToView[] = [];
  doc.attach((m) => sent.push(m));
  await doc.load();
  await doc.handle({ type: 'ready' });
  return { doc, sent };
}

async function hitsOf(doc: TableDocument, q: string, o: { regex?: boolean; matchCase?: boolean; word?: boolean; from?: number; keys?: number[] } = {}) {
  const c = compileSpec({ q, regex: !!o.regex, matchCase: !!o.matchCase, word: !!o.word }, doc.kind, (doc.model as { unicodeEscapes?: boolean }).unicodeEscapes);
  assert.ok(c && !('error' in c));
  const out: string[] = [];
  const mode = await searchRows(doc.model, { view: doc.view, ascending: !doc.query.sort }, c, { keys: o.keys ?? doc.model.columns.map((x) => x.key), from: o.from ?? 0, onRow: (p, _id, cols) => void cols.forEach((li) => out.push(p + ':' + li)) }, new Slicer());
  return { out, mode };
}

/** Naive reference: every cell of every row, display values, the cell-level test only. */
async function naive(doc: TableDocument, q: string, o: { regex?: boolean; matchCase?: boolean; word?: boolean } = {}) {
  const c = compileSpec({ q, regex: !!o.regex, matchCase: !!o.matchCase, word: !!o.word }, 'parquet');
  assert.ok(c && !('error' in c));
  const n = doc.viewCount();
  const rows = await doc.model.getRows(doc.viewIds(0, n), true);
  const out: string[] = [];
  rows.forEach((r, p) =>
    r.c.forEach((v, li) => {
      const kind = r.k?.[li];
      if (kind === 'u' || kind === 'z') return;
      if (v !== '' && c.test(v)) out.push(p + ':' + li);
    }),
  );
  return out;
}

const WORDS = ['alpha', 'Été', 'été', 'ÉTÉ', '北京', '上海', 'naïve', 'Straße', 'say "hi"', 'a,b', 'tab\there', 'x\\y', 'path/to', 'Tokyo', 'tokyo', 'TOKYO', '😀 smile', 'line1\nline2'];
function rnd(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

test('CSV: fast prefilter finds exactly what a naive per-cell scan finds', async () => {
  const r = rnd(42);
  const lines = ['id,a,b,c'];
  for (let i = 0; i < 3000; i++) {
    const cell = () => {
      const w = WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.3 ? ' ' + WORDS[Math.floor(r() * WORDS.length)] : '');
      return /[",\n\t]/.test(w) ? '"' + w.replace(/"/g, '""') + '"' : w;
    };
    lines.push(`${i},${cell()},${cell()},${cell()}`);
  }
  const { doc } = await load('mix.csv', lines.join('\r\n') + '\r\n');
  const queries: [string, { regex?: boolean; matchCase?: boolean; word?: boolean }][] = [
    ['tokyo', {}],
    ['Tokyo', { matchCase: true }],
    ['été', {}],
    ['ÉTÉ', { matchCase: true }],
    ['北京', {}],
    ['say "hi"', {}],
    ['"', {}],
    ['a,b', {}],
    ['straße', {}],
    ['😀', {}],
    ['line1\nline2', {}],
    ['alpha', { word: true }],
    ['al.ha', { regex: true }],
    ['^Tok', { regex: true }],
    ['t[o0]ky[o0]', { regex: true }],
    ['北.', { regex: true }],
  ];
  for (const [q, o] of queries) {
    const { out, mode } = await hitsOf(doc, q, o);
    const ref = await naive(doc, q, o);
    assert.deepEqual(out.sort(), ref.sort(), `query ${JSON.stringify(q)} ${JSON.stringify(o)} (${mode})`);
  }
  const { mode } = await hitsOf(doc, 'tokyo');
  assert.equal(mode, 'fast');
  doc.dispose();
});

test('JSONL with \\u escapes (Python json.dumps default) still matches CJK queries', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ id: i, city: ['北京', 'Paris', 'São Paulo', 'say "hi"'][i % 4], note: 'a/b' }).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  const { doc } = await load('esc.jsonl', lines.join('\n') + '\n');
  assert.equal((doc.model as { unicodeEscapes?: boolean }).unicodeEscapes, true);
  for (const q of ['北京', 'são', 'say "hi"', 'a/b', 'paris']) {
    const { out } = await hitsOf(doc, q);
    const ref = await naive(doc, q);
    assert.deepEqual(out.sort(), ref.sort(), q);
    assert.ok(out.length > 0, q);
  }
  doc.dispose();
});

test('logs: ANSI-colored lines and carriage-return progress lines are searched as displayed', async () => {
  const lines = ['\x1b[31mERROR\x1b[0m [main] failed hard', 'progress 10%\rprogress 100% done', 'INFO plain line', '\x1b[1mbold\x1b[0m text ERROR [main]'];
  const { doc } = await load('a.log', lines.join('\n') + '\n');
  assert.deepEqual((await hitsOf(doc, 'ERROR [main]')).out.sort(), ['0:0', '3:0']);
  assert.deepEqual((await hitsOf(doc, '100% done')).out, ['1:0']);
  assert.deepEqual((await hitsOf(doc, '10%')).out, [], 'overwritten progress states are not shown, so not found');
  doc.dispose();
});

test('logs: chunk-level ANSI stripping finds exactly what the per-line display text contains', async () => {
  const r = rnd(11);
  const bits = ['ER\x1b[31mROR', 'ERROR', '\x1b]8;;http://x\x07link\x1b]8;;\x07', '\x1b]0;title', '北\x1b[1m京', 'step 12', '\rstep 99', 'a\x08b', '\x1b[2K\r', 'ok', ' '];
  const lines: string[] = [];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let k = 0, n = 1 + Math.floor(r() * 5); k < n; k++) s += bits[Math.floor(r() * bits.length)];
    lines.push(s);
  }
  const { doc } = await load('mix.log', lines.join(r() < 2 ? '\r\n' : '\n') + '\n');
  for (const q of ['ERROR', 'error', '北京', 'link', 'title', 'step 1', 'step 99', 'ab', 'ok ok']) {
    const got = await hitsOf(doc, q);
    assert.equal(got.mode, 'fast');
    assert.deepEqual(got.out, await naive(doc, q), q);
  }
  const re = await hitsOf(doc, 'st.p \\d+', { regex: true });
  assert.deepEqual(re.out, await naive(doc, 'st.p \\d+', { regex: true }));
  doc.dispose();
});

test('find streams the first hit early, wraps from the start row, and is cancellable', async () => {
  const lines = ['k,v'];
  for (let i = 0; i < 200000; i++) lines.push(`${i},${i % 1000 === 0 ? 'needle' : 'hay'}`);
  const { doc, sent } = await load('big.csv', lines.join('\n') + '\n');
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  await doc.handle({ type: 'search', id: 1, q: 'needle', regex: false, matchCase: false, word: false, keys: [0, 1], from: 150000 });
  h.disable();
  const res = sent.filter((m) => m.type === 'searchResult' && m.id === 1) as Extract<ToView, { type: 'searchResult' }>[];
  assert.ok(res.length >= 2, 'a partial result came before the final one');
  assert.equal(res[0].hits[0], 150000, 'first hit is at/after the start row');
  const all = res.flatMap((m) => m.hits).filter((_, i) => i % 2 === 0);
  assert.equal(all.length, 200);
  assert.ok(all.indexOf(0) > all.indexOf(199000), 'wrapped around to the top');
  assert.ok(doc.timings.searchFirstHit < 200, 'first hit fast: ' + doc.timings.searchFirstHit);
  assert.ok(h.max / 1e6 < 200, 'event loop never blocked long: ' + (h.max / 1e6).toFixed(1) + ' ms');
  // a new search cancels the running one
  const p1 = doc.handle({ type: 'search', id: 2, q: 'hay', regex: false, matchCase: false, word: false, keys: [1], from: 0 });
  const p2 = doc.handle({ type: 'search', id: 3, q: 'needle', regex: false, matchCase: false, word: false, keys: [1], from: 0 });
  await Promise.all([p1, p2]);
  assert.ok(!sent.some((m) => m.type === 'searchResult' && m.id === 2 && m.done), 'superseded search never completes');
  assert.ok(sent.some((m) => m.type === 'searchResult' && m.id === 3 && m.done));
  // sort and search together: the sorted view uses the row path and still finds everything
  await doc.applyQuery({ filters: [], sort: { key: 0, dir: 'desc' } });
  const { out, mode } = await hitsOf(doc, 'needle');
  assert.equal(mode, 'rows');
  assert.equal(out.length, 200);
  assert.equal(out[0], '999:1', 'positions are view positions (descending ids)');
  doc.dispose();
});

test('cancelled token stops a search', async () => {
  const lines = ['k'];
  for (let i = 0; i < 400000; i++) lines.push('row ' + i);
  const { doc } = await load('c.csv', lines.join('\n'));
  const tok = new Token();
  const c = compileSpec({ q: 'row', regex: false, matchCase: false, word: false }, 'csv')!;
  let n = 0;
  const p = searchRows(doc.model, { view: null, ascending: true }, c as never, { keys: [0], from: 0, onRow: () => void (++n === 10 && tok.cancel()) }, new Slicer(tok, 0, 1));
  await assert.rejects(p);
  assert.ok(n < 400000, 'stopped early: ' + n);
  doc.dispose();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
