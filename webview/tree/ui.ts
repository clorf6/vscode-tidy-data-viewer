// Small UI primitives for the tree page: context menu, popovers, toast.
import { h, icon } from '../shared/vscode';

export interface MenuItem {
  label?: string;
  icon?: string;
  kbd?: string;
  disabled?: boolean;
  /** section header (not clickable) */
  header?: boolean;
  sep?: boolean;
  run?: () => void;
}

let openMenu: HTMLElement | undefined;
let openPop: HTMLElement | undefined;
let restoreFocus: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = undefined;
}

export function closePop(): void {
  if (!openPop) return;
  openPop.remove();
  openPop = undefined;
  restoreFocus?.focus();
  restoreFocus = null;
}

export function popOpen(): boolean {
  return !!openPop;
}

function place(el: HTMLElement, x: number, y: number): void {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.left = Math.max(4, Math.min(x, vw - r.width - 4)) + 'px';
  el.style.top = Math.max(4, y + r.height > vh - 4 ? Math.max(4, y - r.height) : y) + 'px';
}

export function showMenu(items: MenuItem[], x: number, y: number): void {
  closeMenu();
  const menu = h('div', { class: 'dv-menu tv-menu', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const it of items) {
    if (it.sep) {
      menu.append(h('div', { class: 'dv-menu-sep', role: 'separator' }));
      continue;
    }
    if (it.header) {
      menu.append(h('div', { class: 'tv-menu-h' }, it.label ?? ''));
      continue;
    }
    const b = h(
      'button',
      {
        role: 'menuitem',
        disabled: !!it.disabled,
        onclick: (e: Event) => {
          e.stopPropagation();
          closeMenu();
          it.run?.();
        },
      },
      it.icon ? icon(it.icon, 14) : h('span', { class: 'ic-sp' }),
      h('span', { class: 'lbl' }, it.label ?? ''),
      it.kbd ? h('span', { class: 'dv-kbd' }, it.kbd) : null,
    );
    buttons.push(b);
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') enabled[(i + 1) % enabled.length]?.focus();
    else if (e.key === 'ArrowUp') enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    else if (e.key === 'Escape') {
      closeMenu();
      restore?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const restore = document.activeElement as HTMLElement | null;
  place(menu, x, y);
  openMenu = menu;
  buttons.find((b) => !b.disabled)?.focus();
}

/** Popover anchored at a point; returns the element so callers can fill it. */
export function showPop(content: HTMLElement, x: number, y: number, cls = ''): HTMLElement {
  closePop();
  restoreFocus = document.activeElement as HTMLElement | null;
  const pop = h('div', { class: 'dv-pop tv-pop ' + cls, role: 'dialog' }, content);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePop();
    }
  });
  place(pop, x, y);
  openPop = pop;
  return pop;
}

document.addEventListener(
  'mousedown',
  (e) => {
    const tgt = e.target as Node;
    if (openMenu && !openMenu.contains(tgt)) closeMenu();
    if (openPop && !openPop.contains(tgt)) closePop();
  },
  true,
);
window.addEventListener('blur', () => closeMenu());

let toastTimer = 0;
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  let el = document.querySelector<HTMLElement>('.tv-toast');
  if (!el) {
    el = h('div', { class: 'tv-toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.className = 'tv-toast show ' + kind;
  el.replaceChildren(icon(kind === 'error' ? 'warning' : 'check', 14), h('span', null, text));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 4000 : 1600);
}
