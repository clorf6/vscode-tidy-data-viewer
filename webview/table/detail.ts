// Record detail side panel: the selected row as a vertical key → value list (what makes very wide tables readable),
// plus the Parquet schema.
import { copyText, h, icon, nf, t } from '../shared/vscode';
import type { ColMeta, Meta, RowData } from '../../src/table/protocol';
import { TYPE_ICON } from './grid';
import { prettyJsonDom } from './render';

export interface DetailHost {
  step(d: 1 | -1): void;
  close(): void;
  resized(w: number): void;
  reveal(key: number): void;
}

const TYPE_LABEL: Record<string, string> = { int: 'Integer', float: 'Decimal', bool: 'Boolean', date: 'Date', json: 'JSON', string: 'Text', empty: 'Empty' };

export function typeLabel(t0: string): string {
  return t(TYPE_LABEL[t0] ?? 'Text');
}

export class DetailPanel {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private list: HTMLElement;
  private filter: HTMLInputElement;
  private tabs?: HTMLElement;
  private tab: 'record' | 'schema' = 'record';
  private last?: { row: number; data: RowData | null; cols: ColMeta[]; order: number[]; hidden: Set<number> };
  private meta?: Meta;
  width = 380;

  constructor(private host: DetailHost) {
    this.title = h('span', { class: 'td-title' });
    this.filter = h('input', { class: 'dv-plain', placeholder: t('Filter fields…'), 'aria-label': t('Filter fields…') });
    this.filter.addEventListener('input', () => this.redraw());
    this.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.filter.value) {
        this.filter.value = '';
        this.redraw();
        e.stopPropagation();
      }
    });
    this.list = h('div', { class: 'td-list', role: 'list' });
    const grip = h('div', { class: 'td-grip', title: '' });
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = this.width;
      const move = (ev: MouseEvent) => {
        this.width = Math.max(240, Math.min(window.innerWidth - 200, w0 - (ev.clientX - x0)));
        this.el.style.width = this.width + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.host.resized(this.width);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.el = h(
      'aside',
      { class: 'td', 'aria-label': t('Record details') },
      grip,
      h(
        'div',
        { class: 'td-head' },
        this.title,
        h('span', { class: 'dv-spacer' }),
        h('button', { class: 'dv-iconbtn', title: t('Previous row'), 'aria-label': t('Previous row'), onclick: () => this.host.step(-1) }, icon('arrowUp')),
        h('button', { class: 'dv-iconbtn', title: t('Next row'), 'aria-label': t('Next row'), onclick: () => this.host.step(1) }, icon('arrowDown')),
        h('button', { class: 'dv-iconbtn', title: t('Close'), 'aria-label': t('Close'), onclick: () => this.host.close() }, icon('close')),
      ),
      h('div', { class: 'td-search' }, h('label', { class: 'dv-input' }, icon('search', 14), this.filter)),
      this.list,
    );
    this.el.style.width = this.width + 'px';
  }

  setWidth(w: number): void {
    this.width = w;
    this.el.style.width = w + 'px';
  }

  enableSchema(meta: Meta): void {
    this.meta = meta;
    if (this.tabs) return;
    const mk = (id: 'record' | 'schema', label: string) =>
      h(
        'button',
        {
          role: 'tab',
          'aria-selected': String(this.tab === id),
          onclick: () => {
            this.tab = id;
            for (const b of this.tabs!.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.textContent === label));
            this.redraw();
          },
        },
        label,
      );
    this.tabs = h('div', { class: 'dv-seg td-tabs', role: 'tablist' }, mk('schema', t('Schema')), mk('record', t('Record')));
    this.tab = 'schema';
    for (const b of this.tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.textContent === t('Schema')));
    this.el.querySelector('.td-head')!.prepend(this.tabs);
  }

  setTab(tab: 'record' | 'schema'): void {
    if (!this.tabs) return;
    this.tab = tab;
    for (const b of this.tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.textContent === t(tab === 'schema' ? 'Schema' : 'Record')));
    this.redraw();
  }

  get currentTab(): string {
    return this.tab;
  }

  show(row: number, data: RowData | null, cols: ColMeta[], order: number[], hidden: Set<number>): void {
    this.last = { row, data, cols, order, hidden };
    this.redraw();
  }

  private redraw(): void {
    this.list.textContent = '';
    if (this.tab === 'schema' && this.meta) return this.drawSchema(this.meta);
    const L = this.last;
    if (!L || !L.data) {
      this.title.textContent = t('Record details');
      this.list.append(h('div', { class: 'dv-empty' }, t('No row selected')));
      return;
    }
    this.title.textContent = t('Row {0}', nf.format(L.row + 1)) + (L.data.ln && L.data.ln !== L.row + 1 ? ` · #${nf.format(L.data.ln)}` : '');
    const q = this.filter.value.trim().toLowerCase();
    const byKey = new Map(L.cols.map((c, i) => [c.key, i]));
    const keys = [...L.order.filter((k) => !L.hidden.has(k)), ...L.order.filter((k) => L.hidden.has(k))];
    for (const k of L.cols.map((c) => c.key)) if (!keys.includes(k)) keys.push(k);
    let shown = 0;
    for (const key of keys) {
      const li = byKey.get(key);
      if (li === undefined) continue;
      const col = L.cols[li];
      const v = L.data.c[li] ?? '';
      const kind = L.data.k?.[li];
      if (q && !col.name.toLowerCase().includes(q) && !v.toLowerCase().includes(q)) continue;
      if (++shown > 2000) break;
      let val: HTMLElement;
      if (kind === 'u') val = h('span', { class: 'td-missing' }, t('missing'));
      else if (kind === 'z') val = h('span', { class: 'v-null' }, 'null');
      else if (v === '') val = h('span', { class: 'td-missing' }, t('empty'));
      else if (kind === 'o' || kind === 'a' || (col.type === 'json' && /^[[{]/.test(v))) val = prettyJsonDom(v.length > 200000 ? v.slice(0, 200000) : v);
      else {
        const cls = kind === 'n' || col.type === 'int' || col.type === 'float' ? 'v-num' : kind === 'b' || col.type === 'bool' ? 'v-bool' : kind === 's' ? 'v-str' : '';
        val = h('span', { class: cls }, v.length > 100000 ? v.slice(0, 100000) + '…' : v);
      }
      const field = h(
        'div',
        { class: 'td-f' + (L.hidden.has(key) ? ' hidden' : ''), role: 'listitem' },
        h(
          'div',
          { class: 'td-k', title: col.name + ' · ' + typeLabel(col.type) },
          h('span', { class: 'td-ty' }, icon(TYPE_ICON[col.type], 12)),
          h('button', { class: 'td-kn', onclick: () => this.host.reveal(key), title: col.name }, col.name),
          h('button', { class: 'dv-iconbtn td-copy', title: t('Copy value'), 'aria-label': t('Copy value'), onclick: () => copyText(kind === 'z' ? 'null' : v) }, icon('copy', 14)),
        ),
        h('div', { class: 'td-v' }, val),
      );
      this.list.append(field);
    }
    if (!shown) this.list.append(h('div', { class: 'dv-empty' }, t('No matching fields')));
  }

  private drawSchema(meta: Meta): void {
    this.title.textContent = '';
    const p = meta.parquet;
    const facts: [string, string][] = [
      [t('Rows'), nf.format(meta.total)],
      [t('Columns'), nf.format(meta.columns.length)],
    ];
    if (p) {
      facts.push([t('Row groups'), nf.format(p.rowGroups)]);
      if (p.compression) facts.push([t('Compression'), p.compression]);
      if (p.createdBy) facts.push([t('Created by'), p.createdBy]);
    }
    this.list.append(h('div', { class: 'td-facts' }, ...facts.map(([k, v]) => h('div', { class: 'td-fact' }, h('span', { class: 'td-fk' }, k), h('span', { class: 'td-fv', title: v }, v)))));
    const q = this.filter.value.trim().toLowerCase();
    const tbl = h('div', { class: 'td-schema', role: 'table' });
    tbl.append(h('div', { class: 'td-srow head', role: 'row' }, h('span', null, t('Column')), h('span', null, t('Type')), h('span', null, t('Logical type'))));
    for (const c of meta.columns) {
      if (q && !c.name.toLowerCase().includes(q)) continue;
      tbl.append(
        h(
          'div',
          { class: 'td-srow', role: 'row' },
          h('button', { class: 'td-kn', onclick: () => this.host.reveal(c.key), title: c.name }, h('span', { class: 'td-ty' }, icon(TYPE_ICON[c.type], 12)), c.name),
          h('span', { class: 'dv-tag' }, c.physical || '—'),
          h('span', { class: 'td-lt' }, [c.logical, c.repetition === 'OPTIONAL' ? t('nullable') : c.repetition === 'REPEATED' ? 'repeated' : ''].filter(Boolean).join(' · ')),
        ),
      );
    }
    this.list.append(tbl);
  }
}
