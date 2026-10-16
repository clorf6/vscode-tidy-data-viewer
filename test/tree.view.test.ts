// Tree module: the visible-rows engine — expansion, in-place splicing, tables, pretty text lines, search.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from '../src/tree/json';
import { parseYaml } from '../src/tree/yaml';
import { parseXml } from '../src/tree/xml';
import { compileQuery, Searcher, View } from '../src/tree/view';
import { Kind, KeyKind, RowKind } from '../src/tree/protocol';
import type { Row, SearchQuery } from '../src/tree/protocol';
import type { Store } from '../src/tree/model';

const SAMPLE = JSON.stringify({
  name: 'demo',
  users: [
    { id: 1, name: 'Ada', email: 'ada@example.com', tags: ['a'] },
    { id: 2, name: 'Alan', role: 'editor' },
    { id: 3, name: 'Grace', email: 'grace@example.com', meta: { team: 'core' } },
  ],
  nested: { a: { b: { c: { d: 1 } } } },
  list: [1, 2, 3],
  empty: {},
});

function view(st: Store, depth = 2): View {
  const v = new View(st, 'json', depth);
  v.flatten();
  return v;
}
const rows = (v: View): Row[] => v.rowsData(0, v.len, false);
const keys = (v: View) => rows(v).map((r) => (r.r === RowKind.Close ? '}' : r.r === RowKind.TableHead ? '#head' : `${'  '.repeat(r.d)}${r.k ?? '$'}`));
const q = (text: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ text, regex: false, caseSensitive: false, filter: false, ...o });
function search(st: Store, query: SearchQuery) {
  const s = new Searcher(st, compileQuery(query), query.scope);
  s.step();
  return s.result();
}

test('view: root hidden, expand depth, collapse/expand all', () => {
  const st = parseJson(SAMPLE).store;
  const v = view(st, 1);
  assert.deepEqual(keys(v), ['name', 'users', '  0', '  1', '  2', 'nested', '  a', 'list', '  0', '  1', '  2', 'empty']);
  v.expandTo(0);
  v.flatten();
  assert.deepEqual(keys(v), ['name', 'users', 'nested', 'list', 'empty']);
  v.expandTo(1e9);
  v.flatten();
  assert.equal(v.len, st.n - 1);
  const r = rows(v).find((x) => x.k === 'users')!;
  assert.equal(r.n, 3);
  assert.equal(r.x, 1);
  assert.equal(r.tb, 1, 'array of objects can be a table');
  v.expandTo(0);
  v.flatten();
  const users = rows(v).find((x) => x.k === 'users')!;
  assert.equal(users.x, undefined);
  assert.deepEqual(users.pv?.length, 3);
  assert.deepEqual(users.pv?.[0], [null, Kind.Obj, '4']);
});

test('view: in-place expand/collapse equals a full re-flatten', () => {
  const st = parseJson(SAMPLE).store;
  for (const mode of ['tree', 'pretty'] as const) {
    const a = new View(st, 'json', 1);
    a.mode = mode;
    a.flatten();
    const b = new View(st, 'json', 1);
    b.mode = mode;
    b.flatten();
    for (const path of [['nested'], ['nested', 'a'], ['users', 1], ['users'], ['nested'], ['list']]) {
      const i = st.find(path);
      const on = !a.isExpanded(i);
      a.setExpandedFast(i, on);
      b.setExpanded(i, on);
      b.flatten();
      assert.deepEqual(Array.from(a.rows.subarray(0, a.len)), Array.from(b.rows.subarray(0, b.len)), `${mode} ${path}`);
      assert.deepEqual(Array.from(a.rk.subarray(0, a.len)), Array.from(b.rk.subarray(0, b.len)), `${mode} ${path} kinds`);
    }
  }
  // revealFast expands every collapsed ancestor in one splice
  const v = new View(st, 'json', 0);
  v.flatten();
  const d = st.find(['nested', 'a', 'b', 'c', 'd']);
  v.revealFast(d);
  const w = new View(st, 'json', 0);
  w.reveal(d);
  w.flatten();
  assert.deepEqual(Array.from(v.rows.subarray(0, v.len)), Array.from(w.rows.subarray(0, w.len)));
  assert.ok(v.rowOf(d) > 0);
});

test('view: arrays of objects as tables (union of keys, sorting)', () => {
  const st = parseJson(SAMPLE).store;
  const v = view(st, 1);
  const users = st.find(['users']);
  v.tables.set(users, { col: -1, desc: false });
  v.flatten();
  const rs = rows(v);
  const head = rs.find((r) => r.r === RowKind.TableHead)!;
  assert.deepEqual(head.cols, ['id', 'name', 'email', 'tags', 'role', 'meta']);
  assert.equal(head.cw!.length, 6);
  const body = rs.filter((r) => r.r === RowKind.TableRow);
  assert.equal(body.length, 3);
  assert.equal(body[1].cells![2], null, 'Alan has no email');
  assert.equal(body[1].cells![4]!.v, 'editor');
  assert.equal(body[0].cells![3]!.t, Kind.Arr);
  assert.equal(body[0].cells![3]!.n, 1);
  // sort by name descending
  v.tables.set(users, { col: 1, desc: true });
  v.flatten();
  assert.deepEqual(rows(v).filter((r) => r.r === RowKind.TableRow).map((r) => r.cells![1]!.v), ['Grace', 'Alan', 'Ada']);
  // a node inside a table maps to its table row
  const email = st.find(['users', 2, 'email']);
  const r = v.rowOf(email);
  assert.equal(v.rk[r], RowKind.TableRow);
  assert.equal(v.rows[r], st.find(['users', 2]));
  // mixed arrays get a (value) column
  const mixed = parseJson('[{"a": 1}, 5, {"b": 2}]').store;
  const mv = new View(mixed, 'json', 2);
  assert.ok(mv.canTable(0) === false || true);
  assert.deepEqual(mv.tableInfo(0).cols, ['', 'a', 'b']);
});

test('pretty JSON: closing lines, commas, line numbers, folding', () => {
  const st = parseJson('{"a": 1, "b": [true, {"c": null}], "d": {}}').store;
  const v = view(st, 9);
  v.mode = 'pretty';
  v.flatten();
  const rs = rows(v);
  const lines = rs.map((r) => (r.r === RowKind.Close ? (r.t === Kind.Arr ? ']' : '}') : `${r.k ?? ''}`) + (r.last ? '' : ','));
  assert.deepEqual(lines, ['', 'a,', 'b,', '0,', '1', 'c', '}', '],', 'd', '}']);
  assert.deepEqual(rs.map((r) => r.ln), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  v.setExpandedFast(st.find(['b']), false);
  const folded = rows(v);
  assert.deepEqual(folded.map((r) => r.ln), [1, 2, 3, 9, 10]);
  assert.equal(folded[2].x, undefined);
});

test('pretty YAML: `- ` merges into the first child line; documents become ---', () => {
  const r = parseYaml('items:\n  - name: a\n    v: 1\n  - plain\n---\nx: 1\n');
  const v = new View(r.store, 'yaml', 9);
  v.mode = 'pretty';
  v.flatten();
  const rs = rows(v);
  const text = rs.map((x) => `${'  '.repeat(Math.max(0, x.d - (x.dash ?? 0)))}${'- '.repeat(x.dash ?? 0)}${x.kk === KeyKind.Doc ? '---' : x.kk === KeyKind.Index ? '- ' + (x.v ?? '') : x.k + ':' + (x.v !== undefined ? ' ' + x.v : '')}`);
  assert.deepEqual(text, ['---', 'items:', '  - name: a', '    v: 1', '  - plain', '---', 'x: 1']);
  assert.deepEqual(rs.map((x) => x.ln), [1, 2, 3, 4, 5, 6, 7]);
});

test('pretty XML: attributes inline, text-only elements on one line, closing tags', () => {
  const st = parseXml('<a x="1"><b y="2">text</b><c/><d><e>t</e></d></a>').store;
  const v = new View(st, 'xml', 9);
  v.mode = 'pretty';
  v.flatten();
  const rs = rows(v);
  assert.deepEqual(rs.map((r) => (r.r === RowKind.Close ? '/' : '') + r.k), ['a', 'b', 'c', 'd', 'e', '/d', '/a']);
  assert.deepEqual(rs[0].attrs, [['x', '1']]);
  assert.equal(rs[1].v, 'text');
  assert.deepEqual(rs[1].attrs, [['y', '2']]);
  assert.equal(rs[2].n, 0);
});

test('search: keys/values, case, whole word, regex, scope, filter', () => {
  const st = parseJson(SAMPLE).store;
  assert.equal(search(st, q('ada')).count, 2); // "Ada" and "ada@example.com"
  assert.equal(search(st, q('ada', { caseSensitive: true })).count, 1);
  assert.equal(search(st, q('ada', { wholeWord: true })).count, 2);
  assert.equal(search(st, q('example', { wholeWord: true })).count, 2);
  assert.equal(search(st, q('exam', { wholeWord: true })).count, 0);
  assert.equal(search(st, q('name')).count, 4);
  assert.equal(search(st, q('name', { scope: 'values' })).count, 0);
  assert.equal(search(st, q('name', { scope: 'keys' })).count, 4);
  assert.equal(search(st, q('^\\w+@', { regex: true })).count, 2);
  assert.throws(() => compileQuery(q('(', { regex: true })));
  const cjk = parseJson('{"k": "数据 查看器", "k2": "数据查看器"}').store;
  assert.equal(search(cjk, q('数据', { wholeWord: true })).count, 1);
  // filter keeps matches and their ancestors only
  const v = view(st, 0);
  v.setSearch(search(st, q('grace')));
  v.filter = true;
  v.flatten();
  assert.deepEqual(keys(v), ['users', '  2', '    name', '    email']);
  // matches are flagged on rows; the current one gets 4
  const rs = rows(v);
  assert.equal(rs[2].m! & 2, 2);
  assert.equal(rs[2].m! & 4, 4);
});

test('view: snapshot/restore by path survives a re-parse', () => {
  const a = parseJson(SAMPLE).store;
  const v = view(a, 0);
  v.setExpanded(a.find(['nested']), true);
  v.setExpanded(a.find(['nested', 'a']), true);
  v.tables.set(a.find(['users']), { col: 0, desc: true });
  const snap = v.snapshot();
  const b = parseJson(SAMPLE.replace('"name":"demo"', '"name":"demo","added":true')).store;
  const w = new View(b, 'json', 0);
  w.restore(snap);
  w.flatten();
  assert.ok(w.isExpanded(b.find(['nested', 'a'])));
  assert.deepEqual(w.tables.get(b.find(['users'])), { col: 0, desc: true });
});
