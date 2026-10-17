// Colour values for the tree's colour picker: parsing, keeping the notation when writing back, conversions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatColor, hslToRgb, hsvToRgb, parseColor, rgbToHsl, rgbToHsv } from '../webview/tree/colormath';

const round = (s: string) => {
  const p = parseColor(s)!;
  assert.ok(p, s);
  return formatColor(p.c, p.style);
};

test('colours round-trip in their own notation', () => {
  for (const s of ['#3794ff', '#3794FF', '#abc', '#ABCD', '#11223344', 'rgb(30, 30, 30)', 'rgb(30,30,30)', 'rgba(1, 2, 3, 0.5)', 'rgb(1 2 3)', 'rgb(1 2 3 / 0.25)', 'hsl(210, 50%, 40%)', 'hsla(210, 50%, 40%, 0.8)', 'RGB(10, 20, 30)'])
    assert.equal(round(s), s);
});

test('a new colour keeps case, short hex, separators; opacity adds an alpha part in the same style', () => {
  const p = parseColor('#ABC')!;
  assert.equal(formatColor({ r: 255, g: 0, b: 0, a: 1 }, p.style), '#F00');
  assert.equal(formatColor({ r: 255, g: 1, b: 0, a: 1 }, p.style), '#FF0100');
  assert.equal(formatColor({ r: 255, g: 0, b: 0, a: 0.5 }, parseColor('#ff0000')!.style), '#ff000080');
  assert.equal(formatColor({ r: 10, g: 20, b: 30, a: 0.5 }, parseColor('rgb(1, 2, 3)')!.style), 'rgba(10, 20, 30, 0.5)');
  assert.equal(formatColor({ r: 10, g: 20, b: 30, a: 0.5 }, parseColor('rgb(1 2 3)')!.style), 'rgb(10 20 30 / 0.5)');
  assert.equal(formatColor({ r: 10, g: 20, b: 30, a: 1 }, parseColor('rgba(1, 2, 3, 1)')!.style), 'rgba(10, 20, 30, 1)');
  assert.equal(formatColor({ r: 255, g: 0, b: 0, a: 0.4 }, parseColor('hsl(0, 100%, 50%)')!.style), 'hsla(0, 100%, 50%, 0.4)');
  assert.equal(formatColor({ r: 0, g: 0, b: 0, a: 0.5 }, parseColor('rgba(0, 0, 0, 50%)')!.style), 'rgba(0, 0, 0, 50%)');
});

test('parsing: percentages, rejects non-colours', () => {
  assert.deepEqual(parseColor('rgb(100%, 0%, 50%)')!.c, { r: 255, g: 0, b: 127.5, a: 1 });
  assert.equal(parseColor('#12'), undefined);
  assert.equal(parseColor('rgb(1, 2)'), undefined);
  assert.equal(parseColor('blue'), undefined);
});

test('conversions agree', () => {
  for (const c of [{ r: 55, g: 148, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, { r: 200, g: 30, b: 90, a: 1 }]) {
    const v = rgbToHsv(c);
    const back = hsvToRgb(v.h, v.s, v.v);
    const l = rgbToHsl(c);
    const back2 = hslToRgb(l.h, l.s, l.l);
    for (const k of ['r', 'g', 'b'] as const) {
      assert.ok(Math.abs(back[k] - c[k]) < 0.5, `hsv ${k}`);
      assert.ok(Math.abs(back2[k] - c[k]) < 0.5, `hsl ${k}`);
    }
  }
});
