// Colour values (#hex, rgb(), hsl()): parsing, formatting in the original notation, and colour-space conversions. No
// imports, so it can be tested on its own.

/** r, g, b in 0..255, a in 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Notation = 'hex' | 'rgb' | 'hsl';

export interface Style {
  fmt: Notation;
  upper: boolean;
  short: boolean;
  /** "rgb(1, 2, 3)" rather than "rgb(1 2 3)"; the separator after each comma. */
  comma?: string;
  /** The value had an alpha part (keep one even at full opacity). */
  alpha: boolean;
  pctAlpha: boolean;
  /** Function name as written ("rgba", "RGB"…). */
  fn?: string;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function parseColor(src: string): { c: Rgba; style: Style } | undefined {
  const s = src.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let d = hex[1];
    const short = d.length <= 4;
    if (short) d = [...d].map((x) => x + x).join('');
    const n = (i: number) => parseInt(d.slice(i, i + 2), 16);
    const letters = d.replace(/[0-9]/g, '');
    return {
      c: { r: n(0), g: n(2), b: n(4), a: d.length === 8 ? n(6) / 255 : 1 },
      style: { fmt: 'hex', upper: !!letters && letters === letters.toUpperCase(), short, alpha: d.length === 8, pctAlpha: false },
    };
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*?)\s*\)$/i.exec(s);
  if (!fn) return undefined;
  const name = fn[1];
  const body = fn[2];
  const comma = body.includes(',') ? (/,\s/.test(body) ? ', ' : ',') : undefined;
  const parts = body.split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const num = (p: string, pctOf: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * pctOf : parseFloat(p));
  const aPart = parts[3];
  const a = aPart === undefined ? 1 : clamp(num(aPart, 1), 0, 1);
  const style: Style = { fmt: name.toLowerCase().startsWith('rgb') ? 'rgb' : 'hsl', upper: false, short: false, comma, alpha: aPart !== undefined, pctAlpha: !!aPart?.endsWith('%'), fn: name };
  let c: Rgba;
  if (style.fmt === 'rgb') c = { r: clamp(num(parts[0], 255), 0, 255), g: clamp(num(parts[1], 255), 0, 255), b: clamp(num(parts[2], 255), 0, 255), a };
  else c = { ...hslToRgb(parseFloat(parts[0]), clamp(parseFloat(parts[1]), 0, 100), clamp(parseFloat(parts[2]), 0, 100)), a };
  if ([c.r, c.g, c.b, c.a].some((x) => Number.isNaN(x))) return undefined;
  return { c, style };
}

const fmtAlpha = (a: number, pct: boolean) => (pct ? Math.round(a * 100) + '%' : String(Math.round(a * 1000) / 1000));

export function formatColor(c: Rgba, st: Style): string {
  const withAlpha = st.alpha || c.a < 0.999;
  const r = Math.round(c.r);
  const g = Math.round(c.g);
  const b = Math.round(c.b);
  if (st.fmt === 'hex') {
    const bytes = [r, g, b, ...(withAlpha ? [Math.round(c.a * 255)] : [])];
    let out = bytes.map((x) => x.toString(16).padStart(2, '0')).join('');
    if (st.short && bytes.every((x) => x % 17 === 0)) out = bytes.map((x) => (x / 17).toString(16)).join('');
    return '#' + (st.upper ? out.toUpperCase() : out);
  }
  const vals = st.fmt === 'rgb' ? [String(r), String(g), String(b)] : (() => {
    const { h: hh, s, l } = rgbToHsl(c);
    return [String(Math.round(hh)), Math.round(s) + '%', Math.round(l) + '%'];
  })();
  const base = st.fmt;
  // comma syntax spells an alpha part rgba() / hsla(); space syntax keeps the name as written ("rgb(1 2 3 / .5)")
  let name = st.comma !== undefined ? (withAlpha ? base + 'a' : base) : st.fn?.toLowerCase() === base + 'a' ? base + 'a' : base;
  if (st.fn && st.fn === st.fn.toUpperCase()) name = name.toUpperCase();
  if (st.comma !== undefined) return `${name}(${[...vals, ...(withAlpha ? [fmtAlpha(c.a, st.pctAlpha)] : [])].join(st.comma)})`;
  return `${name}(${vals.join(' ')}${withAlpha ? ' / ' + fmtAlpha(c.a, st.pctAlpha) : ''})`;
}

// ---- colour space conversions (h in degrees, s / v / l in 0..100) ----

export function rgbToHsv({ r, g, b }: Rgba): { h: number; s: number; v: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let hh = 0;
  if (d) hh = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (hh * 60 + 360) % 360, s: max ? (d / max) * 100 : 0, v: max * 100 };
}

export function hsvToRgb(hh: number, s: number, v: number): { r: number; g: number; b: number } {
  const S = s / 100;
  const V = v / 100;
  const f = (n: number) => {
    const k = (n + hh / 60) % 6;
    return (V - V * S * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return { r: f(5), g: f(3), b: f(1) };
}

export function hslToRgb(hh: number, s: number, l: number): { r: number; g: number; b: number } {
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + hh / 30) % 12;
    return (L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return { r: f(0), g: f(8), b: f(4) };
}

export function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const { h: hh } = rgbToHsv({ r, g, b, a: 1 });
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  return { h: hh, s: d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0, l: l * 100 };
}
