#!/usr/bin/env node
// Consistency checks between src/, package.json, the NLS files and the l10n bundle. No dependencies.
//   node scripts/check-manifest.mjs
// Exits 1 when a problem is found; warnings are printed but do not fail.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(root, p);
const errors = [];
const warnings = [];
const error = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (err) {
    error(`${file}: ${err.message}`);
    return undefined;
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Undo JS string escapes of a literal body. */
function unescapeJs(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[e] ?? e;
  });
}

/** Strip // and /* *\/ comments while leaving string literals intact (good enough for our sources). */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const STR = String.raw`'((?:\\[\s\S]|[^'\\])*)'|"((?:\\[\s\S]|[^"\\])*)"|\x60((?:\\[\s\S]|[^\x60\\])*)\x60`;
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ---------------------------------------------------------------------------------------------------------------
// Scan src/
const sources = walk(path.join(root, 'src')).map((f) => ({ file: f, text: stripComments(fs.readFileSync(f, 'utf8')) }));

/** message -> first location */
const l10nStrings = new Map();
const registered = new Map(); // command id -> location
const referenced = new Map(); // command id -> location (executeCommand, TreeItem.command, markdown links)

for (const { file, text } of sources) {
  const at = (i) => `${rel(file)}:${lineOf(text, i)}`;

  const callRe = /\bl10n\.t\(\s*/g;
  for (let m; (m = callRe.exec(text)); ) {
    const rest = text.slice(callRe.lastIndex);
    const lit = new RegExp('^(?:' + STR + ')').exec(rest);
    if (lit) {
      if (lit[3] !== undefined && lit[3].includes('${')) {
        error(`${at(m.index)}: l10n.t() with an interpolated template literal cannot be localized`);
        continue;
      }
      const msg = unescapeJs(lit[1] ?? lit[2] ?? lit[3]);
      if (!l10nStrings.has(msg)) l10nStrings.set(msg, at(m.index));
      continue;
    }
    const obj = new RegExp('^\\{[^}]*?\\bmessage\\s*:\\s*(?:' + STR + ')').exec(rest);
    if (obj) {
      const msg = unescapeJs(obj[1] ?? obj[2] ?? obj[3]);
      const comment = /\bcomment\s*:/.test(obj[0]) ? ' (has comment: check the bundle key manually)' : '';
      if (comment) warn(`${at(m.index)}: l10n.t({ message, comment }) — key format differs${comment}`);
      if (!l10nStrings.has(msg)) l10nStrings.set(msg, at(m.index));
      continue;
    }
    warn(`${at(m.index)}: l10n.t() called with a non-literal message; it cannot be checked`);
  }

  const regRe = /\bregister(?:TextEditor)?Command\(\s*(?:'([^']+)'|"([^"]+)")/g;
  for (let m; (m = regRe.exec(text)); ) registered.set(m[1] ?? m[2], at(m.index));

  const refRe = /(?:executeCommand\(\s*|\bcommand\s*:\s*)(?:'(dataViewer\.[\w.]+)'|"(dataViewer\.[\w.]+)")|command:(dataViewer\.[\w.]+)/g;
  for (let m; (m = refRe.exec(text)); ) {
    const id = m[1] ?? m[2] ?? m[3];
    if (!referenced.has(id)) referenced.set(id, at(m.index));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest + NLS
const pkg = readJson('package.json');
const nls = readJson('package.nls.json');
const nlsZh = readJson('package.nls.zh-cn.json');
const bundlePath = 'l10n/bundle.l10n.zh-cn.json';
const bundle = fs.existsSync(path.join(root, bundlePath)) ? readJson(bundlePath) : (error(`${bundlePath} is missing`), {});

if (pkg && nls && nlsZh) {
  const c = pkg.contributes ?? {};
  const declared = new Set((c.commands ?? []).map((x) => x.command));
  const viewIds = new Set(Object.values(c.views ?? {}).flatMap((list) => list.map((v) => v.id)));

  // Duplicates in contributes.commands
  const seen = new Set();
  for (const x of c.commands ?? []) {
    if (seen.has(x.command)) error(`contributes.commands: duplicate ${x.command}`);
    seen.add(x.command);
  }

  // (4) every %key% in package.json exists in both NLS files
  const used = new Set();
  JSON.stringify(pkg).replace(/%([\w.\-]+)%/g, (_, k) => (used.add(k), ''));
  for (const k of used) {
    if (!(k in nls)) error(`package.json uses %${k}% but package.nls.json lacks it`);
    if (!(k in nlsZh)) error(`package.json uses %${k}% but package.nls.zh-cn.json lacks it`);
  }
  for (const k of Object.keys(nls)) if (!used.has(k)) warn(`package.nls.json: unused key ${k}`);
  for (const k of Object.keys(nlsZh)) if (!(k in nls)) error(`package.nls.zh-cn.json: key ${k} is not in package.nls.json`);
  for (const [k, v] of Object.entries(nlsZh)) if (typeof v !== 'string' || !v.trim()) error(`package.nls.zh-cn.json: empty value for ${k}`);

  // (2) command ids used in menus / viewsWelcome / keybindings exist in contributes.commands
  for (const [menu, items] of Object.entries(c.menus ?? {})) {
    for (const it of items) {
      if (it.command && !declared.has(it.command)) error(`menus.${menu}: ${it.command} is not declared in contributes.commands`);
      if (it.alt && !declared.has(it.alt)) error(`menus.${menu}: alt ${it.alt} is not declared in contributes.commands`);
      for (const m of String(it.when ?? '').matchAll(/\bview\s*==\s*([\w.]+)/g)) if (!viewIds.has(m[1])) error(`menus.${menu}: unknown view ${m[1]} in "${it.when}"`);
    }
  }
  for (const kb of c.keybindings ?? []) if (kb.command?.startsWith('dataViewer.') && !declared.has(kb.command)) error(`keybindings: ${kb.command} is not declared`);
  for (const w of c.viewsWelcome ?? []) {
    if (!viewIds.has(w.view)) error(`viewsWelcome: unknown view ${w.view}`);
    const texts = [w.contents];
    const key = /^%(.+)%$/.exec(w.contents ?? '')?.[1];
    if (key) texts.push(nls[key] ?? '', nlsZh[key] ?? '');
    for (const t of texts)
      for (const m of String(t).matchAll(/command:([\w.]+)/g)) {
        const id = m[1];
        if (id.startsWith('dataViewer.') && !declared.has(id) && !(id.endsWith('.focus') && viewIds.has(id.slice(0, -6)))) error(`viewsWelcome(${w.view}): ${id} is not declared in contributes.commands`);
      }
  }
  for (const x of c.commands ?? []) {
    if (!x.title) error(`contributes.commands: ${x.command} has no title`);
    if (!x.category) warn(`contributes.commands: ${x.command} has no category`);
  }

  // (3) every registerCommand id in src/ is declared (view focus commands are generated by VS Code)
  for (const [id, loc] of registered) {
    if (id.endsWith('.focus')) continue;
    if (!declared.has(id)) error(`${loc}: command ${id} is registered but not declared in contributes.commands`);
  }
  for (const id of declared) if (!registered.has(id)) warn(`contributes.commands: ${id} is declared but no registerCommand('${id}') was found in src/`);
  for (const [id, loc] of referenced) {
    if (registered.has(id)) continue;
    if (id.endsWith('.focus') && viewIds.has(id.slice(0, -6))) continue;
    warn(`${loc}: ${id} is invoked but never registered${id.endsWith('.focus') ? ' (and no such view is contributed)' : ''}`);
  }

  // views: ids referenced by createTreeView must be contributed
  for (const { file, text } of sources)
    for (const m of text.matchAll(/createTreeView\(\s*'([^']+)'/g)) if (!viewIds.has(m[1])) error(`${rel(file)}: createTreeView('${m[1]}') has no contributes.views entry`);

  // activation events for webview panels must match a createWebviewPanel viewType
  for (const ev of pkg.activationEvents ?? []) {
    const vt = /^onWebviewPanel:(.+)$/.exec(ev)?.[1];
    if (!vt) continue;
    const found = sources.some(({ text }) => text.includes(`'${vt}'`) || text.includes(`"${vt}"`));
    if (!found) warn(`activationEvents: ${ev} — no webview with viewType '${vt}' found in src/ (yet?)`);
  }

  // Referenced files exist
  for (const p of [pkg.icon, ...(c.viewsContainers?.activitybar ?? []).map((x) => x.icon)].filter(Boolean)) if (!fs.existsSync(path.join(root, p))) error(`file not found: ${p}`);
}

// (1) l10n.t strings vs the zh-cn bundle
if (bundle) {
  const placeholders = (s) => [...new Set(String(s).match(/\{\d+\}/g) ?? [])].sort().join(',');
  for (const [msg, loc] of l10nStrings) {
    if (!(msg in bundle)) error(`${loc}: missing zh-cn translation for ${JSON.stringify(msg)}`);
    else if (typeof bundle[msg] !== 'string' || !bundle[msg].trim()) error(`${bundlePath}: empty translation for ${JSON.stringify(msg)}`);
    else if (placeholders(msg) !== placeholders(bundle[msg])) error(`${bundlePath}: placeholders differ for ${JSON.stringify(msg)}: ${JSON.stringify(bundle[msg])}`);
  }
  for (const k of Object.keys(bundle)) if (!l10nStrings.has(k)) error(`${bundlePath}: stale key ${JSON.stringify(k)} (no longer used in src/)`);
}

// ---------------------------------------------------------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(`${l10nStrings.size} l10n strings, ${registered.size} registered commands, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
