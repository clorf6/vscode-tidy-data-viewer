// Colour picker for colour values (#hex, rgb(), hsl()): a saturation / brightness area, hue and opacity sliders, a text
// field, HEX / RGB / HSL notation and the eyedropper where the browser has one. The new value keeps the original's
// notation: case, short hex, commas or spaces, and whether it has an alpha part.
import { h, icon, t } from '../shared/vscode';
import { clamp, formatColor, Notation, parseColor, Rgba, rgbToHsv, hsvToRgb } from './colormath';
import { closePop, showPop } from './ui';

const css = (c: Rgba) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`;

// ---- the picker ----

export interface PickerOptions {
  readOnly: boolean;
  apply(value: string): void;
  copy(value: string): void;
}

/** A 2D (area) or 1D (slider) control driven by the pointer and the arrow keys. */
function track(el: HTMLElement, onMove: (x: number, y: number) => void, onKey: (dx: number, dy: number) => void): void {
  const at = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    onMove(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    onKey(d[0], d[1]);
  });
}

/** Open the picker under `anchor` for a colour value. */
export function openColorPicker(anchor: HTMLElement, value: string, o: PickerOptions): void {
  const parsed = parseColor(value);
  if (!parsed) return;
  const style = { ...parsed.style };
  const start = parsed.c;
  let hsv = rgbToHsv(start);
  let alpha = start.a;
  const current = (): Rgba => ({ ...hsvToRgb(hsv.h, hsv.s, hsv.v), a: alpha });
  const text = () => formatColor(current(), style);

  const area = h('div', { class: 'cp-area', tabindex: 0, role: 'slider', 'aria-label': t('Saturation and brightness') }, h('div', { class: 'cp-thumb' }));
  const hue = h('div', { class: 'cp-slider cp-hue', tabindex: 0, role: 'slider', 'aria-label': t('Hue'), 'aria-valuemin': '0', 'aria-valuemax': '360' }, h('div', { class: 'cp-knob' }));
  const alphaBar = h('div', { class: 'cp-slider cp-alpha', tabindex: 0, role: 'slider', 'aria-label': t('Opacity'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { class: 'cp-alpha-fill' }), h('div', { class: 'cp-knob' }));
  const before = h('span', { class: 'cp-before', title: value });
  const after = h('span', { class: 'cp-after' });
  before.style.setProperty('--c', css(start));
  const input = h('input', { class: 'cp-input', type: 'text', spellcheck: 'false', 'aria-label': t('Color value') }) as HTMLInputElement;
  const fmts = h('div', { class: 'dv-seg cp-fmt', role: 'tablist' });
  const okBtn = h('button', { class: 'dv-btn primary', onclick: () => finish(true) }, t('Apply'));
  const copyBtn = h('button', { class: 'dv-btn secondary', onclick: () => (o.copy(text()), closePop()) }, icon('copy', 14), t('Copy'));

  const paint = (fromInput = false) => {
    const c = current();
    area.style.setProperty('--hue', `hsl(${hsv.h}, 100%, 50%)`);
    const thumb = area.firstElementChild as HTMLElement;
    thumb.style.left = hsv.s + '%';
    thumb.style.top = 100 - hsv.v + '%';
    (hue.firstElementChild as HTMLElement).style.left = (hsv.h / 360) * 100 + '%';
    hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    alphaBar.style.setProperty('--solid', `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`);
    (alphaBar.lastElementChild as HTMLElement).style.left = alpha * 100 + '%';
    alphaBar.setAttribute('aria-valuenow', String(Math.round(alpha * 100)));
    after.style.setProperty('--c', css(c));
    if (!fromInput) {
      input.value = text();
      input.classList.remove('bad');
    }
    for (const b of fmts.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.fmt === style.fmt));
  };
  track(area, (x, y) => ((hsv = { ...hsv, s: x * 100, v: (1 - y) * 100 }), paint()), (dx, dy) => ((hsv = { ...hsv, s: clamp(hsv.s + dx, 0, 100), v: clamp(hsv.v - dy, 0, 100) }), paint()));
  track(hue, (x) => ((hsv = { ...hsv, h: Math.min(359.9, x * 360) }), paint()), (dx) => ((hsv = { ...hsv, h: (hsv.h + dx + 360) % 360 }), paint()));
  track(alphaBar, (x) => ((alpha = Math.round(x * 100) / 100), paint()), (dx) => ((alpha = clamp(Math.round(alpha * 100 + dx) / 100, 0, 1)), paint()));
  input.addEventListener('input', () => {
    const p = parseColor(input.value);
    input.classList.toggle('bad', !p);
    if (!p) return;
    hsv = rgbToHsv(p.c);
    alpha = p.c.a;
    Object.assign(style, p.style);
    paint(true);
  });
  for (const f of ['hex', 'rgb', 'hsl'] as Notation[])
    fmts.append(
      h(
        'button',
        {
          role: 'tab',
          'data-fmt': f,
          onclick: () => {
            if (style.fmt === f) return;
            // a fresh notation starts from its usual spelling
            Object.assign(style, { fmt: f, fn: undefined, short: false, comma: f === 'hex' ? undefined : (style.comma ?? ', ') });
            paint();
          },
        },
        f.toUpperCase(),
      ),
    );
  const tools: Node[] = [fmts];
  const ED = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (ED)
    tools.push(
      h(
        'button',
        {
          class: 'dv-iconbtn sm',
          title: t('Pick a color from the screen'),
          onclick: async () => {
            try {
              const p = parseColor((await new ED().open()).sRGBHex);
              if (p) {
                hsv = rgbToHsv(p.c);
                paint();
              }
            } catch {
              /* cancelled */
            }
          },
        },
        icon('eyedropper', 14),
      ),
    );

  const finish = (commit: boolean) => {
    const v = text();
    closePop();
    if (commit && !o.readOnly && v !== value.trim()) o.apply(v);
  };
  const buttons = o.readOnly ? [copyBtn] : [copyBtn, h('button', { class: 'dv-btn secondary', onclick: () => finish(false) }, t('Cancel')), okBtn];
  const body = h(
    'div',
    { class: 'cp' },
    area,
    h('div', { class: 'cp-row' }, h('span', { class: 'cp-preview', title: t('Before / after') }, before, after), h('div', { class: 'cp-sliders' }, hue, alphaBar)),
    h('div', { class: 'cp-row' }, input, ...tools),
    h('div', { class: 'cp-row cp-actions' }, ...buttons),
  );
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      finish(true);
    }
  });
  const r = anchor.getBoundingClientRect();
  showPop(body, r.left - 8, r.bottom + 6, 'cp-pop');
  paint();
  area.focus();
}
