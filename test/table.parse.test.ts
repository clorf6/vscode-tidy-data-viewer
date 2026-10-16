// Table module: parsers, sniffing, inference, indexing, log analysis, JSONL scanning and rewriting.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectEol, detectHeader, letterName, parseRow, serializeRow, sniffDelimiter, splitRecords, toMarkdown } from '../src/table/csv';
import { inferJsonType, inferType, numericKey } from '../src/table/infer';
import { collapseCR, detectLevel, detectTimestamp, levelOfRaw, parseAnsi } from '../src/table/log';
import { compactJson, displayValue, inputToRaw, prettyJson, rewriteLine, scanObject } from '../src/table/jsonl';
import { RowIndex, scanRows, SparseIndex } from '../src/table/rowindex';
import { LV_DEBUG, LV_ERROR, LV_FATAL, LV_INFO, LV_NONE, LV_WARN } from '../src/table/protocol';
import { TextRows, isUtf8 } from '../src/table/textrows';
import { mergeSort } from '../src/table/query';
import { compileSpec } from '../src/table/search';
import { Slicer, Token } from '../src/table/sched';

const CSV = { quotes: true, delim: 44, skipBlank: false };

function rowsOf(text: string, o = CSV): string[] {
  const b = Buffer.from(text);
  const out: string[] = [];
  scanRows(b, 0, b.length, 0, true, o, (s, e) => out.push(b.toString('utf8', s, e)));
  return out;
}

test('parseRow: quotes, escaped quotes, empty and trailing fields', () => {
  assert.deepEqual(parseRow('a,b,c', ','), ['a', 'b', 'c']);
  assert.deepEqual(parseRow('"a,1","b ""q""",c', ','), ['a,1', 'b "q"', 'c']);
  assert.deepEqual(parseRow('a,,', ','), ['a', '', '']);
  assert.deepEqual(parseRow('', ','), ['']);
  assert.deepEqual(parseRow('"multi\nline",x', ','), ['multi\nline', 'x']);
  assert.deepEqual(parseRow('5" pipe,2', ','), ['5" pipe', '2'], 'quote inside an unquoted field is literal');
  assert.deepEqual(parseRow('"open', ','), ['open'], 'unterminated quote takes the rest');
  assert.deepEqual(parseRow('"a"x,b', ','), ['ax', 'b'], 'text after a closing quote is kept');
  const q: boolean[] = [];
  parseRow('"a",b', ',', q);
  assert.deepEqual(q, [true, false]);
  assert.deepEqual(parseRow('a\tb\t"c\td"', '\t'), ['a', 'b', 'c\td']);
});

test('serializeRow quotes only what needs quoting (or was quoted)', () => {
  assert.equal(serializeRow(['a', 'b,c', 'say "hi"', 'x\ny', ''], ','), 'a,"b,c","say ""hi""","x\ny",');
  assert.equal(serializeRow(['a', 'b'], ',', [true, false]), '"a",b');
  for (const row of [['1', 'two, three', '"q"'], ['', '', ''], ['tab\there', 'ok']]) assert.deepEqual(parseRow(serializeRow(row, ','), ','), row);
});

test('scanRows: quoted newlines, CRLF, final row without newline', () => {
  assert.deepEqual(rowsOf('a,b\r\n"x\r\ny",2\r\nlast,3'), ['a,b', '"x\r\ny",2', 'last,3']);
  assert.deepEqual(rowsOf('a\n\nb\n'), ['a', '', 'b']);
  assert.deepEqual(rowsOf('a\n\n  \nb\n', { ...CSV, skipBlank: true, quotes: false }), ['a', 'b']);
  assert.deepEqual(rowsOf('h\n5" pipe,1\nnext,2\n'), ['h', '5" pipe,1', 'next,2'], 'a mid-field quote does not swallow newlines');
  assert.deepEqual(rowsOf('"a""\nb",1\nc\n'), ['"a""\nb",1', 'c']);
});

test('scanRows resumes at chunk boundaries (incl. a quote at the very end)', () => {
  const text = 'id,v\n1,"a\nb"\n2,"c""\nd"\n3,x\n';
  const whole = rowsOf(text);
  for (let cut = 1; cut < text.length; cut++) {
    const b = Buffer.from(text);
    const out: string[] = [];
    const emit = (s: number, e: number) => out.push(b.toString('utf8', s, e));
    const next = scanRows(b, 0, cut, 0, false, CSV, emit);
    scanRows(b, next, b.length, 0, true, CSV, emit);
    assert.deepEqual(out, whole, 'cut at ' + cut);
  }
});

test('sniffDelimiter and delimiter-specific header detection', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n4;5;6\n'), ';');
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(sniffDelimiter('a|b|c\n1|2|3\n'), '|');
  assert.equal(sniffDelimiter('name,comment\nx,"a; b; c"\ny,"d; e"\n'), ',');
  assert.equal(sniffDelimiter('single\ncolumn\n'), ',');
  assert.equal(splitRecords('a\n"b\nc"\nd', 10, false).length, 3);
});

test('detectHeader', () => {
  const p = (s: string) => s.trim().split('\n').map((l) => parseRow(l, ','));
  assert.equal(detectHeader(p('id,name,score\n1,a,2.5\n2,b,3')), true);
  assert.equal(detectHeader(p('1,a,2.5\n2,b,3\n3,c,4')), false);
  assert.equal(detectHeader(p('city,country\nParis,France\nTokyo,Japan')), true);
  assert.equal(detectHeader(p('date,value\n2024-01-01,3\n2024-01-02,4')), true);
  assert.equal(detectHeader(p('x,x\na,b')), false, 'duplicate names');
  assert.equal(letterName(0), 'A');
  assert.equal(letterName(25), 'Z');
  assert.equal(letterName(26), 'AA');
});

test('type inference', () => {
  assert.equal(inferType(['1', '2', '-3', '']), 'int');
  assert.equal(inferType(['1', '2.5', '1e3', 'NA']), 'float');
  assert.equal(inferType(['true', 'FALSE']), 'bool');
  assert.equal(inferType(['2024-01-01', '2024-02-03 10:00:00']), 'date');
  assert.equal(inferType(['{"a":1}', '[1]']), 'json');
  assert.equal(inferType(['1', 'x']), 'string');
  assert.equal(inferType(['', ' ']), 'empty');
  assert.equal(inferJsonType(['n', 'n', 'z'], ['1', '2', 'null']), 'int');
  assert.equal(inferJsonType(['o', 'a'], ['{}', '[]']), 'json');
  assert.ok(numericKey('2024-01-02', 'date') > numericKey('2024-01-01', 'date'));
  assert.ok(isNaN(numericKey('', 'int')));
});

test('log lines: levels, timestamps, ANSI, carriage returns', () => {
  assert.equal(detectLevel('2024-01-01 10:00:00 ERROR [main] boom')[0], LV_ERROR);
  assert.equal(detectLevel('[warning] disk almost full')[0], LV_WARN);
  assert.equal(detectLevel('level=debug msg="x"')[0], LV_DEBUG);
  assert.equal(detectLevel('{"level":"info","msg":"x"}')[0], LV_INFO);
  assert.equal(detectLevel('E1015 12:00:00.123 1 main.cc:10] bad')[0], LV_ERROR);
  assert.equal(detectLevel('Traceback (most recent call last):')[0], LV_ERROR);
  assert.equal(detectLevel('ZeroDivisionError: division by zero')[0], LV_ERROR);
  assert.equal(detectLevel('slurmstepd: error: Detected 1 oom-kill event')[0], LV_ERROR);
  assert.equal(detectLevel('CRITICAL something')[0], LV_FATAL);
  assert.equal(detectLevel('no errors here, more info later')[0], LV_NONE);
  assert.equal(detectLevel('INFO got ERROR from upstream')[0], LV_INFO, 'the first level word wins');
  assert.equal(levelOfRaw('  File "x.py", line 3', LV_ERROR), LV_ERROR, 'stack frames inherit');
  assert.equal(levelOfRaw('\x1b[1;31mERROR\x1b[0m failed', 0), LV_ERROR);
  const ts = detectTimestamp('2026-10-15 09:00:00,123 INFO x');
  assert.deepEqual(ts, [0, 23]);
  assert.equal(detectTimestamp('a long message that only mentions the time much later 12:30:00'), undefined);
  const a = parseAnsi('\x1b[32mok\x1b[0m plain \x1b[38;5;196mred\x1b[0m\x1b[K');
  assert.equal(a.text, 'ok plain red');
  assert.deepEqual(a.spans?.map((s) => s.slice(0, 2)), [
    [0, 2],
    [9, 12],
  ]);
  assert.equal(a.spans?.[0][2], '2;;');
  assert.ok(a.spans?.[1][2].startsWith('#ff0000'));
  assert.equal(collapseCR(' 10%|█| 1/10\r 50%|█████| 5/10\r100%|██████████| 10/10'), '100%|██████████| 10/10');
  assert.equal(collapseCR('done\r'), 'done');
});

test('JSONL: lenient scanner keeps raw values (big ints), compact display, rewrite', () => {
  const line = '{"id": 12345678901234567890, "name": "a\\"b", "tags": [1, 2], "meta": {"x": {"y": null}}, "ok": true, "z": null}';
  const m = scanObject(line)!;
  assert.deepEqual(
    m.map((x) => [x.key, x.kind]),
    [
      ['id', 'n'],
      ['name', 's'],
      ['tags', 'a'],
      ['meta', 'o'],
      ['ok', 'b'],
      ['z', 'z'],
    ],
  );
  assert.equal(line.slice(m[0].vs, m[0].ve), '12345678901234567890');
  assert.equal(displayValue(line.slice(m[1].vs, m[1].ve), 's'), 'a"b');
  assert.equal(displayValue(line.slice(m[2].vs, m[2].ve), 'a'), '[1,2]');
  assert.equal(scanObject('[1,2]'), null);
  assert.equal(scanObject('{"id": broken'), null);
  assert.equal(compactJson('{ "a" : [ 1 , "x y" ] }'), '{"a":[1,"x y"]}');
  assert.equal(prettyJson('{"a":[1,2],"b":{}}'), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}');
  // edit a value: formatting of other members is preserved
  const set = new Map([['ok', 'false']]);
  assert.equal(rewriteLine(line, m, { set }), line.replace('"ok": true', '"ok": false'));
  // add + delete members
  const r2 = rewriteLine('{"a": 1, "b": 2}', scanObject('{"a": 1, "b": 2}')!, { set: new Map([['b', undefined], ['c', '"x"']]) });
  assert.deepEqual(JSON.parse(r2), { a: 1, c: 'x' });
  assert.equal(rewriteLine('{"a":1}', scanObject('{"a":1}')!, { rename: new Map([['a', 'A']]) }), '{"A":1}');
  assert.equal(inputToRaw('42', 'n'), '42');
  assert.equal(inputToRaw('42', 's'), '"42"');
  assert.equal(inputToRaw('true', 'b'), 'true');
  assert.equal(inputToRaw('', 'z'), 'null');
  assert.equal(inputToRaw('[1, 2]', 'a'), '[1,2]');
  assert.equal(inputToRaw('not json', 'o'), '"not json"');
});

test('row index on a large generated file matches a reference split', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-idx-'));
  const f = path.join(dir, 'big.csv');
  const lines: string[] = ['id,text,n'];
  for (let i = 0; i < 60000; i++) lines.push(i % 13 === 0 ? `${i},"quoted, with\nnewline ""${i}""",${i * 2}` : `${i},plain ${i},${i * 2}`);
  fs.writeFileSync(f, '﻿' + lines.join('\r\n') + '\r\n');
  const rows = new TextRows({ quotes: true, delim: 44, skipBlank: false });
  let firstCalls = 0;
  await rows.loadFile(f, (first) => void (first && firstCalls++), new Token());
  assert.equal(firstCalls, 1);
  assert.equal(rows.enc.name, 'UTF-8 BOM');
  assert.equal(rows.count(), lines.length);
  assert.equal(rows.text(0), 'id,text,n');
  for (const i of [1, 13, 14, 26, 59999, 60000]) assert.equal(rows.text(i), lines[i], 'row ' + i);
  assert.equal(rows.trailingEol, true);
  assert.equal(detectEol(rows.buf.subarray(0, 4096)), '\r\n');
  // streamed mode (sparse index + ranged reads) sees the same rows
  const sr = new TextRows({ quotes: true, delim: 44, skipBlank: false });
  await sr.openStreamed(f, () => undefined, new Token());
  assert.equal(sr.count(), lines.length);
  for (const i of [0, 1, 13, 63, 64, 65, 4097, 60000]) assert.equal(await sr.textAsync(i), lines[i], 'streamed row ' + i);
  const seen: number[] = [];
  await sr.forEach(100, 300, new Slicer(), (i, t) => {
    seen.push(i);
    assert.equal(t, lines[i]);
  });
  assert.equal(seen.length, 200);
  fs.rmSync(dir, { recursive: true });
});

test('encodings: UTF-16 is transcoded, invalid UTF-8 is detected', async () => {
  assert.equal(isUtf8(Buffer.from('héllo 世界')), true);
  assert.equal(isUtf8(Buffer.from('héllo 世界').subarray(0, 8)), true, 'cut multibyte sequence at the end is fine');
  assert.equal(isUtf8(Buffer.from([0xb3, 0xc7, 0xca, 0xd0])), false);
  const rows = new TextRows({ quotes: true, delim: 44, skipBlank: false });
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n1,2\n', 'utf16le')]);
  await rows.loadBytes(u16, new Token());
  assert.equal(rows.enc.name, 'UTF-16 LE');
  assert.equal(rows.count(), 2);
  assert.equal(rows.text(1), '1,2');
});

test('sparse index records every 64th row', () => {
  const sp = new SparseIndex();
  for (let i = 0; i < 200; i++) sp.push(i * 10, i * 10 + 5);
  assert.equal(sp.n, 200);
  assert.equal(sp.blocks[1], 640);
  assert.equal(sp.blocks[3], 1920);
  const ri = new RowIndex();
  for (let i = 0; i < 10000; i++) ri.push(i, i + 1);
  assert.equal(ri.n, 10000);
  assert.equal(ri.ends[9999], 10000);
});

test('merge sort is stable and yields', async () => {
  const n = 50000;
  const keys = Array.from({ length: n }, (_, i) => (i * 7919) % 100);
  const sl = new Slicer(undefined, 2);
  const perm = await mergeSort(n, (a, b) => keys[a] - keys[b] || a - b, sl);
  for (let i = 1; i < n; i++) {
    const a = perm[i - 1];
    const b = perm[i];
    assert.ok(keys[a] < keys[b] || (keys[a] === keys[b] && a < b), 'stable at ' + i);
  }
});

test('markdown export escapes pipes', () => {
  assert.equal(toMarkdown(['a', 'b'], [['x|y', 'z']]), '| a | b |\n| --- | --- |\n| x\\|y | z |\n');
});

test('search spec: whole word, regex validation, prefilter safety', () => {
  const w = compileSpec({ q: 'cat', regex: false, matchCase: false, word: true }, 'csv');
  assert.ok(w && !('error' in w));
  assert.equal((w as { test: (s: string) => boolean }).test('the Cat sat'), true);
  assert.equal((w as { test: (s: string) => boolean }).test('concatenate'), false);
  const bad = compileSpec({ q: '(', regex: true, matchCase: false, word: false }, 'csv');
  assert.ok(bad && 'error' in bad);
  const quoted = compileSpec({ q: 'say "hi"', regex: false, matchCase: false, word: false }, 'csv') as { raw?: RegExp; bytes?: RegExp };
  assert.ok(quoted.raw!.test('x,"say ""hi""",y'), 'raw prefilter knows CSV doubles quotes');
  const anchored = compileSpec({ q: '^abc', regex: true, matchCase: false, word: false }, 'csv') as { raw?: RegExp };
  assert.equal(anchored.raw, undefined, 'anchored regexes are checked per cell');
  const esc = compileSpec({ q: '北京', regex: false, matchCase: false, word: false }, 'jsonl', true) as { raw?: RegExp; bytes?: RegExp };
  esc.raw!.lastIndex = 0;
  assert.ok(esc.raw!.test('{"city":"\\u5317\\u4eac"}'), 'JSONL \\u escapes are matched too');
  esc.bytes!.lastIndex = 0;
  assert.ok(esc.bytes!.test(Buffer.from('{"city":"北京"}').toString('latin1')), 'byte-level prefilter on UTF-8');
  const ci = compileSpec({ q: 'Été', regex: false, matchCase: false, word: false }, 'csv') as { bytes?: RegExp };
  assert.ok(ci.bytes!.test(Buffer.from('a,ÉTÉ,b').toString('latin1')), 'non-ASCII case folding at byte level');
});
