// Reading features shared by the script we add to VS Code's Markdown preview (webview/md-preview.ts) and our own
// Markdown editor (webview/md-editor.ts): code copy buttons, image lightbox, back-to-top, wide-table layout. All of it is
// event delegation or idempotent re-runs, so it survives any re-rendering of `.markdown-body`.

export interface FeatureStrings {
  top: string;
  close: string;
}

export function defaultStrings(): FeatureStrings {
  return /^zh/i.test(navigator.language || '') ? { top: '回到顶部', close: '关闭（Esc）' } : { top: 'Back to top', close: 'Close (Esc)' };
}

// ---- copy buttons (markup comes from the markdown-it plugin) ------------------------------------------------------

export function copyText(text: string): Promise<boolean> {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, fallback);
  return Promise.resolve(fallback());
}

function onCopy(btn: HTMLElement) {
  const code = btn.closest('.dv-code')?.querySelector('pre');
  if (!code) return;
  const text = (code.querySelector('code') ?? code).textContent?.replace(/\n$/, '') ?? '';
  void copyText(text).then((ok) => {
    if (!ok) return;
    const label = btn.querySelector('.dv-copy-text');
    const before = label?.textContent ?? '';
    btn.classList.add('dv-copied');
    if (label) label.textContent = btn.dataset.copied || before;
    window.setTimeout(() => {
      btn.classList.remove('dv-copied');
      if (label) label.textContent = before;
    }, 1600);
  });
}

// ---- copy + image lightbox wiring ---------------------------------------------------------------------------------

/** Our own controls: a double-click on them must not reach the page's double-click handling. */
export const OWN_CONTROLS = '.dv-lightbox, .dv-copy, .dv-top, .dv-code-bar, .markdown-body img';

export function installCopyAndZoom(T: FeatureStrings): { isOpen(): boolean; close(): void } {
  let box: HTMLElement | undefined;

  const zoomable = (img: HTMLImageElement) => {
    if (!img.closest('.markdown-body') || img.closest('a') || !img.complete) return false;
    return !(img.naturalWidth && img.naturalWidth < 24 && img.naturalHeight < 24); // icons, badges
  };

  function openBox(img: HTMLImageElement) {
    closeBox(true);
    const el = document.createElement('div');
    el.className = 'dv-lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.title = T.close;
    const big = document.createElement('img');
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    // Fit the viewport; small images are enlarged a little (at most 2×) so zooming is worth the click.
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw && nh) {
      const scale = Math.min((window.innerWidth * 0.92) / nw, (window.innerHeight * 0.86) / nh, Math.max(1, 2 * Math.min(1, 640 / Math.max(nw, nh))));
      big.style.width = `${Math.round(nw * scale)}px`;
      big.style.height = `${Math.round(nh * scale)}px`;
    }
    el.appendChild(big);
    const caption = img.alt || img.title;
    if (caption) {
      const c = document.createElement('div');
      c.className = 'dv-lightbox-caption';
      c.textContent = caption;
      el.appendChild(c);
    }
    document.body.appendChild(el);
    box = el;
    void el.offsetWidth; // start the transition from the initial state
    el.classList.add('dv-open');
  }

  function closeBox(now = false) {
    const el = box;
    if (!el) return;
    box = undefined;
    el.classList.remove('dv-open');
    // Keep it in the DOM briefly: the fade-out, and a double-click's second click still lands on it (see dblclick).
    window.setTimeout(() => el.remove(), now ? 0 : 180);
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (box && (t === box || box.contains(t))) {
      closeBox();
      return;
    }
    const btn = t.closest<HTMLElement>('.dv-copy');
    if (btn) {
      e.preventDefault();
      onCopy(btn);
      return;
    }
    if (t instanceof HTMLImageElement && zoomable(t)) {
      e.preventDefault();
      openBox(t);
    }
  });
  window.addEventListener(
    'dblclick',
    (e) => {
      if (e.target instanceof Element && e.target.closest(OWN_CONTROLS)) e.stopPropagation();
    },
    true,
  );
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box) {
      e.preventDefault();
      e.stopPropagation();
      closeBox();
    }
  });
  window.addEventListener('wheel', () => box && closeBox(), { passive: true });
  return { isOpen: () => !!box, close: () => closeBox() };
}

// ---- back to top --------------------------------------------------------------------------------------------------

export function createBackToTop(label: string): { el: HTMLButtonElement; update(): void } {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'dv-top';
  el.title = label;
  el.setAttribute('aria-label', label);
  el.tabIndex = -1;
  el.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  let queued = false;
  const update = () => {
    queued = false;
    el.classList.toggle('dv-show', window.scrollY > Math.max(600, window.innerHeight * 1.2));
  };
  window.addEventListener(
    'scroll',
    () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true },
  );
  return { el, update };
}

// ---- wide tables --------------------------------------------------------------------------------------------------
// Without a script every table simply scrolls sideways inside .dv-table-wrap. With it, each table is measured (natural
// and minimum width, two layout passes for all tables together) and gets one of:
//   .dv-wide    top-level table wider than the text column: may use the window's width, centred on the column
//   .dv-fit     displays without overflow (possibly wrapping a little): no scroll container → sticky header row
//   .dv-scroll  too wide anyway: short cells stay on one line (wrapping would only make rows taller) and it scrolls

function contentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}

/** `reserved`: horizontal space taken by side panels (keep in sync with --dvm-reserved in CSS). */
export function layoutTables(reserved = 0): void {
  const wraps = Array.from(document.querySelectorAll<HTMLElement>('.markdown-body .dv-table-wrap')).filter((el) => el.querySelector('table'));
  if (!wraps.length) return;
  const measure = (cls: string) => {
    for (const el of wraps) el.classList.add(cls);
    const widths = wraps.map((el) => el.querySelector('table')!.offsetWidth);
    for (const el of wraps) el.classList.remove(cls);
    return widths;
  };
  for (const el of wraps) el.classList.remove('dv-wide', 'dv-fit', 'dv-scroll');
  const natural = measure('dv-measure');
  const minimum = measure('dv-measure-min');
  const windowAvail = window.innerWidth - 64 - reserved; // keep in sync with .dv-wide's max-width
  wraps.forEach((el, i) => {
    const parent = el.parentElement!;
    const column = contentWidth(parent);
    const topLevel = parent.classList.contains('markdown-body');
    const avail = topLevel ? Math.max(column, windowAvail) : column;
    // Allow a little wrapping to avoid a scrollbar, but not squeezing a big table into a column of fragments.
    const fits = natural[i] <= avail + 1 || (minimum[i] <= avail + 1 && natural[i] <= avail * 1.15);
    el.classList.toggle('dv-wide', topLevel && natural[i] > column + 1);
    el.classList.toggle('dv-fit', fits);
    el.classList.toggle('dv-scroll', !fits);
  });
}

/** Table layout now, or once per frame on resize / image load. */
export function createTableLayout(reserved: () => number = () => 0): { now(): void; queue(): void } {
  let queued = false;
  const now = () => {
    queued = false;
    layoutTables(reserved());
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(now);
    }
  };
  window.addEventListener('resize', queue);
  document.addEventListener('load', (e) => e.target instanceof HTMLImageElement && queue(), true);
  return { now, queue };
}
