// Table module, row serving under stress: many overlapping window requests (rapid scrolling) against the real host
// document while the file is still indexing, while queries change the view version, and while a log grows. Every
// request must get exactly one reply (`rows` or `dropped`), and every `rows` reply must be complete and correct.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TableDocument } from '../src/table/document';
import type { ToHost, ToView } from '../src/table/protocol';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-stress-'));
const host = { fireEdit() {}, config: <T>(_k: string, d: T) => d };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rnd(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

type Req = { vv: number; b: number; bs: number };

/** Fire requests like a scrolling webview and record every reply. */
async function hammer(doc: TableDocument, sent: ToView[], o: { rounds: number; seed: number; between?: (i: number) => Promise<void> }) {
  const r = rnd(o.seed);
  const reqs: Req[] = [];
  for (let i = 0; i < o.rounds; i++) {
    const count = doc.viewCount();
    const bs = [32, 64, 128, 256][Math.floor(r() * 4)];
    const last = Math.max(0, Math.ceil(count / bs) - 1);
    const center = Math.floor(r() * (last + 1));
    const blocks = [center, center + 1, center - 1].filter((b) => b >= 0 && b <= last);
    // sometimes a stale view version (a reply racing a sort/filter)
    const vv = r() < 0.1 ? doc.vv - 1 : doc.vv;
    for (const b of blocks) reqs.push({ vv, b, bs });
    void doc.handle({ type: 'rows', vv, blocks, bs } as ToHost);
    if (r() < 0.3) await sleep(0);
    await o.between?.(i);
  }
  // all answered within a few seconds
  const t0 = Date.now();
  const key = (x: Req) => `${x.vv}/${x.bs}/${x.b}`;
  for (;;) {
    const answered = new Map<string, number>();
    for (const m of sent) {
      if (m.type === 'rows') answered.set(`${m.vv}/${m.bs}/${m.b}`, (answered.get(`${m.vv}/${m.bs}/${m.b}`) ?? 0) + 1);
      else if (m.type === 'dropped') for (const b of m.blocks) answered.set(`${m.vv}/*/${b}`, (answered.get(`${m.vv}/*/${b}`) ?? 0) + 1);
    }
    const missing = reqs.filter((q) => !answered.has(key(q)) && !answered.has(`${q.vv}/*/${q.b}`));
    if (!missing.length) return reqs;
    if (Date.now() - t0 > 15000) assert.fail(`${missing.length} of ${reqs.length} row requests never answered, e.g. ${JSON.stringify(missing.slice(0, 3))}`);
    await sleep(5);
  }
}

test('every row request is answered while a large CSV is still indexing', async () => {
  const f = path.join(dir, 'big.csv');
  const lines = ['id,name,score'];
  for (let i = 0; i < 300_000; i++) lines.push(`${i},name ${i % 977},${(i * 7919) % 1000}`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const doc = new TableDocument(vscode.Uri.file(f), host);
  const sent: ToView[] = [];
  doc.attach((m) => sent.push(m));
  const loading = doc.load();
  await doc.whenReady();
  await doc.handle({ type: 'ready' });
  assert.equal(doc.loaded, false, 'still indexing when the first requests arrive');
  await hammer(doc, sent, { rounds: 200, seed: 3 });
  // the webview is re-created (hidden tab, retainContextWhenHidden: false) while indexing: it says ready again
  const inits = sent.filter((m) => m.type === 'init').length;
  await doc.handle({ type: 'ready' });
  assert.equal(sent.filter((m) => m.type === 'init').length, inits + 1, 'a fresh init for the new webview');
  await hammer(doc, sent, { rounds: 200, seed: 4 });
  await loading;
  // replies for the current view are complete and in order
  for (const m of sent)
    if (m.type === 'rows' && m.vv === doc.vv) {
      assert.ok(m.rows.length <= m.bs);
      m.rows.forEach((row, i) => assert.equal(row.c[0], String(m.b * m.bs + i)));
    }
  doc.dispose();
});

test('every row request is answered while sorts and filters keep changing the view', async () => {
  const f = path.join(dir, 'q.csv');
  const lines = ['id,city,score'];
  for (let i = 0; i < 60_000; i++) lines.push(`${i},${['Boston', 'Paris', 'Tokyo'][i % 3]},${(i * 37) % 101}`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const doc = new TableDocument(vscode.Uri.file(f), host);
  const sent: ToView[] = [];
  doc.attach((m) => sent.push(m));
  await doc.load();
  await doc.handle({ type: 'ready' });
  const queries = [{ filters: [], sort: { key: 2, dir: 'desc' as const } }, { filters: [{ key: 1, op: 'equals' as const, value: 'Paris' }] }, { filters: [] }, { filters: [], text: '7' }];
  await hammer(doc, sent, {
    rounds: 300,
    seed: 5,
    between: async (i) => {
      if (i % 37 === 0) void doc.handle({ type: 'query', query: queries[(i / 37) % queries.length] });
    },
  });
  // settle on a sorted view and check one window end to end
  await doc.handle({ type: 'query', query: queries[0] });
  const n = sent.length;
  await doc.handle({ type: 'rows', vv: doc.vv, blocks: [0], bs: 64 });
  const deadline = Date.now() + 5000;
  while (!sent.slice(n).some((m) => m.type === 'rows') && Date.now() < deadline) await sleep(2);
  const rows = (sent.slice(n).find((m) => m.type === 'rows') as Extract<ToView, { type: 'rows' }>).rows;
  assert.equal(rows.length, 64);
  assert.equal(rows[0].c[2], '100');
  doc.dispose();
});

test('a growing log: requests near the end are answered, later rows of a short block are served on re-request', async () => {
  const f = path.join(dir, 'grow.log');
  fs.writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `2026-10-15 10:00:00 INFO line ${i}`).join('\n') + '\n');
  const doc = new TableDocument(vscode.Uri.file(f), host);
  const sent: ToView[] = [];
  doc.attach((m) => sent.push(m));
  await doc.load();
  await doc.handle({ type: 'ready' });
  let next = 1000;
  await hammer(doc, sent, {
    rounds: 200,
    seed: 9,
    between: async (i) => {
      if (i % 20 === 0) {
        fs.appendFileSync(f, Array.from({ length: 37 }, () => `2026-10-15 10:00:01 WARN line ${next++}`).join('\n') + '\n');
        await doc.checkDisk();
      }
    },
  });
  assert.equal(doc.model.count(), next);
  // the last block, asked again after growth, now has the new lines
  const bs = 256;
  const b = Math.floor((next - 1) / bs);
  const n = sent.length;
  await doc.handle({ type: 'rows', vv: doc.vv, blocks: [b], bs });
  const deadline = Date.now() + 5000;
  while (!sent.slice(n).some((m) => m.type === 'rows') && Date.now() < deadline) await sleep(2);
  const rows = (sent.slice(n).find((m) => m.type === 'rows') as Extract<ToView, { type: 'rows' }>).rows;
  assert.equal(rows.length, next - b * bs);
  assert.match(rows.at(-1)!.c[0], new RegExp(`line ${next - 1}$`));
  doc.dispose();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
