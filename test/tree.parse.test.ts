// Tree module: parsers (JSON/JSONC, YAML, TOML, INI/.env, XML), path formatting and minimal-edit round trips.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yaml';
import * as T from 'smol-toml';
import { applyTextEdits, Store } from '../src/tree/model';
import { allJsonErrors, jsonEdit, jsonFormat, jsonMinify, jsonSortKeys, parseJson, JsonParser } from '../src/tree/json';
import { parseYaml, yamlEdit, yamlFormat, yamlSortKeys } from '../src/tree/yaml';
import { parseToml, tomlEdit } from '../src/tree/toml';
import { parseIni, iniEdit } from '../src/tree/ini';
import { parseXml, toXml } from '../src/tree/xml';
import { formatOf, parseDoc } from '../src/tree/formats';
import { formatPath, jqPath, jsonPath, jsonPointer, jsPath, xPath } from '../src/tree/paths';
import { Kind, KeyKind } from '../src/tree/protocol';

const ctx = { unit: '  ', eol: '\n' };

/** Node id by path, failing loudly. */
function id(st: Store, ...path: (string | number)[]): number {
  const i = st.find(path);
  assert.ok(i >= 0, `path ${JSON.stringify(path)} not found`);
  return i;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON

test('json: structure, keys, values, positions', () => {
  const src = '{\n  "a": 1,\n  "b": [true, false, null, "x\\ny"],\n  "c": {"d": -2.5e3},\n  "esc\\"key": "\\u00e9"\n}\n';
  const { store: st, errors } = parseJson(src);
  assert.equal(errors.length, 0);
  assert.equal(st.n, 10);
  assert.equal(st.kind[0], Kind.Obj);
  assert.equal(st.count[0], 4);
  assert.deepEqual(st.children(0).map((c) => st.key(c)), ['a', 'b', 'c', 'esc"key']);
  const b = id(st, 'b');
  assert.equal(st.kind[b], Kind.Arr);
  assert.deepEqual(st.children(b).map((c) => st.kind[c]), [Kind.True, Kind.False, Kind.Null, Kind.Str]);
  assert.equal(st.text(id(st, 'b', 3)), 'x\ny');
  assert.equal(st.text(id(st, 'c', 'd')), '-2.5e3');
  assert.equal(st.text(id(st, 'esc"key')), 'é');
  assert.equal(st.key(id(st, 'b', 2)), 2);
  assert.equal(src.slice(st.vs[b], st.ve[b]), '[true, false, null, "x\\ny"]');
  assert.deepEqual(st.toValue(0), JSON.parse(src));
  assert.deepEqual(st.path(id(st, 'c', 'd')), ['c', 'd']);
});

test('json: comments, trailing commas and BOM are tolerated', () => {
  const src = '\ufeff// header\n{\n  /* block */ "a": 1, // trailing\n  "b": [1, 2,],\n}\n';
  const r = parseJson(src);
  assert.equal(r.errors.length, 0);
  assert.ok(r.comments);
  assert.ok(r.trailingCommas);
  assert.deepEqual(r.store.toValue(0), { a: 1, b: [1, 2] });
});

test('json: errors carry offsets, the tree is partial, jsonc-parser lists them all', () => {
  const src = '{\n  "a": 1\n  "b": 2,\n  "c": [1, 2\n}';
  const r = parseJson(src);
  assert.ok(r.partial);
  assert.equal(r.errors[0].code, 'CommaExpected');
  assert.equal(src.slice(r.errors[0].offset, r.errors[0].offset + 3), '"b"');
  // the part before the error is there
  assert.equal(r.store.text(r.store.find(['a'])), '1');
  const all = allJsonErrors(src);
  assert.ok(all.length >= 2, JSON.stringify(all));
  assert.equal(all[0].message, 'Comma expected');
  for (const bad of ['{"a": }', '[1 2]', '{"a" 1}', '"unterminated', '{"a": 1}}', '[01x]', '/* open']) assert.ok(parseJson(bad).errors.length, bad);
  assert.equal(parseJson('').errors.length, 0);
  assert.equal(parseJson('  42 ').store.text(0), '42');
});

test('json: resumable parsing in slices gives the same tree', () => {
  const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ i, s: 'x'.repeat(i % 50), n: [i, i * 2, { deep: i % 3 === 0 }] })));
  const p = new JsonParser(big);
  let slices = 0;
  while (!p.step(0.05)) slices++;
  const r = p.result();
  assert.ok(slices > 1);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.store.toValue(0), JSON.parse(big));
});

test('json: long strings decode lazily and truncate safely', () => {
  const s = 'é'.repeat(10) + '\\n'.repeat(500) + 'tail';
  const src = `{"v": "${s}"}`;
  const st = parseJson(src).store;
  const v = id(st, 'v');
  const short = st.text(v, 20);
  assert.equal(short.length, 20);
  assert.ok(short.startsWith('éééééééééé\n'));
  assert.equal(st.text(v), JSON.parse(src).v);
});

test('json edits: set / rename / delete keep comments and formatting', () => {
  const src = '{\n  // the name\n  "name": "demo", // inline\n  "n": 1,\n  "list": [1, 2, 3],\n  "obj": {}\n}\n';
  const st = parseJson(src).store;
  const run = (op: Parameters<typeof jsonEdit>[1]) => applyTextEdits(src, jsonEdit(st, op, ctx));
  assert.equal(run({ op: 'set', id: id(st, 'name'), value: 'new "v"', type: 'string' }), src.replace('"demo"', '"new \\"v\\""'));
  assert.equal(run({ op: 'set', id: id(st, 'n'), value: '2.50', type: 'number' }), src.replace('"n": 1', '"n": 2.50'));
  assert.equal(run({ op: 'set', id: id(st, 'n'), value: 'TRUE', type: 'boolean' }), src.replace('"n": 1', '"n": true'));
  assert.throws(() => run({ op: 'set', id: id(st, 'n'), value: '1x', type: 'number' }), /Not a valid number/);
  assert.equal(run({ op: 'rename', id: id(st, 'n'), key: 'count' }), src.replace('"n": 1', '"count": 1'));
  // delete a middle member: its own line goes, the comment above "name" stays
  assert.equal(run({ op: 'delete', id: id(st, 'n') }), '{\n  // the name\n  "name": "demo", // inline\n  "list": [1, 2, 3],\n  "obj": {}\n}\n');
  // delete the last member: the separator before it goes
  assert.equal(run({ op: 'delete', id: id(st, 'obj') }), '{\n  // the name\n  "name": "demo", // inline\n  "n": 1,\n  "list": [1, 2, 3]\n}\n');
  // delete inside an inline array
  assert.equal(run({ op: 'delete', id: id(st, 'list', 1) }), src.replace('[1, 2, 3]', '[1, 3]'));
  assert.equal(run({ op: 'delete', id: id(st, 'list', 2) }), src.replace('[1, 2, 3]', '[1, 2]'));
  for (const out of [run({ op: 'delete', id: id(st, 'name') }), run({ op: 'delete', id: id(st, 'list', 0) })]) assert.equal(allJsonErrors(out).length, 0, out);
});

test('json edits: add / duplicate / move', () => {
  const src = '{\n  "a": 1,\n  "b": {\n    "x": true\n  },\n  "arr": [\n    "p",\n    "q"\n  ],\n  "inl": [1, 2],\n  "e": {}\n}';
  const st = parseJson(src).store;
  const run = (op: Parameters<typeof jsonEdit>[1]) => {
    const out = applyTextEdits(src, jsonEdit(st, op, ctx));
    assert.equal(allJsonErrors(out).length, 0, out);
    return out;
  };
  assert.equal(run({ op: 'add', id: id(st, 'b'), key: 'y', value: '5', type: 'number' }), src.replace('"x": true\n', '"x": true,\n    "y": 5\n'));
  assert.equal(run({ op: 'add', id: id(st, 'e'), key: 'k', value: 'v', type: 'string' }), src.replace('"e": {}', '"e": {\n    "k": "v"\n  }'));
  assert.equal(run({ op: 'add', id: id(st, 'arr'), value: '', type: 'null' }), src.replace('"q"\n', '"q",\n    null\n'));
  assert.equal(run({ op: 'add', id: id(st, 'arr'), value: '', type: 'object', after: id(st, 'arr', 0) }), src.replace('"p",\n', '"p",\n    {},\n'));
  assert.equal(run({ op: 'add', id: id(st, 'inl'), value: '3', type: 'number' }), src.replace('[1, 2]', '[1, 2, 3]'));
  assert.equal(run({ op: 'duplicate', id: id(st, 'b') }), src.replace('  },\n  "arr"', '  },\n  "b_copy": {\n    "x": true\n  },\n  "arr"'));
  assert.equal(run({ op: 'duplicate', id: id(st, 'arr', 1) }), src.replace('"q"\n', '"q",\n    "q"\n'));
  assert.equal(run({ op: 'move', id: id(st, 'arr', 1), dir: -1 }), src.replace('"p",\n    "q"', '"q",\n    "p"'));
  assert.equal(run({ op: 'move', id: id(st, 'a'), dir: 1 }), src.replace('"a": 1,\n  "b": {\n    "x": true\n  }', '"b": {\n    "x": true\n  },\n  "a": 1'));
  assert.throws(() => jsonEdit(st, { op: 'move', id: id(st, 'e'), dir: 1 }, ctx), /Nothing to swap/);
  assert.throws(() => jsonEdit(st, { op: 'delete', id: 0 }, ctx), /root/);
});

test('json: format, minify, sort keys (comments survive sorting)', () => {
  const src = '{"b":1,/* c */"a":{"z":[3,{"y":1,"x":2}],"m":null}}';
  const formatted = applyTextEdits(src, jsonFormat(src, 2, '\n'));
  assert.ok(formatted.includes('/* c */'));
  assert.ok(formatted.includes('\n    "z": [\n      3,\n      {\n        "y": 1,\n        "x": 2\n      }\n    ],\n    "m": null\n  }\n}'), formatted);
  assert.deepEqual(parseJson(formatted).store.toValue(0), parseJson(src).store.toValue(0));
  assert.equal(jsonMinify('{\n  "a": [1, 2], // x\n  "b": "s p"\n}\n'), '{"a":[1,2],"b":"s p"}\n');
  const pretty = '{\n  // keep me\n  "b": 1,\n  "a": {\n    "z": true,\n    "c": [{"y": 1, "x": 2}]\n  }\n}\n';
  const st = parseJson(pretty).store;
  const sorted = applyTextEdits(pretty, [jsonSortKeys(st)!]);
  assert.equal(sorted, '{\n  // keep me\n  "a": {\n    "c": [{"x": 2, "y": 1}],\n    "z": true\n  },\n  "b": 1\n}\n');
  assert.equal(jsonSortKeys(parseJson(sorted).store), undefined);
  // natural order: item2 < item10
  const nat = parseJson('{"item10":1,"item2":2,"Item1":3}').store;
  assert.equal(applyTextEdits('{"item10":1,"item2":2,"Item1":3}', [jsonSortKeys(nat)!]), '{"Item1":3,"item2":2,"item10":1}');
});

// ---------------------------------------------------------------------------------------------------------------
// Paths

test('paths: JSONPath, JS, jq and JSON Pointer with odd keys', () => {
  const p = ['a', 0, 'b-c', 'd e', "it's", '$ok', '0', 'ü'];
  assert.equal(jsonPath(p), "$.a[0]['b-c']['d e']['it\\'s'].$ok['0']['ü']");
  assert.equal(jsPath(p), 'a[0]["b-c"]["d e"]["it\'s"].$ok["0"]["ü"]');
  assert.equal(jqPath(p), '.a[0]."b-c"."d e"."it\'s"."$ok"."0"."ü"');
  assert.equal(jsonPointer(['a/b', 'c~d', 0]), '/a~1b/c~0d/0');
  assert.equal(jsonPath([]), '$');
  assert.equal(jqPath([]), '.');
  assert.equal(jqPath([3, 'x']), '.[3].x');
  assert.equal(jsPath([3, 'x']), '[3].x');
  const st = parseJson('{"list": [{"k": 1}]}').store;
  assert.equal(formatPath(st, id(st, 'list', 0, 'k'), 'jsonpath'), '$.list[0].k');
  assert.equal(formatPath(st, id(st, 'list', 0, 'k'), 'jq'), '.list[0].k');
});

// ---------------------------------------------------------------------------------------------------------------
// YAML

const YAML_SRC = `# top
name: demo   # trailing
base: &base
  a: 1
  b: two
derived:
  <<: *base
  c: [1, 2, {x: y}]
list:
  - one
  - key: v
    other: 2
quoted: 'single'
dq: "double"
text: |
  line one
  line two
empty:
---
second: doc
`;

test('yaml: multi-document, anchors/aliases, comments, styles', () => {
  const r = parseYaml(YAML_SRC);
  const st = r.store;
  assert.equal(r.errors.length, 0);
  assert.ok(r.multi);
  assert.equal(st.kk[1], KeyKind.Doc);
  assert.equal(st.count[0], 2);
  const base = id(st, 0, 'base');
  assert.equal(st.meta.get(base)?.anchor, 'base');
  const alias = id(st, 0, 'derived', '<<');
  assert.equal(st.kind[alias], Kind.Alias);
  assert.equal(st.text(alias), 'base');
  assert.equal(st.meta.get(alias)?.alias, base);
  assert.equal(st.meta.get(id(st, 0, 'name'))?.comment, 'trailing');
  assert.equal(st.meta.get(id(st, 0, 'quoted'))?.style, 'QUOTE_SINGLE');
  assert.equal(st.meta.get(id(st, 0, 'derived', 'c'))?.style, 'flow');
  assert.equal(st.text(id(st, 0, 'text')), 'line one\nline two\n');
  assert.equal(st.kind[id(st, 0, 'empty')], Kind.Null);
  assert.equal(st.text(id(st, 1, 'second')), 'doc');
  assert.deepEqual(st.toValue(id(st, 0, 'list')), ['one', { key: 'v', other: 2 }]);
});

test('yaml edits: surgical scalar edits keep quoting and comments', () => {
  const r = parseYaml(YAML_SRC);
  const st = r.store;
  const run = (op: Parameters<typeof yamlEdit>[1]) => {
    const out = applyTextEdits(YAML_SRC, yamlEdit(r, op, ctx));
    assert.equal(parseYaml(out).errors.length, 0, out);
    return out;
  };
  assert.equal(run({ op: 'set', id: id(st, 0, 'name'), value: 'new', type: 'string' }), YAML_SRC.replace('name: demo   # trailing', 'name: new   # trailing'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'name'), value: 'true', type: 'string' }), YAML_SRC.replace('name: demo', 'name: "true"'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'name'), value: 'a: b', type: 'string' }), YAML_SRC.replace('name: demo', 'name: "a: b"'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'quoted'), value: "it's", type: 'string' }), YAML_SRC.replace("'single'", "'it''s'"));
  assert.equal(run({ op: 'set', id: id(st, 0, 'dq'), value: 'x"y', type: 'string' }), YAML_SRC.replace('"double"', '"x\\"y"'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'base', 'a'), value: '42', type: 'number' }), YAML_SRC.replace('a: 1', 'a: 42'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'derived', 'c', 2, 'x'), value: 'p,q', type: 'string' }), YAML_SRC.replace('{x: y}', '{x: "p,q"}'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'empty'), value: 'filled', type: 'string' }), YAML_SRC.replace('empty:\n', 'empty: filled\n'));
  assert.equal(run({ op: 'set', id: id(st, 0, 'text'), value: 'a\nb\n', type: 'string' }), YAML_SRC.replace('  line one\n  line two\n', '  a\n  b\n'));
  assert.equal(run({ op: 'rename', id: id(st, 0, 'quoted'), key: 'renamed' }), YAML_SRC.replace('quoted:', 'renamed:'));
  assert.throws(() => yamlEdit(r, { op: 'set', id: id(st, 0, 'derived', '<<'), value: 'x', type: 'string' }, ctx), /Alias/);
});

test('yaml edits: structural edits on block and flow collections', () => {
  const r = parseYaml(YAML_SRC);
  const st = r.store;
  const run = (op: Parameters<typeof yamlEdit>[1]) => {
    const out = applyTextEdits(YAML_SRC, yamlEdit(r, op, ctx));
    assert.equal(parseYaml(out).errors.length, 0, out);
    return out;
  };
  assert.equal(run({ op: 'delete', id: id(st, 0, 'base', 'b') }), YAML_SRC.replace('  b: two\n', ''));
  assert.equal(run({ op: 'delete', id: id(st, 0, 'list', 0) }), YAML_SRC.replace('  - one\n', ''));
  assert.equal(run({ op: 'delete', id: id(st, 0, 'list', 1, 'key') }), YAML_SRC.replace('  - key: v\n    other: 2\n', '  - other: 2\n'));
  assert.equal(run({ op: 'delete', id: id(st, 0, 'derived', 'c', 1) }), YAML_SRC.replace('[1, 2, {x: y}]', '[1, {x: y}]'));
  assert.equal(run({ op: 'add', id: id(st, 0, 'base'), key: 'c', value: '3', type: 'number' }), YAML_SRC.replace('  b: two\n', '  b: two\n  c: 3\n'));
  assert.equal(run({ op: 'add', id: id(st, 0, 'list'), value: 'three', type: 'string' }), YAML_SRC.replace('    other: 2\n', '    other: 2\n  - three\n'));
  assert.equal(run({ op: 'add', id: id(st, 0, 'derived', 'c'), value: '9', type: 'number' }), YAML_SRC.replace('{x: y}]', '{x: y}, 9]'));
  assert.equal(run({ op: 'duplicate', id: id(st, 0, 'base', 'a') }), YAML_SRC.replace('  a: 1\n', '  a: 1\n  a_copy: 1\n'));
  assert.equal(run({ op: 'move', id: id(st, 0, 'base', 'b'), dir: -1 }), YAML_SRC.replace('  a: 1\n  b: two\n', '  b: two\n  a: 1\n'));
  assert.equal(run({ op: 'move', id: id(st, 0, 'list', 0), dir: 1 }), YAML_SRC.replace('  - one\n  - key: v\n    other: 2\n', '  - key: v\n    other: 2\n  - one\n'));
  // last item of a block sequence: the Document API keeps the collection
  const one = 'a:\n  - x\nb: 1\n';
  const r1 = parseYaml(one);
  const out = applyTextEdits(one, yamlEdit(r1, { op: 'delete', id: r1.store.find(['a', 0]) }, ctx));
  assert.deepEqual(Y.parse(out), { a: [], b: 1 });
});

test('yaml: format and sort keys keep comments', () => {
  const src = '# head\nb: 1   # one\na:\n    z: 1\n    y: [2, 1]\n';
  const f = yamlFormat(src, 2);
  assert.equal(f, '# head\nb: 1 # one\na:\n  z: 1\n  y: [ 2, 1 ]\n');
  const s = yamlSortKeys(src);
  assert.ok(s.includes('# one'));
  assert.deepEqual(Object.keys(Y.parse(s)), ['a', 'b']);
  assert.deepEqual(Object.keys(Y.parse(s).a), ['y', 'z']);
  const bad = parseYaml('a: [1, 2\nb: 1\n');
  assert.ok(bad.errors.some((e) => !e.warning));
});

// ---------------------------------------------------------------------------------------------------------------
// TOML

const TOML_SRC = `# manifest
title = "TOML Example"
[owner]
name = "Tom"   # comment
dob = 1979-05-27T07:32:00-08:00
[database]
ports = [ 8000, 8001, 8002 ]
enabled = true
"quoted key" = 'literal'
point = { x = 1, y = 2 }
a.b = 3
[[servers]]
name = "alpha"
[[servers]]
name = "beta"
multi = """
two
lines"""
`;

test('toml: values, tables, arrays of tables, located ranges', () => {
  const r = parseToml(TOML_SRC);
  const st = r.store;
  assert.equal(r.errors.length, 0);
  assert.deepEqual(st.children(0).map((c) => st.key(c)), ['title', 'owner', 'database', 'servers']);
  assert.equal(st.kind[id(st, 'owner', 'dob')], Kind.Date);
  assert.equal(st.text(id(st, 'owner', 'dob')), '1979-05-27T07:32:00-08:00');
  assert.equal(st.text(id(st, 'database', 'quoted key')), 'literal');
  assert.equal(st.count[id(st, 'servers')], 2);
  assert.equal(st.text(id(st, 'servers', 1, 'name')), 'beta');
  assert.equal(st.text(id(st, 'database', 'a', 'b')), '3');
  const name = id(st, 'owner', 'name');
  assert.equal(TOML_SRC.slice(st.vs[name], st.ve[name]), '"Tom"');
  const want = JSON.parse(JSON.stringify(T.parse(TOML_SRC)));
  want.owner.dob = '1979-05-27T07:32:00-08:00'; // dates keep their source spelling
  assert.deepEqual(JSON.parse(JSON.stringify(st.toValue(0))), want);
});

test('toml edits: precise value replacement, keys, lines', () => {
  const r = parseToml(TOML_SRC);
  const st = r.store;
  const run = (op: Parameters<typeof tomlEdit>[1]) => {
    const out = applyTextEdits(TOML_SRC, tomlEdit(r, op, '\n'));
    T.parse(out);
    return out;
  };
  assert.equal(run({ op: 'set', id: id(st, 'owner', 'name'), value: 'Ann "A"', type: 'string' }), TOML_SRC.replace('"Tom"', '"Ann \\"A\\""'));
  assert.equal(run({ op: 'set', id: id(st, 'database', 'ports', 1), value: '9001', type: 'number' }), TOML_SRC.replace('8001', '9001'));
  assert.equal(run({ op: 'set', id: id(st, 'database', 'quoted key'), value: 'lit2', type: 'string' }), TOML_SRC.replace("'literal'", "'lit2'"));
  assert.equal(run({ op: 'set', id: id(st, 'database', 'point', 'y'), value: '5', type: 'number' }), TOML_SRC.replace('y = 2', 'y = 5'));
  assert.equal(run({ op: 'set', id: id(st, 'servers', 1, 'multi'), value: 'one', type: 'string' }), TOML_SRC.replace('"""\ntwo\nlines"""', '"one"'));
  assert.equal(run({ op: 'rename', id: id(st, 'database', 'enabled'), key: 'on' }), TOML_SRC.replace('enabled = true', 'on = true'));
  assert.equal(run({ op: 'delete', id: id(st, 'database', 'enabled') }), TOML_SRC.replace('enabled = true\n', ''));
  assert.equal(run({ op: 'delete', id: id(st, 'database', 'ports', 0) }), TOML_SRC.replace('[ 8000, 8001', '[ 8001'));
  assert.equal(run({ op: 'add', id: id(st, 'owner'), key: 'age', value: '45', type: 'number' }), TOML_SRC.replace('dob = 1979-05-27T07:32:00-08:00\n', 'dob = 1979-05-27T07:32:00-08:00\nage = 45\n'));
  assert.equal(run({ op: 'add', id: 0, key: 'version', value: '1', type: 'string' }), TOML_SRC.replace('title = "TOML Example"\n', 'title = "TOML Example"\nversion = "1"\n'));
  assert.equal(run({ op: 'move', id: id(st, 'database', 'enabled'), dir: -1 }), TOML_SRC.replace('ports = [ 8000, 8001, 8002 ]\nenabled = true\n', 'enabled = true\nports = [ 8000, 8001, 8002 ]\n'));
  assert.throws(() => tomlEdit(r, { op: 'rename', id: id(st, 'database', 'a', 'b'), key: 'c' }, '\n'), /TOML/);
  assert.throws(() => tomlEdit(r, { op: 'set', id: id(st, 'owner', 'name'), value: '', type: 'null' }, '\n'), /null/);
  const bad = parseToml('a = 1\nb = [1,\n');
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].line, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// INI / .env

test('ini: sections, comments, quotes, bare keys, continuation lines', () => {
  const src = '; global\nname = demo\n\n[db]\n# primary\nhost=localhost ; inline\nport: 5432\npass = "a;b"\nflag\n[paths]\nlong = first\n  second\n';
  const r = parseIni(src, false);
  const st = r.store;
  assert.deepEqual(st.children(0).map((c) => st.key(c)), ['name', 'db', 'paths']);
  assert.equal(st.kk[id(st, 'db')], KeyKind.Section);
  assert.equal(st.text(id(st, 'db', 'host')), 'localhost');
  assert.equal(st.meta.get(id(st, 'db', 'host'))?.comment, 'primary · inline');
  assert.equal(st.text(id(st, 'db', 'port')), '5432');
  assert.equal(st.kind[id(st, 'db', 'port')], Kind.Num);
  assert.equal(st.text(id(st, 'db', 'pass')), 'a;b');
  assert.equal(st.kind[id(st, 'db', 'flag')], Kind.Null);
  assert.equal(st.text(id(st, 'paths', 'long')), 'first\nsecond');
  assert.equal(st.meta.get(id(st, 'name'))?.comment, 'global');
});

test('.env: export, quotes, escapes, inline comments, multi-line values', () => {
  const src = '# env\nexport A=1\nB="x\\ny" # note\nC=\'single # not comment\'\nD=plain value # comment\nE=a#b\nF=\nG="multi\nline"\nH=last';
  const r = parseIni(src, true);
  const st = r.store;
  assert.deepEqual(st.children(0).map((c) => st.key(c)), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.equal(st.meta.get(id(st, 'A'))?.tag, 'export');
  assert.equal(st.text(id(st, 'B')), 'x\ny');
  assert.equal(st.meta.get(id(st, 'B'))?.comment, 'note');
  assert.equal(st.text(id(st, 'C')), 'single # not comment');
  assert.equal(st.text(id(st, 'D')), 'plain value');
  assert.equal(st.text(id(st, 'E')), 'a#b');
  assert.equal(st.text(id(st, 'F')), '');
  assert.equal(st.text(id(st, 'G')), 'multi\nline');
  assert.equal(st.text(id(st, 'H')), 'last');
  const run = (op: Parameters<typeof iniEdit>[1]) => applyTextEdits(src, iniEdit(r, op, '\n'));
  assert.equal(run({ op: 'set', id: id(st, 'A'), value: '2', type: 'string' }), src.replace('export A=1', 'export A=2'));
  assert.equal(run({ op: 'set', id: id(st, 'B'), value: 'q"q', type: 'string' }), src.replace('B="x\\ny"', 'B="q\\"q"'));
  assert.equal(run({ op: 'set', id: id(st, 'D'), value: 'has # hash', type: 'string' }), src.replace('D=plain value', 'D="has # hash"'));
  assert.equal(run({ op: 'set', id: id(st, 'F'), value: 'now', type: 'string' }), src.replace('F=\n', 'F=now\n'));
  assert.equal(run({ op: 'rename', id: id(st, 'E'), key: 'E2' }), src.replace('E=a#b', 'E2=a#b'));
  assert.throws(() => iniEdit(r, { op: 'rename', id: id(st, 'E'), key: 'bad key' }, '\n'), /Invalid key/);
  assert.equal(run({ op: 'delete', id: id(st, 'G') }), src.replace('G="multi\nline"\n', ''));
  assert.equal(run({ op: 'add', id: 0, key: 'NEW', value: 'v w', type: 'string' }), src + '\nNEW=v w');
  assert.equal(run({ op: 'duplicate', id: id(st, 'A') }), src.replace('export A=1\n', 'export A=1\nexport A_COPY=1\n'));
  assert.equal(run({ op: 'move', id: id(st, 'C'), dir: -1 }), src.replace('B="x\\ny" # note\nC=\'single # not comment\'\n', 'C=\'single # not comment\'\nB="x\\ny" # note\n'));
});

test('ini edits: add to sections, add a section, delete a section', () => {
  const src = 'top = 1\n\n[a]\nx = 1\ny = 2\n\n[b]\nz = 3\n';
  const r = parseIni(src, false);
  const st = r.store;
  const run = (op: Parameters<typeof iniEdit>[1]) => applyTextEdits(src, iniEdit(r, op, '\n'));
  assert.equal(run({ op: 'add', id: id(st, 'a'), key: 'w', value: '9', type: 'string' }), src.replace('y = 2\n', 'y = 2\nw = 9\n'));
  assert.equal(run({ op: 'add', id: 0, key: 'top2', value: 'v', type: 'string' }), src.replace('top = 1\n', 'top = 1\ntop2 = v\n'));
  assert.equal(run({ op: 'add', id: 0, key: 'c', value: '', type: 'object' }), src + '\n[c]\n');
  assert.equal(run({ op: 'delete', id: id(st, 'a') }), 'top = 1\n\n[b]\nz = 3\n');
  assert.equal(run({ op: 'rename', id: id(st, 'b'), key: 'beta' }), src.replace('[b]', '[beta]'));
});

// ---------------------------------------------------------------------------------------------------------------
// XML

test('xml: elements, attributes, text, CDATA, comments, declaration', () => {
  const src = '<?xml version="1.0"?>\n<!-- c -->\n<root id="r1" flag>\n  <item n="1">one</item>\n  <item>two</item>\n  <data><![CDATA[a <b> c]]></data>\n  <empty/>\n  mixed\n</root>';
  const r = parseXml(src);
  const st = r.store;
  assert.equal(r.errors.length, 0);
  const kids = st.children(0);
  assert.deepEqual(kids.map((c) => [st.kk[c], st.key(c)]), [
    [KeyKind.Decl, '?xml'],
    [KeyKind.Text, '#comment'],
    [KeyKind.Elem, 'root'],
  ]);
  const root = kids[2];
  assert.equal(src.slice(st.vs[root], st.vs[root] + 5), '<root');
  const rk = st.children(root);
  assert.deepEqual(rk.map((c) => String(st.key(c))), ['id', 'flag', 'item', 'item', 'data', 'empty', '#text']);
  assert.equal(st.kk[rk[0]], KeyKind.Attr);
  assert.equal(st.kind[rk[1]], Kind.True);
  assert.equal(st.text(rk[3]), 'two');
  const data = rk[4];
  assert.equal(st.text(st.firstChild(data)), 'a <b> c');
  assert.equal(st.meta.get(st.firstChild(data))?.flavor, 'cdata');
  assert.equal(xPath(st, rk[3]), '/root/item[2]');
  assert.equal(xPath(st, rk[0]), '/root/@id');
  assert.equal(xPath(st, st.firstChild(rk[2])), '/root/item[1]/@n');
  const back = toXml(st, root);
  assert.ok(back.includes('<item n="1">'));
  assert.ok(back.includes('<![CDATA[a <b> c]]>'));
  assert.ok(back.includes('<empty/>'));
  const bad = parseXml('<a><b></a>');
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].line, 1);
});

// ---------------------------------------------------------------------------------------------------------------

test('formats: file names map to parsers', async () => {
  assert.equal(formatOf('/x/a.json'), 'json');
  assert.equal(formatOf('/x/a.geojson'), 'json');
  assert.equal(formatOf('/x/a.YML'), 'yaml');
  assert.equal(formatOf('/x/Cargo.toml'), 'toml');
  assert.equal(formatOf('/x/setup.ini'), 'ini');
  assert.equal(formatOf('/x/.env'), 'env');
  assert.equal(formatOf('/x/.env.local'), 'env');
  assert.equal(formatOf('/x/prod.env'), 'env');
  assert.equal(formatOf('/x/pom.xml'), 'xml');
  const p = await parseDoc('json', '{"a": [1]}');
  assert.ok(p && p.store.n === 3 && p.label === 'json');
  const c = await parseDoc('json', '// x\n{}');
  assert.equal(c?.label, 'jsonc');
});
