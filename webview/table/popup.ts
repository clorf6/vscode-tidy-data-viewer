// Floating menus and popovers (one at a time), positioned against an anchor and dismissed on outside click / Esc.
import { h, icon } from '../shared/vscode';

export type MenuItem = { label: string; icon?: string; kbd?: string; disabled?: boolean; checked?: boolean; danger?: boolean; run: () => void } | 'sep' | { header: string };

let current: { el: HTMLElement; close: () => void; restore?: HTMLElement | null } | undefined;

export function closePopup(): void {
  const c = current;
  current = undefined;
  if (c) {
    c.el.remove();
    c.close();
    c.restore?.focus?.({ preventScroll: true });
  }
}

export function popupOpen(): boolean {
  return !!current;
}

function place(el: HTMLElement, anchor: DOMRect | { x: number; y: number }, align: 'below' | 'point'): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.maxHeight = vh - 16 + 'px';
  const r = el.getBoundingClientRect();
  let x: number;
  let y: number;
  if (anchor instanceof DOMRect && align === 'below') {
    x = anchor.left;
    y = anchor.bottom + 4;
    if (y + r.height > vh - 8 && anchor.top - r.height - 4 > 8) y = anchor.top - r.height - 4;
  } else {
    x = (anchor as { x: number }).x;
    y = (anchor as { y: number }).y;
    if (y + r.height > vh - 8) y = Math.max(8, y - r.height);
  }
  if (x + r.width > vw - 8) x = Math.max(8, vw - 8 - r.width);
  y = Math.max(8, Math.min(y, vh - 8 - Math.min(r.height, vh - 16)));
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
}

function mount(el: HTMLElement, anchor: DOMRect | { x: number; y: number }, align: 'below' | 'point', onClose?: () => void): void {
  closePopup();
  const restore = document.activeElement as HTMLElement | null;
  document.body.append(el);
  place(el, anchor, align);
  current = { el, close: () => onClose?.(), restore };
}

document.addEventListener(
  'mousedown',
  (e) => {
    if (current && !current.el.contains(e.target as Node)) {
      const c = current;
      current = undefined;
      c.el.remove();
      c.close();
    }
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && current) {
      e.preventDefault();
      e.stopPropagation();
      closePopup();
    }
  },
  true,
);
window.addEventListener('blur', () => {
  if (current && !current.el.contains(document.activeElement)) closePopup();
});
window.addEventListener('resize', () => closePopup());

export function openMenu(items: MenuItem[], anchor: DOMRect | { x: number; y: number }, align: 'below' | 'point' = 'point'): void {
  const el = h('div', { class: 'dv-menu', role: 'menu' });
  for (const it of items) {
    if (it === 'sep') {
      el.append(h('div', { class: 'dv-menu-sep', role: 'separator' }));
      continue;
    }
    if ('header' in it) {
      el.append(h('div', { class: 'tm-head' }, it.header));
      continue;
    }
    const b = h(
      'button',
      {
        role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': it.checked === undefined ? undefined : String(it.checked),
        disabled: it.disabled,
        class: it.danger ? 'danger' : undefined,
        onclick: () => {
          closePopup();
          it.run();
        },
      },
      it.icon ? icon(it.icon, 14) : h('span', { class: 'tm-noicon' }),
      h('span', { class: 'tm-label' }, it.label),
      it.checked ? icon('check', 14) : null,
      it.kbd ? h('span', { class: 'dv-kbd' }, it.kbd) : null,
    );
    el.append(b);
  }
  el.addEventListener('keydown', (e) => {
    const btns = [...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') btns[(i + 1) % btns.length]?.focus();
    else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length]?.focus();
    else if (e.key === 'Home') btns[0]?.focus();
    else if (e.key === 'End') btns[btns.length - 1]?.focus();
    else if (e.key === 'Tab') closePopup();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  mount(el, anchor, align);
  el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}

export function openPopover(content: HTMLElement, anchor: DOMRect | { x: number; y: number }, onClose?: () => void, cls = ''): HTMLElement {
  const el = h('div', { class: 'dv-pop ' + cls, role: 'dialog' }, content);
  el.addEventListener('keydown', (e) => e.stopPropagation());
  mount(el, anchor, anchor instanceof DOMRect ? 'below' : 'point', onClose);
  return el;
}

/** Re-position the open popup after its content changed size. */
export function repositionPopup(anchor: DOMRect | { x: number; y: number }): void {
  if (current) place(current.el, anchor, anchor instanceof DOMRect ? 'below' : 'point');
}
