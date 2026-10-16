// Tree module: a ~48 MB JSON document (just under VS Code's 50 MB extension sync limit) — parse time, memory, view
// operations and whole-document search, with the slice sizes the host uses (nothing may block for long).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { JsonParser } from '../src/tree/json';
import { compileQuery, Searcher, View } from '../src/tree/view';
import type { SearchQuery } from '../src/tree/protocol';

const DIR = '/tmp/claude-1024/-home-songlin7/15d2b370-5738-4b55-8dc7-0ba68d7091ed/scratchpad/tree';
const FILE = path.join(DIR, 'perf48.json');
const TARGET = 48 * 1024 * 1024;

function generate(): string {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'kappa', 'lambda', 'sigma', 'omega', '北京', '数据'];
  const w = () => words[Math.floor(rnd() * words.length)];
  const parts: string[] = [];
  let size = 4;
  for (let i = 0; size < TARGET; i++) {
    const o = {
      id: i,
      uuid: 'u-' + Math.floor(rnd() * 1e12).toString(36),
      name: w() + ' ' + w(),
      active: rnd() > 0.5,
      score: Math.round(rnd() * 10000) / 100,
      created_at: new Date(1.6e12 + rnd() * 1e11).toISOString(),
      url: 'https://example.com/items/' + i,
      color: '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0'),
      tags: [w(), w(), w()],
      meta: { owner: { id: Math.floor(rnd() * 1000), email: w() + '@example.com' }, nested: { a: [1, 2, { b: null }], note: 'Line one\nLine two "quoted" \\ backslash' } },
      description: Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => w()).join(' '),
    };
    const s = '  ' + JSON.stringify(o, null, 2).replace(/\n/g, '\n  ');
    parts.push(s);
    size += s.length + 2;
  }
  parts[parts.length - 1] = parts[parts.length - 1].replace('"zeta', '"needle-at-the-end zeta');
  return '[\n' + parts.join(',\n') + '\n]\n';
}

const text = (() => {
  if (fs.existsSync(FILE) && fs.statSync(FILE).size > TARGET * 0.9) return fs.readFileSync(FILE, 'utf8');
  fs.mkdirSync(DIR, { recursive: true });
  const t = generate();
  fs.writeFileSync(FILE, t);
  return t;
})();

const q = (t: string): SearchQuery => ({ text: t, regex: false, caseSensitive: false, filter: false });

test('perf: 48 MB JSON parses in slices, stays compact, views and searches fast', () => {
  assert.ok(text.length < 50 * 1024 * 1024, 'under the 50 MB sync limit');
  const heap0 = process.memoryUsage();
  let t0 = performance.now();
  const p = new JsonParser(text);
  let slices = 0;
  let maxSlice = 0;
  for (;;) {
    const s0 = performance.now();
    const done = p.step(25);
    maxSlice = Math.max(maxSlice, performance.now() - s0);
    slices++;
    if (done) break;
  }
  const r = p.result();
  const parseMs = performance.now() - t0;
  const st = r.store;
  assert.equal(r.errors.length, 0);
  const mem = process.memoryUsage();
  const storeBytes = [st.kind, st.kk, st.depth, st.parent, st.last, st.count, st.pos, st.vs, st.ve, st.ks, st.ke].reduce((n, a) => n + a.byteLength, 0);

  t0 = performance.now();
  const v = new View(st, 'json', 2);
  v.flatten();
  const flattenMs = performance.now() - t0;
  const rowsAtDepth2 = v.len;

  // toggling a node near the top of a 1.3 M row view splices rows in place
  t0 = performance.now();
  const first = st.find([0]);
  v.setExpandedFast(first, false);
  v.setExpandedFast(first, true);
  const toggleMs = (performance.now() - t0) / 2;
  t0 = performance.now();
  const rows = v.rowsData(700_000, 700_400, false);
  const windowMs = performance.now() - t0;
  assert.equal(rows.length, 400);

  // search: common term (first hit immediately), rare term at the very end (full scan), in 20 ms slices
  const timeSearch = (term: string) => {
    const s = new Searcher(st, compileQuery(q(term)));
    const start = performance.now();
    let firstHit = -1;
    let longest = 0;
    for (;;) {
      const a = performance.now();
      const done = s.step(20);
      longest = Math.max(longest, performance.now() - a);
      if (firstHit < 0 && s.found) firstHit = performance.now() - start;
      if (done) break;
    }
    return { firstHit, total: performance.now() - start, longest, count: s.found, res: s.result() };
  };
  const common = timeSearch('kappa');
  const rare = timeSearch('needle-at-the-end');
  assert.equal(rare.count, 1);
  // reveal the rare hit (deep at the end) in place
  v.expandTo(0);
  v.flatten();
  t0 = performance.now();
  const hit = rare.res.matches[0];
  v.revealFast(hit);
  const rowOfHit = v.rowOf(hit);
  const revealMs = performance.now() - t0;
  assert.ok(rowOfHit > 0);

  const report = {
    sizeMB: +(Buffer.byteLength(text) / 1048576).toFixed(1),
    nodes: st.n,
    parseMs: Math.round(parseMs),
    parseSlices: slices,
    longestParseSliceMs: Math.round(maxSlice),
    storeMB: +(storeBytes / 1048576).toFixed(1),
    heapDeltaMB: Math.round((mem.heapUsed - heap0.heapUsed) / 1048576),
    arrayBuffersMB: Math.round(mem.arrayBuffers / 1048576),
    flattenDepth2Ms: Math.round(flattenMs),
    rowsAtDepth2,
    toggleMs: +toggleMs.toFixed(1),
    window400RowsMs: +windowMs.toFixed(1),
    searchCommon: { firstHitMs: +common.firstHit.toFixed(1), totalMs: Math.round(common.total), longestSliceMs: Math.round(common.longest), count: common.count },
    searchRare: { firstHitMs: Math.round(rare.firstHit), totalMs: Math.round(rare.total), longestSliceMs: Math.round(rare.longest) },
    revealDeepHitMs: +revealMs.toFixed(1),
  };
  console.log('tree perf', JSON.stringify(report));
  fs.writeFileSync(path.join(DIR, 'perf-report.json'), JSON.stringify(report, null, 2));
  // budgets (generous for shared CI machines; typical numbers are well below)
  assert.ok(parseMs < 6000, `parse ${parseMs}`);
  assert.ok(maxSlice < 60, `parse slice ${maxSlice}`);
  assert.ok(common.firstHit < 200, `first hit ${common.firstHit}`);
  assert.ok(rare.total < 3000, `full search ${rare.total}`);
  assert.ok(common.longest < 60 && rare.longest < 60, 'search slices');
  assert.ok(toggleMs < 50, `toggle ${toggleMs}`);
  assert.ok(revealMs < 80, `reveal ${revealMs}`);
});

test('perf: the host session opens 48 MB and answers a search without blocking the event loop', async () => {
  const vscode = await import('vscode');
  const { createTestPanel, customEditors, TestTextDocument } = await import('./vscode-mock');
  const { registerTreeEditor } = await import('../src/tree/provider');
  if (!customEditors.has('dataViewer.tree')) registerTreeEditor({ subscriptions: [], extensionUri: vscode.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext);
  const provider = customEditors.get('dataViewer.tree')!.provider;
  const doc = new TestTextDocument(text, '/w/perf48.json');
  const panel = createTestPanel();
  // event-loop probe: the longest gap between 2 ms ticks while the host works
  let last = performance.now();
  let worst = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 2);
  await provider.resolveCustomTextEditor(doc, panel, {});
  let t0 = performance.now();
  await panel.receive({ type: 'ready' });
  const openMs = performance.now() - t0;
  const openWorst = worst;
  worst = 0;
  last = performance.now();
  const sent0 = panel.sent.length;
  t0 = performance.now();
  let firstHitMs = -1;
  const origPost = panel.webview.postMessage;
  panel.webview.postMessage = async (m: { type: string; current?: number }) => {
    if (firstHitMs < 0 && m.type === 'search' && (m.current ?? -1) >= 0) firstHitMs = performance.now() - t0;
    return origPost(m);
  };
  await panel.receive({ type: 'search', query: { text: 'needle-at-the-end', regex: false, caseSensitive: false, filter: false } });
  const rareMs = performance.now() - t0;
  const rareFirst = firstHitMs;
  firstHitMs = -1;
  t0 = performance.now();
  await panel.receive({ type: 'search', query: { text: 'lambda', regex: false, caseSensitive: false, filter: false } });
  const commonMs = performance.now() - t0;
  const searchWorst = worst;
  clearInterval(probe);
  const msgs = panel.sent.slice(sent0);
  const final = msgs.filter((m) => m.type === 'search').pop();
  assert.ok(final && final.count > 1000 && !final.busy);
  const report = { openMs: Math.round(openMs), openLongestBlockMs: Math.round(openWorst), rareFirstHitMs: Math.round(rareFirst), rareTotalMs: Math.round(rareMs), commonFirstHitMs: Math.round(firstHitMs), commonTotalMs: Math.round(commonMs), commonCount: final.count, searchLongestBlockMs: Math.round(searchWorst) };
  console.log('tree host perf', JSON.stringify(report));
  fs.writeFileSync(path.join(DIR, 'perf-host-report.json'), JSON.stringify(report, null, 2));
  assert.ok(firstHitMs < 200, `first hit ${firstHitMs}`);
  assert.ok(commonMs < 1500, `full count ${commonMs}`);
  assert.ok(searchWorst < 80, `blocked ${searchWorst}`);
});
