// Host-side query engine: filters, typed stable sort (chunked merge sort), global search and column statistics.
import { isNumericType, numericKey, toNumber } from './infer';
import type { JsonlModel, LogModel, TableModel } from './models';
import { compileSpec, searchRows } from './search';
import { ColType, Filter, Query, Stats } from './protocol';
import { Slicer } from './sched';

export type Progress = (task: string, frac: number) => void;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeMatcher(q: string, regex: boolean, matchCase: boolean): ((s: string) => boolean) | undefined {
  if (!q) return undefined;
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(q, matchCase ? '' : 'i');
    } catch {
      return () => false;
    }
    return (s) => re.test(s);
  }
  if (matchCase) return (s) => s.includes(q);
  // ASCII fast path: a case-insensitive regex is much faster than lowercasing every value
  const re = new RegExp(escapeRe(q), 'i');
  return (s) => re.test(s);
}

/** Compile one filter into a predicate over a cell value (undefined = missing). */
export function compileFilter(f: Filter, type: ColType): (v: string | undefined) => boolean {
  const val = f.value ?? '';
  const lower = val.toLowerCase();
  const numeric = isNumericType(type) || type === 'date' || type === 'bool';
  const cmpNum = numeric ? numericKey(val, type) : toNumber(val);
  const cmp = (v: string): number => {
    if (!isNaN(cmpNum)) {
      const n = numeric ? numericKey(v, type) : toNumber(v);
      if (!isNaN(n)) return n < cmpNum ? -1 : n > cmpNum ? 1 : 0;
    }
    const a = v.toLowerCase();
    return a < lower ? -1 : a > lower ? 1 : 0;
  };
  const empty = (v: string | undefined) => v === undefined || v.trim() === '';
  switch (f.op) {
    case 'empty':
      return empty;
    case 'notEmpty':
      return (v) => !empty(v);
    case 'contains': {
      const m = makeMatcher(val, false, false)!;
      return (v) => v !== undefined && (val === '' || m(v));
    }
    case 'notContains': {
      const m = makeMatcher(val, false, false);
      return (v) => !m || v === undefined || !m(v);
    }
    case 'startsWith':
      return (v) => v !== undefined && v.toLowerCase().startsWith(lower);
    case 'endsWith':
      return (v) => v !== undefined && v.toLowerCase().endsWith(lower);
    case 'equals':
      return (v) => (v ?? '') === val || (!isNaN(cmpNum) && v !== undefined && cmp(v) === 0 && v.trim() !== '');
    case 'notEquals':
      return (v) => !((v ?? '') === val || (!isNaN(cmpNum) && v !== undefined && cmp(v) === 0 && v.trim() !== ''));
    case 'in': {
      const set = new Set(f.values ?? []);
      return (v) => set.has(v ?? '');
    }
    case 'regex': {
      const m = makeMatcher(val, true, false);
      return (v) => !m || (v !== undefined && m(v));
    }
    case 'gt':
      return (v) => !empty(v) && cmp(v!) > 0;
    case 'gte':
      return (v) => !empty(v) && cmp(v!) >= 0;
    case 'lt':
      return (v) => !empty(v) && cmp(v!) < 0;
    case 'lte':
      return (v) => !empty(v) && cmp(v!) <= 0;
    default:
      return () => true;
  }
}

class U32 {
  a = new Uint32Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Uint32Array {
    return this.a.slice(0, this.n);
  }
}

/** Run filters (+ log level/text filters) and sort. Returns the visible ids, or null for the plain order. */
export async function runQuery(model: TableModel, q: Query, slicer: Slicer, progress: Progress): Promise<Uint32Array | null> {
  const filters = q.filters.filter((f) => model.columns.some((c) => c.key === f.key));
  const levelFilter = model.kind === 'log' && q.levels !== undefined && q.levels !== 0x7f;
  const textSpec = q.text ? compileSpec({ q: q.text, regex: !!q.regex, matchCase: !!q.matchCase, word: !!q.word }, model.kind, (model as JsonlModel).unicodeEscapes) : undefined;
  const text = textSpec && !('error' in textSpec) ? textSpec : undefined;
  const sort = q.sort && model.columns.some((c) => c.key === q.sort!.key) ? q.sort : null;
  if (!filters.length && !levelFilter && !text && !sort) return null;
  const order = model.orderArray();
  const identity = model.isIdentity();
  let ids: Uint32Array = order;
  let filtered = false;
  const total = order.length;
  if (filters.length) {
    const out = new U32();
    const keys = [...new Set(filters.map((f) => f.key))];
    const preds = filters.map((f) => ({ k: keys.indexOf(f.key), p: compileFilter(f, model.colType(f.key)) }));
    await model.scan(
      order,
      keys,
      slicer,
      (pos, id, vals) => {
        for (let i = 0; i < preds.length; i++) if (!preds[i].p(vals[preds[i].k])) return;
        out.push(id);
        if ((pos & 8191) === 0) progress('filter', pos / total);
      },
      identity,
    );
    ids = out.done();
    filtered = true;
  }
  const lm = model.kind === 'log' ? (model as LogModel) : undefined;
  const mask = q.levels ?? 0x7f;
  if (text) {
    const out = new U32();
    const keys = q.keys?.length ? q.keys.filter((k) => model.columns.some((c) => c.key === k)) : model.columns.map((c) => c.key);
    let last = performance.now();
    await searchRows(
      model,
      { view: filtered ? ids : identity ? null : order, ascending: filtered || identity },
      text,
      {
        keys: keys.length ? keys : model.columns.map((c) => c.key),
        from: 0,
        accept: lm && levelFilter ? (id) => (mask & (1 << lm.levels[id])) !== 0 : undefined,
        onRow: (pos, id) => {
          out.push(id);
          if ((out.n & 1023) === 0) {
            const now = performance.now();
            if (now - last > 100) {
              last = now;
              progress('filter', pos / Math.max(1, ids.length));
            }
          }
        },
      },
      slicer,
    );
    ids = out.done();
    filtered = true;
  } else if (lm && levelFilter) {
    const out = new U32();
    for (let p = 0; p < ids.length; p++) {
      const id = ids[p];
      if (mask & (1 << lm.levels[id])) out.push(id);
      if (slicer.due()) {
        progress('filter', p / ids.length);
        await slicer.yieldNow();
      }
    }
    ids = out.done();
    filtered = true;
  }
  if (sort) ids = await sortIds(model, ids, sort.key, sort.dir, slicer, progress, identity && !filtered);
  return ids;
}


/**
 * Stable typed sort of ids by one column; empty/invalid values always go last. Values are turned into ranks
 * (distinct values sorted natively in blocks + merged), then (rank, position) pairs packed into doubles are sorted the
 * same way — no JS comparator calls, and every step runs in time slices.
 */
export async function sortIds(model: TableModel, ids: Uint32Array, key: number, dir: 'asc' | 'desc', slicer: Slicer, progress: Progress, identity = false): Promise<Uint32Array> {
  const n = ids.length;
  const type = model.colType(key);
  const numeric = isNumericType(type) || type === 'date' || type === 'bool';
  const nums = numeric ? new Float64Array(n) : undefined;
  const strs: string[] | undefined = numeric ? undefined : new Array(n);
  await model.scan(
    ids,
    [key],
    slicer,
    (pos, _id, vals) => {
      const v = vals[0];
      if (nums) nums[pos] = numericKey(v, type);
      else strs![pos] = v === undefined ? '' : v.toLowerCase();
      if ((pos & 16383) === 0) progress('sort', (pos / n) * 0.6);
    },
    identity,
  );
  const rank = new Float64Array(n);
  let U: number;
  if (nums) {
    let m = 0;
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (nums[i] === nums[i]) vals[m++] = nums[i];
      if ((i & 65535) === 65535) await slicer.maybe();
    }
    const sorted = await sortF64(vals.subarray(0, m), slicer);
    // dedupe
    let u = 0;
    for (let i = 0; i < m; i++) {
      if (i === 0 || sorted[i] !== sorted[u - 1]) sorted[u++] = sorted[i];
      if ((i & 65535) === 65535) await slicer.maybe();
    }
    U = u;
    for (let i = 0; i < n; i++) {
      const x = nums[i];
      if (x !== x) rank[i] = -1;
      else {
        let lo = 0;
        let hi = u - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (sorted[mid] < x) lo = mid + 1;
          else hi = mid;
        }
        rank[i] = lo;
      }
      if ((i & 65535) === 65535) await slicer.maybe();
    }
  } else {
    const s = strs!;
    const map = new Map<string, number>();
    const uniq: string[] = [];
    // string hashing/comparison cost grows with length (JSON values): check the clock per item batch, not per 64k
    for (let i = 0; i < n; i++) {
      const k = s[i];
      if (k !== '' && !map.has(k)) {
        map.set(k, 0);
        uniq.push(k);
      }
      if (slicer.due()) await slicer.yieldNow();
    }
    const sorted = await sortStrings(uniq, slicer);
    for (let r = 0; r < sorted.length; r++) {
      map.set(sorted[r], r);
      if (slicer.due()) await slicer.yieldNow();
    }
    U = sorted.length;
    for (let i = 0; i < n; i++) {
      rank[i] = s[i] === '' ? -1 : map.get(s[i])!;
      if (slicer.due()) await slicer.yieldNow();
    }
  }
  progress('sort', 0.8);
  // pack (rank, position): empty/invalid last in both directions, ties keep document order
  const shift = 2 ** Math.max(1, Math.ceil(Math.log2(n + 1)));
  const packed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rank[i] < 0 ? U : dir === 'desc' ? U - 1 - rank[i] : rank[i];
    packed[i] = r * shift + i;
    if ((i & 65535) === 65535) await slicer.maybe();
  }
  const order = await sortF64(packed, slicer);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = ids[order[i] % shift];
    if ((i & 65535) === 65535) await slicer.maybe();
  }
  return out;
}

const BLOCK = 1 << 15;

/** Ascending sort of numbers (no NaN) in slices: native block sorts, then merges. Returns the sorted array. */
export async function sortF64(a: Float64Array, slicer: Slicer): Promise<Float64Array> {
  const n = a.length;
  for (let s = 0; s < n; s += BLOCK) {
    a.subarray(s, Math.min(n, s + BLOCK)).sort();
    await slicer.maybe();
  }
  if (n <= BLOCK) return a;
  let src = a;
  let dst = new Float64Array(n);
  for (let w = BLOCK; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(lo + w, n);
      const hi = Math.min(lo + 2 * w, n);
      let i = lo;
      let j = mid;
      let k = lo;
      while (k < hi) {
        const stop = Math.min(hi, k + (1 << 17));
        while (k < stop) dst[k++] = i < mid && (j >= hi || src[i] <= src[j]) ? src[i++] : src[j++];
        await slicer.maybe();
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** Code-unit order sort of strings in slices (native sort of blocks, then merges). */
export async function sortStrings(a: string[], slicer: Slicer): Promise<string[]> {
  const n = a.length;
  const B = 1 << 12;
  let src: string[] = [];
  for (let s = 0; s < n; s += B) {
    const part = a.slice(s, s + B).sort();
    for (let k = 0; k < part.length; k++) src.push(part[k]);
    await slicer.maybe();
  }
  let dst: string[] = new Array(n);
  for (let w = B; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(lo + w, n);
      const hi = Math.min(lo + 2 * w, n);
      let i = lo;
      let j = mid;
      let k = lo;
      while (k < hi) {
        const stop = Math.min(hi, k + (1 << 12));
        while (k < stop) dst[k++] = i < mid && (j >= hi || src[i] <= src[j]) ? src[i++] : src[j++];
        await slicer.maybe();
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** Bottom-up merge sort of 0..n-1 by `cmp`, in time slices. */
export async function mergeSort(n: number, cmp: (a: number, b: number) => number, slicer: Slicer, progress?: (f: number) => void): Promise<Uint32Array> {
  let a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  const RUN = 1024;
  for (let s = 0; s < n; s += RUN) {
    a.subarray(s, Math.min(n, s + RUN)).sort(cmp);
    if (s % (RUN * 16) === 0) await slicer.maybe();
  }
  let b = new Uint32Array(n);
  const passes = Math.max(1, Math.ceil(Math.log2(Math.max(1, n / RUN))));
  let pass = 0;
  for (let w = RUN; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(lo + w, n);
      const hi = Math.min(lo + 2 * w, n);
      let i = lo;
      let j = mid;
      let k = lo;
      // merge in pieces so one huge merge does not block
      while (k < hi) {
        const stop = Math.min(hi, k + 65536);
        while (k < stop) {
          if (i < mid && (j >= hi || cmp(a[i], a[j]) <= 0)) b[k++] = a[i++];
          else b[k++] = a[j++];
        }
        await slicer.maybe();
      }
    }
    [a, b] = [b, a];
    pass++;
    progress?.(pass / passes);
  }
  return a;
}

/** Column statistics over the view. */
export async function runStats(model: TableModel, view: ArrayLike<number>, identity: boolean, key: number, topN: number, slicer: Slicer): Promise<Stats> {
  const type = model.colType(key);
  const DCAP = 200000;
  const counts = new Map<string, number>();
  let capped = false;
  let empty = 0;
  let n = 0;
  let nmin = Infinity;
  let nmax = -Infinity;
  let sum = 0;
  let ncount = 0;
  let smin: string | undefined;
  let smax: string | undefined;
  const numeric = isNumericType(type);
  await model.scan(
    view,
    [key],
    slicer,
    (_pos, _id, vals) => {
      n++;
      const v = vals[0];
      if (v === undefined || v.trim() === '') {
        empty++;
        return;
      }
      const c = counts.get(v);
      if (c !== undefined) counts.set(v, c + 1);
      else if (counts.size < DCAP) counts.set(v, 1);
      else capped = true;
      if (numeric) {
        const x = toNumber(v);
        if (!isNaN(x)) {
          ncount++;
          sum += x;
          if (x < nmin) nmin = x;
          if (x > nmax) nmax = x;
        }
      } else {
        if (smin === undefined || v < smin) smin = v;
        if (smax === undefined || v > smax) smax = v;
      }
    },
    identity,
  );
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, topN);
  const st: Stats = { key, count: n, empty, distinct: counts.size, distinctCapped: capped, top };
  if (numeric && ncount) st.numeric = { min: nmin, max: nmax, sum, mean: sum / ncount, count: ncount };
  if (!numeric && smin !== undefined) {
    st.minStr = smin.length > 200 ? smin.slice(0, 200) : smin;
    st.maxStr = smax!.length > 200 ? smax!.slice(0, 200) : smax;
  }
  return st;
}
