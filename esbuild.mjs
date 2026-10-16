import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');
const common = { bundle: true, minify: !dev, sourcemap: dev ? 'inline' : false, logLevel: 'info', legalComments: 'none' };
const web = { ...common, platform: 'browser', format: 'iife', target: 'es2020' };

const builds = [
  // mainFields: prefer ESM entries (jsonc-parser's UMD build has dynamic requires that break when bundled).
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], mainFields: ['module', 'main'] },
  { ...web, entryPoints: ['webview/table.ts'], outfile: 'dist/table.js' },
  { ...web, entryPoints: ['webview/tree.ts'], outfile: 'dist/tree.js' },
  { ...web, entryPoints: ['webview/md-preview.ts'], outfile: 'dist/md-preview.js' },
  { ...web, entryPoints: ['webview/md-editor.ts'], outfile: 'dist/md-editor.js' },
];
// Tests: every test/*.test.ts becomes out/<name>.test.js (Node, unminified; never shipped).
for (const f of fs.existsSync('test') ? fs.readdirSync('test') : []) {
  if (f.endsWith('.test.ts')) builds.push({ ...common, minify: false, entryPoints: [`test/${f}`], outfile: `out/${f.replace(/\.ts$/, '.js')}`, platform: 'node', format: 'cjs', target: 'node18', alias: { vscode: './test/vscode-mock.ts' } });
}

/** Each module keeps its own zh-cn strings in l10n/zh-cn/<module>.json; VS Code wants one bundle. */
function mergeL10n() {
  const dir = 'l10n/zh-cn';
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.json')) Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  fs.writeFileSync('l10n/bundle.l10n.zh-cn.json', JSON.stringify(out, null, 2) + '\n');
}

mergeL10n();
const existing = builds.filter((b) => fs.existsSync(b.entryPoints[0]));
if (watch) {
  for (const b of existing) (await esbuild.context(b)).watch();
} else {
  await Promise.all(existing.map((b) => esbuild.build(b)));
}
