// Shared webview helpers for every Data Viewer page: the VS Code API, messaging, a tiny DOM builder and icons.
// Data is always inserted with textContent — never innerHTML — because file contents are untrusted.

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const api: VsCodeApi = acquireVsCodeApi();

export function post(msg: unknown): void {
  api.postMessage(msg);
}

export function onMessage<T>(fn: (msg: T) => void): void {
  window.addEventListener('message', (e: MessageEvent) => fn(e.data as T));
}

export function getState<T>(): T | undefined {
  return api.getState() as T | undefined;
}

export function setState<T>(s: T): void {
  api.setState(s);
}

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

/** h('button', { class: 'dv-btn', title: 'x', onclick: fn }, icon('copy'), 'Copy') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 16×16, 1.5px stroke icons (drawn for this extension). Paths only, so they inherit currentColor.
const ICONS: Record<string, string> = {
  search: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronRight: 'M6 3.5L10.5 8 6 12.5',
  chevronDown: 'M3.5 6L8 10.5 12.5 6',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  edit: 'M10.5 2.5l3 3-8 8H2.5v-3zM9 4l3 3',
  sortAsc: 'M4 12.5v-9M1.5 6L4 3.5 6.5 6M9 4.5h5M9 8h3.5M9 11.5h2',
  sortDesc: 'M4 3.5v9M1.5 10L4 12.5 6.5 10M9 4.5h2M9 8h3.5M9 11.5h5',
  filter: 'M2 3h12L9.5 8.5v4.5l-3-1.5v-3z',
  columns: 'M2.5 2.5h11v11h-11zM6.2 2.5v11M9.8 2.5v11',
  wrap: 'M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8M9.5 10.5L8 12l1.5 1.5M2.5 12h3',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  plus: 'M8 3v10M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9',
  warning: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 12v.01',
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 7.5v4M8 5v.01',
  check: 'M3 8.5l3 3 7-7',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  expand: 'M3 6l5 5 5-5M3 2.5h10',
  collapse: 'M3 10l5-5 5 5M3 13.5h10',
  table: 'M2.5 3h11v10h-11zM2.5 6.5h11M2.5 10h11M6.5 6.5V13',
  braces: 'M5.5 2.5c-1.5 0-2 .7-2 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  download: 'M8 2.5v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeOff: 'M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4.2 4.7C2.6 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.4 3.4-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 1.9',
  pin: 'M6 2.5h4l-.5 4 2.5 2.5H4L6.5 6.5zM8 9v4.5',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5',
  play: 'M5 3l8 5-8 5z',
  pause: 'M5 3.5v9M11 3.5v9',
  hash: 'M3 6h10M3 10h10M6.5 2.5L5.5 13.5M10.5 2.5l-1 11',
  text: 'M3 3.5h10M8 3.5v9',
  calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
  toggle: 'M5 4.5h6a3.5 3.5 0 0 1 0 7H5a3.5 3.5 0 0 1 0-7zM11 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  link: 'M6.5 9.5l3-3M5 7L3.5 8.5a2.5 2.5 0 0 0 3.5 3.5L8.5 10.5M11 9l1.5-1.5A2.5 2.5 0 0 0 9 4L7.5 5.5',
};

export type IconName = keyof typeof ICONS | string;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('dv-icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.info);
  svg.append(path);
  return svg;
}

/** Strings come from the host (literal vscode.l10n.t calls); this just looks them up with {0} substitution. */
let strings: Record<string, string> = {};
export function setStrings(s: Record<string, string>): void {
  strings = s;
}
export function t(key: string, ...args: (string | number)[]): string {
  const s = strings[key] ?? key;
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => String(args[+i] ?? '')) : s;
}

/** Coalesce work into one animation frame. */
export function rafThrottle(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export const nf = new Intl.NumberFormat(document.documentElement.lang || undefined);

export function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(n >= 100 ? 0 : 1) : n} ${u[i]}`;
}

/** Copy text via the host (navigator.clipboard is unreliable inside webviews). */
export function copyText(text: string): void {
  post({ type: 'copy', text });
}
