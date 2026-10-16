// Markdown preview enhancements (src/markdown). Runs markdown-it with the plugin, inside a stand-in for the parts of
// VS Code's preview engine that matter here (markdown-language-features 1.118): its front_matter rule, heading-id
// wrapper with the preview's slugifier, and the source_map_data_attribute rule that drives scroll sync.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import MarkdownIt from 'markdown-it';
import { extendMarkdownIt } from '../src/markdown/plugin';
import { parseFrontMatter } from '../src/markdown/frontMatter';
import { slugify } from '../src/markdown/toc';
import { addColumn, classifyRef, emptyRow, escapeCell, replaceCell, rewriteMedia, sanitizeHtml, splitRow, toggleTaskLine, unescapeCell } from '../src/markdown/source';
import { registry } from './vscode-mock';

type Env = Record<string, unknown>;

function setConfig(values: Record<string, unknown>) {
  for (const k of Object.keys(registry.config)) delete registry.config[k];
  Object.assign(registry.config, values);
  registry.configEmitter.fire({ affectsConfiguration: () => true });
}

// ---- the preview's engine, reduced to what interacts with the plugin ---------------------------------------------
const PREVIEW_STRIP = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu; // stand-in; parity with the real table is tested below

function previewSlugger() {
  const seen = new Map<string, { count: number }>();
  const from = (t: string) => t.trim().toLowerCase().replace(PREVIEW_STRIP, '').replace(/\s/g, '-');
  return {
    add(text: string) {
      const v = from(text);
      const e = seen.get(v);
      if (e) return from(v + '-' + ++e.count);
      seen.set(v, { count: 0 });
      return v;
    },
  };
}

function headingText(t: MarkdownIt.Token): string {
  if (t.children) return t.children.map(headingText).join('');
  return t.type === 'text' || t.type === 'emoji' || t.type === 'code_inline' ? t.content : '';
}

/** markdown-it configured the way VS Code's preview does it, optionally with our plugin. */
function previewEngine(withPlugin = true): MarkdownIt {
  let md: MarkdownIt = new MarkdownIt({ html: true, highlight: (s: string): string => md.utils.escapeHtml(s) });
  md.linkify.set({ fuzzyLink: false });
  if (withPlugin) md = extendMarkdownIt(md);
  // markdown-it-front-matter as installed by the preview (after plugins): hide everything between the fences.
  md.block.ruler.before(
    'fence',
    'front_matter',
    (state, start, end, silent) => {
      if (start !== 0 || !state.src.startsWith('---\n')) return false;
      if (silent) return true;
      let line = 1;
      while (line < end && state.src.slice(state.bMarks[line], state.eMarks[line]) !== '---') line++;
      const tok = state.push('front_matter', '', 0);
      tok.hidden = true;
      tok.block = true;
      tok.map = [0, Math.min(line + 1, end)];
      tok.meta = state.src.slice(state.bMarks[1], state.bMarks[Math.min(line, end - 1)]);
      state.line = Math.min(line + 1, end);
      return true;
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  );
  const heading = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, idx, options, env: Env, self) => {
    const slugger = env.slugifier as ReturnType<typeof previewSlugger>;
    tokens[idx].attrSet('id', slugger.add(headingText(tokens[idx + 1])));
    return heading ? heading(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  md.core.ruler.push('source_map_data_attribute', (state) => {
    for (const t of state.tokens)
      if (t.map && t.type !== 'inline') {
        t.attrSet('data-line', String(t.map[0]));
        t.attrJoin('class', 'code-line');
        t.attrJoin('dir', 'auto');
      }
  });
  const html = md.renderer.rules.html_block!;
  md.renderer.rules.html_block = (tokens, idx, options, env, self) => `<div ${self.renderAttrs(tokens[idx])} ></div>\n` + html(tokens, idx, options, env, self);
  return md;
}

/** Full output, including the editor-only attributes data-line-end / data-task-line. */
function renderRaw(md: MarkdownIt, src: string): string {
  return md.render(src, { slugifier: previewSlugger() });
}
/** What the preview shows (the editor-only attributes are inert there; most assertions ignore them). */
function render(md: MarkdownIt, src: string): string {
  return renderRaw(md, src).replace(/ data-(?:line-end|task-line)="\d+"/g, '');
}

setConfig({});
const md = previewEngine();
const r = (src: string) => render(md, src);
const lineOf = (html: string, needle: RegExp) => needle.exec(html)?.[1];

// ---------------------------------------------------------------------------------------------------------------
test('alerts: all five kinds become titled callouts with icons', () => {
  for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
    const html = r(`> [!${kind}]\n> Body text.`);
    const k = kind.toLowerCase();
    assert.match(html, new RegExp(`<div class="markdown-alert markdown-alert-${k} code-line" data-line="0" dir="auto">`));
    assert.match(html, /<p class="markdown-alert-title" dir="auto"><svg class="dv-icon"[^>]*><path[^>]*><\/path><\/svg>/);
    assert.match(html, new RegExp(`</svg>${kind[0]}${kind.slice(1).toLowerCase()}</p>`));
    assert.match(html, /<p data-line="1" class="code-line" dir="auto">Body text.<\/p>/, 'paragraph after the marker keeps the right source line');
    assert.doesNotMatch(html, /\[!/);
    assert.doesNotMatch(html, /<blockquote/);
  }
});

test('alerts: lower-case marker, custom title, nested content, marker in its own paragraph', () => {
  const html = r('> [!tip] Faster *builds*\n> - one\n> - two\n>\n> ```js\n> x()\n> ```');
  assert.match(html, /markdown-alert-tip/);
  assert.match(html, /<\/svg>Faster <em>builds<\/em><\/p>/);
  assert.match(html, /<ul data-line="1"/);
  assert.match(html, /<code data-line="4" class="code-line language-js"/);
  const alone = r('> [!WARNING]\n>\n> Second paragraph.');
  assert.match(alone, /<\/svg>Warning<\/p>\n<p data-line="2" class="code-line" dir="auto">Second paragraph.<\/p>/);
  assert.equal((alone.match(/<p[ >]/g) ?? []).length, 2, 'the marker-only paragraph is dropped');
});

test('alerts: ordinary quotes are left alone', () => {
  for (const src of ['> just a quote', '> Text [!NOTE] inside', '> [!NOTICE]\n> no', '> [!NOTE]text glued', '[!NOTE] not quoted', '- [!NOTE] in a list']) {
    assert.doesNotMatch(r(src), /markdown-alert/, src);
  }
  const nested = r('> outer\n>\n> > [!NOTE]\n> > inner');
  assert.match(nested, /<blockquote data-line="0"/);
  assert.match(nested, /markdown-alert-note/);
});

test('footnotes: references, titled section, back links, and no data-line inside the notes', () => {
  const html = r('Text[^a] and more[^b].\n\n[^a]: First note.\n[^b]: Second *note*.\n\nAfter.');
  assert.match(html, /<sup class="footnote-ref"><a href="#fn1" id="fnref1">1<\/a><\/sup>/);
  assert.match(html, /<sup class="footnote-ref"><a href="#fn2" id="fnref2">2<\/a><\/sup>/);
  assert.match(html, /<section class="footnotes" aria-label="Footnotes">\n<div class="dv-footnotes-title">Footnotes<\/div>/);
  assert.match(html, /<li id="fn2" class="footnote-item"><p>Second <em>note<\/em>. <a href="#fnref2" class="footnote-backref">/);
  const notes = html.slice(html.indexOf('<section class="footnotes"'));
  assert.doesNotMatch(notes, /data-line/, 'notes move to the end; their source lines would break the monotonic line map');
  assert.match(html, /<p data-line="5" class="code-line" dir="auto">After.<\/p>/);
  assert.doesNotMatch(html, /<hr class="footnotes-sep">/);
});

test('task lists: disabled checkboxes with GitHub classes, nested and loose lists', () => {
  const html = r('- [ ] todo\n- [x] done\n  - [X] nested\n- plain [ ] item\n');
  assert.match(html, /<ul class="contains-task-list code-line" data-line="0" dir="auto">/);
  assert.match(html, /<li class="task-list-item code-line" data-line="0" dir="auto"><input type="checkbox" class="task-list-item-checkbox" disabled aria-checked="false">todo<\/li>/);
  assert.match(html, /<li class="task-list-item task-list-item-checked code-line" data-line="1" dir="auto"><input type="checkbox" class="task-list-item-checkbox" disabled checked aria-checked="true">done/);
  assert.match(html, /<ul class="contains-task-list code-line" data-line="2"/);
  assert.match(html, /<li data-line="3" class="code-line" dir="auto">plain \[ \] item<\/li>/);
  const loose = r('1. [x] first\n\n2. [ ] second\n');
  assert.match(loose, /<ol class="contains-task-list code-line" data-line="0" dir="auto">/);
  assert.match(loose, /<p data-line="0" class="code-line" dir="auto"><input type="checkbox"[^>]* checked[^>]*>first<\/p>/);
  assert.doesNotMatch(r('- [ ]not a task'), /checkbox/);
  assert.doesNotMatch(r('[ ] not in a list'), /checkbox/);
});

test('table of contents: links use exactly the ids the preview assigns (duplicates, CJK, inline code)', () => {
  const src = '# Title\n\n[[toc]]\n\n## Intro\n\n## Intro\n\n## 中文 标题！\n\n### `code` heading\n\n#### deep\n\n##### too deep\n';
  const html = r(src);
  const ids = [...html.matchAll(/<h\d[^>]* id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['title', 'intro', 'intro-1', '中文-标题', 'code-heading', 'deep', 'too-deep']);
  const toc = /<nav[^>]*>[\s\S]*?<\/nav>/.exec(html)![0];
  assert.match(toc, /^<nav data-line="2" class="dv-toc code-line" dir="auto" aria-label="Contents">/);
  const hrefs = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
  assert.deepEqual(hrefs, ['intro', 'intro-1', '中文-标题', 'code-heading', 'deep'], 'single H1 above the marker is the title; at most three levels');
  assert.match(toc, /<a href="#code-heading"><code>code<\/code> heading<\/a>/);
  assert.match(toc, /<ul><li><a href="#intro">Intro<\/a><\/li><li><a href="#intro-1">Intro<\/a><\/li><li><a href="#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98">中文 标题！<\/a><ul><li>/);
  // every TOC target exists
  for (const h of hrefs) assert.ok(ids.includes(h), h);
});

test('table of contents: marker variants, reference definitions, nothing to list', () => {
  for (const m of ['[TOC]', '[toc]', '[[TOC]]', '[[_TOC_]]']) assert.match(r(`${m}\n\n## A`), /class="dv-toc/, m);
  assert.doesNotMatch(r('[TOC]\n\n## A\n\n[toc]: https://example.com'), /dv-toc/, 'a defined [toc] link reference wins');
  assert.doesNotMatch(r('Text [[toc]] inline\n\n## A'), /dv-toc/);
  assert.equal(r('[[toc]]').trim(), '', 'no headings → no TOC');
  const multi = r('## A\n\n[[toc]]\n\n## B\n\n[[toc]]');
  assert.equal((multi.match(/<nav /g) ?? []).length, 2);
});

test('heading anchors and ids also work in hosts that assign no ids (plain markdown-it)', () => {
  const plain = extendMarkdownIt(new MarkdownIt());
  const html = plain.render('[[toc]]\n\n## Intro\n\n## Intro\n\n## 中文 标题').replace(/ data-line-end="\d+"/g, '');
  assert.match(html, /<h2 id="intro">Intro<a class="dv-anchor" href="#intro"[^>]*><\/a><\/h2>/);
  assert.match(html, /<h2 id="intro-1">/);
  assert.match(html, /<h2 id="中文-标题">/);
  assert.match(html, /<a href="#intro-1">Intro<\/a>/);
  // rendering the same tokens twice (the preview caches tokens per document version) gives the same HTML
  const tokens = plain.parse('[[toc]]\n\n## X\n\n## X', {});
  assert.equal(plain.renderer.render(tokens, plain.options, {}), plain.renderer.render(tokens, plain.options, undefined));
});

test('slugify matches the preview for tricky headings (values taken from VS Code 1.118)', () => {
  const cases: [string, string][] = [
    ['中文 标题！与重复标题', '中文-标题与重复标题'],
    ['`code` heading', 'code-heading'],
    ['Hello, World! (2024)', 'hello-world-2024'],
    ['C++ & Rust: 入门', 'c--rust-入门'],
    ['Émoji 🚀 Launch', 'émoji--launch'],
    ['日本語の見出し', '日本語の見出し'],
    ['Ⓐ Ⓑ circled', 'ⓐ-ⓑ-circled'],
    ['  Tabs\tand   spaces  ', 'tabsand---spaces'],
    ['full　width　space', 'fullwidthspace'],
    ['x² + y₂', 'x--y'],
    ['Ünïcödé — dash – en', 'ünïcödé--dash--en'],
    ['snake_case and kebab-case', 'snake_case-and-kebab-case'],
  ];
  for (const [text, slug] of cases) assert.equal(slugify(text), slug, text);
  const html = extendMarkdownIt(new MarkdownIt()).render('## A\n\n## A\n\n## A-1');
  assert.deepEqual([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]), ['a', 'a-1', 'a-1'], 'same de-duplication quirk as the preview');
});

test('slugify agrees with the installed preview character table (when VS Code Server is present)', (t) => {
  const servers = path.join(process.env.HOME ?? '', '.vscode-server/cli/servers');
  const dir = fs.existsSync(servers) ? fs.readdirSync(servers).find((d) => d.startsWith('Stable-')) : undefined;
  const file = dir && path.join(servers, dir, 'server/extensions/markdown-language-features/dist/extension.js');
  if (!file || !fs.existsSync(file)) return t.skip('no VS Code Server installation');
  const m = /=(\/\[\\0-\\x1F!-,[^\n]*?\]\/g),\w+=new class\{fromHeading/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return t.skip('slugifier not found in this build');
  const preview = new Function(`return ${m[1]}`)() as RegExp;
  const strippedByPreview = (ch: string) => ch.replace(preview, '') === '';
  const strippedByUs = (ch: string) => slugify('a' + ch + 'a') === 'aa';
  const newer: string[] = []; // letters the preview's Unicode 13 table does not know yet
  for (let c = 0; c < 0x110000; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const ch = String.fromCodePoint(c);
    const a = strippedByPreview(ch);
    const b = strippedByUs(ch);
    if (a === b) continue;
    assert.ok(a && !b, `U+${c.toString(16)}: we strip a character the preview keeps`);
    if (c < 0x10000) newer.push(c.toString(16));
  }
  // In the BMP the only differences are characters added in Unicode 14+ (none of them common).
  const unicode14plus = /^(?:8[789a-d][0-9a-f]|c3c|c5[cd]|cd[cd]|cf3|ece|170d|1715|171f|180f|1a[cde][0-9a-f]|1b4c|1c8[9a]|1dfa|2c2f|2c5f|9ff[d-f]|a7[c-f][0-9a-f])$/;
  assert.deepEqual(newer.filter((h) => !unicode14plus.test(h)), []);
});

test('front matter: compact properties card with chips, links and folded text; data-line kept', () => {
  const src = '---\ntitle: "Hello: world"\ntags: [a, "b c"]\nauthors:\n  - Alice\n  - Bob\nurl: https://example.com/x\ndraft: false\ndesc: >\n  folded\n  text\nnested:\n  a: 1\n---\n# Body';
  const html = r(src);
  assert.match(html, /^<div data-line="0" class="dv-front-matter code-line" dir="auto"><div class="dv-fm-head">/);
  assert.match(html, /<dt>title<\/dt><dd class="dv-fm-text">Hello: world<\/dd>/);
  assert.match(html, /<dt>tags<\/dt><dd class="dv-fm-list"><span class="dv-chip">a<\/span><span class="dv-chip">b c<\/span><\/dd>/);
  assert.match(html, /<dt>authors<\/dt><dd class="dv-fm-list"><span class="dv-chip">Alice<\/span><span class="dv-chip">Bob<\/span>/);
  assert.match(html, /<a href="https:\/\/example.com\/x">https:\/\/example.com\/x<\/a>/);
  assert.match(html, /<dt>desc<\/dt><dd class="dv-fm-text">folded text<\/dd>/);
  assert.match(html, /<dt>nested<\/dt><dd class="dv-fm-raw"><code class="dv-fm-code">a: 1<\/code>/);
  assert.match(html, /<h1 data-line="14"/);
  assert.match(r('---\n<b>x</b>: "<i>"\n---\n'), /<dt>&lt;b&gt;x&lt;\/b&gt;<\/dt><dd class="dv-fm-text">&lt;i&gt;<\/dd>/, 'escaped');
});

test('front matter: odd shapes, unclosed fence, opt-out', () => {
  assert.match(r('---\n- just\n- a list\n---\n'), /<pre class="dv-fm-raw"><code>- just\n- a list\n?<\/code><\/pre>/);
  assert.equal(r('---\nnot front matter\n'), '<hr data-line="0" class="code-line" dir="auto">\n<p data-line="1" class="code-line" dir="auto">not front matter</p>\n', 'an unclosed fence is a thematic break (the stock rule hides the whole document)');
  assert.equal(r('---\n---\nText').trim(), '<p data-line="2" class="code-line" dir="auto">Text</p>');
  setConfig({ 'markdown.frontMatter': 'hide' });
  assert.equal(r('---\na: 1\n---\nText').trim(), '<p data-line="3" class="code-line" dir="auto">Text</p>');
  setConfig({ previewFrontMatter: 'hide' });
  assert.doesNotMatch(r('---\na: 1\n---\nText'), /dv-front-matter/, 'legacy markdown.previewFrontMatter: hide');
  setConfig({});
  assert.deepEqual(parseFrontMatter('a: |\n  line 1\n  line 2\nb: \'it\'\'s\' # c\nc: plain # comment'), [
    { key: 'a', value: { kind: 'text', text: 'line 1\nline 2' } },
    { key: 'b', value: { kind: 'text', text: "it's" } },
    { key: 'c', value: { kind: 'text', text: 'plain' } },
  ]);
});

test('tables: scroll wrapper outside, data-line on table and rows, numeric columns right-aligned', () => {
  const html = r('| name | n | pct | note |\n|---|---|--:|---|\n| a | 1,234 | 5% | x |\n| b | -3.5 | 12% | — |\n| c | n/a | 7% | 2024-01-01 |\n');
  assert.match(html, /^<div class="dv-table-wrap">\n<table data-line="0" class="code-line" dir="auto">/);
  assert.match(html, /<\/table>\n<\/div>\n$/);
  assert.match(html, /<tr data-line="2" class="code-line" dir="auto">/);
  assert.match(html, /<th class="dv-num">n<\/th>/);
  assert.match(html, /<td class="dv-num">1,234<\/td>/);
  assert.match(html, /<td class="dv-num">n\/a<\/td>/);
  assert.match(html, /<th style="text-align:right">pct<\/th>/, 'explicit alignment wins');
  assert.match(html, /<th>note<\/th>/, 'dates are not numbers');
  assert.match(r(`| a |\n|---|\n| ${'长文本'.repeat(10)} |`), /<td class="dv-long">/);
});

test('code blocks: header with language label and copy button; <code> keeps its data-line', () => {
  const html = r('```py\nprint(1)\n```\n\n    indented\n\n```mermaid\ngraph TD\n```');
  assert.match(html, /<div class="dv-code" data-lang="py"><div class="dv-code-bar"><span class="dv-code-lang">Python<\/span><button type="button" class="dv-copy" title="Copy code" aria-label="Copy code" data-copied="Copied"><span class="dv-copy-text">Copy<\/span><\/button><\/div><pre><code data-line="0" class="code-line language-py" dir="auto">print\(1\)\n<\/code><\/pre><\/div>/);
  assert.match(html, /<div class="dv-code dv-code-plain"><div class="dv-code-bar"><button[^>]*>.*?<\/button><\/div><pre data-line="4" class="code-line" dir="auto"><code>indented\n<\/code><\/pre><\/div>/);
  assert.match(html, /\n<pre><code data-line="6" class="code-line language-mermaid" dir="auto">graph TD/, 'diagram languages are left to diagram plugins');
  assert.match(r('```xyz-lang\na\n```'), /<span class="dv-code-lang">xyz-lang<\/span>/);
  assert.match(r('```<b>\na\n```'), /<span class="dv-code-lang">&lt;b&gt;<\/span>/);
});

test('every block keeps its data-line; image-only paragraphs become figures', () => {
  const src = '# H\n\npara\n\n> quote\n\n- item\n\n![alt](a.png)\n\n---\n\n<div>html</div>\n';
  const plain = render(previewEngine(false), src).match(/data-line="\d+"/g);
  const ours = r(src).match(/data-line="\d+"/g);
  assert.deepEqual(ours, plain);
  assert.match(r('![alt](a.png)'), /<p class="dv-figure code-line" data-line="0" dir="auto"><img src="a.png" alt="alt"><\/p>/);
  assert.doesNotMatch(r('text ![alt](a.png)'), /dv-figure/);
});

const SAMPLE = `---
title: 样例
tags: [a, b]
---
# 标题

[[toc]]

## Intro \`code\`

> [!NOTE]
> Alert body[^1].

- [ ] task
- [x] done

| a | b |
|---|--:|
| x | 1 |

\`\`\`ts
const a = 1;
\`\`\`

    indented

![img](a.png)

<details><summary>More</summary>

Hidden **text**.

</details>

[^1]: The note.
`;

test('disabled setting: output is exactly the stock preview output', () => {
  const sample = SAMPLE;
  setConfig({ 'markdown.enhance': false });
  const enhancedOff = render(md, sample);
  setConfig({});
  const stock = render(previewEngine(false), sample);
  assert.equal(enhancedOff, stock);
  assert.notEqual(render(md, sample), stock);
});

test('settings changes refresh open previews; the plugin installs once per engine', () => {
  registry.executed.length = 0;
  setConfig({});
  assert.ok(registry.executed.includes('markdown.preview.refresh'));
  const engine = new MarkdownIt();
  extendMarkdownIt(engine);
  const coreRules = engine.core.ruler.getRules('').length;
  extendMarkdownIt(engine);
  assert.equal(engine.core.ruler.getRules('').length, coreRules);
});

// ---- editor support: block ranges, task lines, source rewriting ------------------------------------------------------

/** [tag.classes, data-line, data-line-end] for every element carrying a range, in document order. */
function ranges(html: string): string[] {
  return [...html.matchAll(/<(\w+)([^>]*?)\sdata-line-end="(\d+)"([^>]*)>/g)].map((m) => {
    const attrs = m[2] + m[4];
    const line = /data-line="(\d+)"/.exec(attrs)?.[1];
    const cls = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(' ').filter((c) => c && c !== 'code-line').join('.');
    return `${m[1]}${cls ? '.' + cls : ''} ${line}-${m[3]}`;
  });
}

test('block ranges: data-line-end on every block, matching each block\'s source lines', () => {
  const src = [
    '---', //                0
    'title: x', //           1
    '---', //                2
    '# Head', //             3
    '', //                   4
    'Para one', //           5
    'continued', //          6
    '', //                   7
    '- a', //                8
    '  - nested', //         9
    '- b', //                10
    '', //                   11
    '> [!NOTE]', //          12
    '> alert body', //       13
    '', //                   14
    '```js', //              15
    'x()', //                16
    '```', //                17
    '', //                   18
    '| a | b |', //          19
    '|---|---|', //          20
    '| 1 | 2 |', //          21
    '', //                   22
    '<div>raw</div>', //     23
    '', //                   24
    '---', //                25
    '', //                   26
    '1. one', //             27
    '', //                   28
    '2. two', //             29
    '', //                   30
    '[[toc]]', //            31
    '', //                   32
    '## Sub', //             33
  ].join('\n');
  assert.deepEqual(ranges(renderRaw(md, src)), [
    'div.dv-front-matter 0-3',
    'h1 3-4',
    'p 5-7',
    'ul 8-12', // lists own the blank line after them (the editor trims it before editing)
    'li 8-10',
    'ul 9-10',
    'li 9-10',
    'li 10-12',
    'div.markdown-alert.markdown-alert-note 12-14',
    'p 13-14',
    'code.language-js 15-18',
    'table 19-22',
    'thead 19-20',
    'tr 19-20',
    'tbody 21-22',
    'tr 21-22',
    'div 23-24',
    'hr 25-26',
    'ol 27-31',
    'li 27-29',
    'p 27-28',
    'li 29-31',
    'p 29-30',
    'nav.dv-toc 31-32',
    'h2 33-34',
  ]);
  // with the enhancements off the ranges are still there (the editor needs them)
  setConfig({ 'markdown.enhance': false });
  assert.match(renderRaw(md, '# A\n\ntext'), /<p data-line-end="3" data-line="2"/);
  setConfig({});
});

test('task checkboxes carry the source line of their [ ] marker', () => {
  const src = '- [ ] one\n- [x] two\n  - [ ] three\n\n> - [ ] quoted';
  const lines = src.split('\n');
  const found = [...renderRaw(md, src).matchAll(/<input[^>]*data-task-line="(\d+)"/g)].map((m) => +m[1]);
  assert.deepEqual(found, [0, 1, 2, 4]);
  for (const l of found) assert.ok(toggleTaskLine(lines[l]) !== undefined, lines[l]);
});

test('toggleTaskLine: markers, quotes, ordered lists; other lines untouched', () => {
  assert.equal(toggleTaskLine('- [ ] a'), '- [x] a');
  assert.equal(toggleTaskLine('- [x] a'), '- [ ] a');
  assert.equal(toggleTaskLine('  * [X] nested'), '  * [ ] nested');
  assert.equal(toggleTaskLine('> 12. [ ] quoted'), '> 12. [x] quoted');
  assert.equal(toggleTaskLine('- [ ] keep [ ] later', true), '- [x] keep [ ] later');
  assert.equal(toggleTaskLine('- [x] a', true), '- [x] a');
  assert.equal(toggleTaskLine('text [ ] no'), undefined);
  assert.equal(toggleTaskLine('-[ ] no space'), undefined);
});

test('table rows: split like markdown-it (escaped pipes, code spans, quotes, optional outer pipes)', () => {
  const cells = (l: string) => splitRow(l).map((c) => c.raw);
  assert.deepEqual(cells('| a | b |'), ['a', 'b']);
  assert.deepEqual(cells('a | b'), ['a', 'b']);
  assert.deepEqual(cells('| a \\| b | c |'), ['a \\| b', 'c']);
  assert.deepEqual(cells('|  | x |'), ['', 'x']);
  assert.deepEqual(cells('> | q | r |'), ['q', 'r']);
  assert.deepEqual(cells('|   |'), ['']);
  // the rendered cells agree with our split, row by row
  const rows = ['| h1 | h2 | h3 |', '|---|---|---|', '| `a|b` | x \\| y | z |', 'p | q', '|  | only2 |'];
  const html = extendMarkdownIt(new MarkdownIt()).render(rows.join('\n'));
  const rendered = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => c[1]));
  // markdown-it keeps as many cells as the header has (extra ones are dropped, missing ones are empty)
  const ours = [rows[0], rows[2], rows[3], rows[4]].map((r) => {
    const c = splitRow(r).map((x) => unescapeCell(x.raw));
    return Array.from({ length: 3 }, (_, i) => c[i] ?? '');
  });
  assert.deepEqual(rendered, ours);
});

test('table rows: replace a cell, escape pipes, pad short rows, add rows and columns', () => {
  assert.equal(replaceCell('| a | b |', 1, 'new'), '| a | new |');
  assert.equal(replaceCell('| a | b |', 0, 'x | y'), '| x \\| y | b |');
  assert.equal(replaceCell('| a \\| b | c |', 1, 'C'), '| a \\| b | C |');
  assert.equal(replaceCell('a | b', 0, 'A'), ' A | b');
  assert.equal(replaceCell('| a |', 2, 'z'), '| a | | z |');
  assert.equal(replaceCell('a | b', 2, 'z'), 'a | b | z');
  assert.equal(replaceCell('> | q | r |', 0, 'Q'), '> | Q | r |');
  assert.equal(escapeCell('two\nlines'), 'two<br>lines');
  assert.equal(escapeCell('keep \\| escaped'), 'keep \\| escaped');
  assert.equal(emptyRow('> | a | b |', 2), '> |   |   |');
  assert.deepEqual(addColumn(['| a | b |', '|---|---|', '| 1 | 2 |']), ['| a | b |  |', '|---|---| --- |', '| 1 | 2 |  |']);
  const html = extendMarkdownIt(new MarkdownIt()).render(addColumn(['| a | b |', '|---|---|', '| 1 | 2 |']).join('\n'));
  assert.equal((html.match(/<th[ >]/g) ?? []).length, 3, 'still a valid table');
});

test('rendered HTML: scripts and handlers stripped, media pointed at webview URIs', () => {
  const dirty = '<p onclick="x()">a</p><script>alert(1)</script><img src="a.png" onerror="evil()"><a href="javascript:alert(1)">l</a><iframe src="https://x"></iframe><meta http-equiv="refresh" content="0;url=https://x"><svg><script>1</script></svg><code>&lt;script&gt;ok&lt;/script&gt;</code>';
  const clean = sanitizeHtml(dirty);
  assert.doesNotMatch(clean, /<script|onclick|onerror|javascript:|<iframe|<meta/i);
  assert.match(clean, /<p>a<\/p>/);
  assert.match(clean, /<img src="a.png">/);
  assert.match(clean, /<a href="#">l<\/a>/);
  assert.match(clean, /&lt;script&gt;ok&lt;\/script&gt;/, 'escaped text inside code is untouched');
  const seen: string[] = [];
  const out = rewriteMedia('<img src="img/a b.png" alt="x"><img src="https://e.com/x.png"><video src=\'v.mp4\' poster="p.jpg"></video><img data-src="keep" src="a&amp;b.png">', (s) => (seen.push(s), classifyRef(s).kind === 'keep' ? null : 'W:' + s));
  assert.deepEqual(seen, ['img/a b.png', 'https://e.com/x.png', 'v.mp4', 'p.jpg', 'a&b.png']);
  assert.match(out, /<img src="W:img\/a b.png" alt="x">/);
  assert.match(out, /<img src="https:\/\/e.com\/x.png">/);
  assert.match(out, /<video src="W:v.mp4" poster="W:p.jpg">/);
  assert.match(out, /src="W:a&amp;b.png"/);
  assert.deepEqual(classifyRef('../img/%E5%9B%BE.png?x=1#f'), { kind: 'path', path: '../img/图.png', suffix: '?x=1#f' });
  assert.deepEqual(classifyRef('file:///a/b.png'), { kind: 'file', uri: 'file:///a/b.png' });
  assert.equal(classifyRef('data:image/png;base64,xx').kind, 'keep');
  assert.equal(classifyRef('mailto:a@b').kind, 'keep');
});
