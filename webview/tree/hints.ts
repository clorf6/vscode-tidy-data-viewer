// Smart value hints: links, colours and timestamps (ISO strings and epoch numbers under time-like keys).
import { t } from '../shared/vscode';

const URL_RE = /^(https?|ftp):\/\/[^\s"'<>]+$|^mailto:[^\s"'<>]+$/i;
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\(\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*[, ]\s*[\d.]+%?(?:\s*[,/]\s*[\d.]+%?)?\s*\))$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const TIME_KEY = /(time|date|_at$|At$|^at$|^ts$|_ts$|timestamp|created|updated|modified|expires?|^exp$|^iat$|^nbf$|since|until|last_?seen|birth)/i;

export function isUrl(s: string): boolean {
  return s.length < 4096 && URL_RE.test(s);
}

export function colorOf(s: string): string | undefined {
  return s.length <= 40 && COLOR_RE.test(s.trim()) ? s.trim() : undefined;
}

export interface TimeHint {
  date: Date;
  /** 's' | 'ms' for epoch numbers, 'iso' for strings */
  unit: 's' | 'ms' | 'iso';
}

export function isoTime(s: string): TimeHint | undefined {
  if (s.length < 10 || s.length > 40 || !ISO_RE.test(s)) return undefined;
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? undefined : { date: d, unit: 'iso' };
}

export function epochTime(num: string, key: string | number | undefined): TimeHint | undefined {
  if (typeof key !== 'string' || !TIME_KEY.test(key) || !/^\d{9,13}(\.\d+)?$/.test(num)) return undefined;
  const n = Number(num);
  if (n >= 3e8 && n < 4.1e9) return { date: new Date(n * 1000), unit: 's' };
  if (n >= 3e11 && n < 4.1e12) return { date: new Date(n), unit: 'ms' };
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let rtf: Intl.RelativeTimeFormat | undefined;
export function relative(d: Date): string {
  rtf ??= new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto' });
  const s = (d.getTime() - Date.now()) / 1000;
  const a = Math.abs(s);
  const [v, u]: [number, Intl.RelativeTimeFormatUnit] =
    a < 60 ? [s, 'second'] : a < 3600 ? [s / 60, 'minute'] : a < 86400 ? [s / 3600, 'hour'] : a < 86400 * 30 ? [s / 86400, 'day'] : a < 86400 * 365 ? [s / (86400 * 30), 'month'] : [s / (86400 * 365), 'year'];
  return rtf.format(Math.round(v), u);
}

export function timeTooltip(h: TimeHint): string {
  const lines = [`${t('Local time')}: ${localTime(h.date)} (${relative(h.date)})`, `${t('UTC')}: ${h.date.toISOString()}`];
  if (h.unit === 's') lines.push(t('Unix time (seconds)'));
  if (h.unit === 'ms') lines.push(t('Unix time (milliseconds)'));
  return lines.join('\n');
}
