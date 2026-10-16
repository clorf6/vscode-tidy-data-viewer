// One adapter per format: parse into the Store, map edit operations to text edits, and the whole-document actions.
// Pure (no `vscode` import) so it is unit-testable; the session turns TextEdits into WorkspaceEdits.
import { LineIndex, Store, TextEdit, minimalEdit } from './model';
import { EditError, JsonParser, allJsonErrors, jsonEdit, jsonFormat, jsonMinify, jsonSortKeys } from './json';
import { parseYaml, yamlEdit, yamlFormat, yamlSortKeys, YamlResult } from './yaml';
import { parseToml, tomlEdit, TomlResult } from './toml';
import { parseIni, iniEdit, IniResult } from './ini';
import { parseXml } from './xml';
import { EditOp, Format, PathStyle, Syntax } from './protocol';

export interface RawErr {
  offset: number;
  message: string;
  warning?: boolean;
  line?: number;
  col?: number;
}

export interface Parsed {
  format: Format;
  store: Store;
  errors: RawErr[];
  /** tree is incomplete (stopped at an error) */
  partial: boolean;
  /** label key: json | jsonc | yaml | toml | ini | env | xml */
  label: string;
  docs?: number;
  readOnly?: 'xml';
  ms: number;
  edit(op: EditOp, o: EditCtx): TextEdit[];
  formatDoc?(indent: number, eol: string): TextEdit[];
  minify?(): TextEdit[];
  sortKeys?(): TextEdit[];
  pathStyles: PathStyle[];
  syntaxes: Syntax[];
  layout: 'tree' | 'ini';
  keyWidth?: number;
}

export interface EditCtx {
  unit: string;
  eol: string;
}

export function formatOf(fileName: string, languageId?: string): Format {
  const name = fileName.split(/[\\/]/).pop()!.toLowerCase();
  if (/\.(ya?ml)$/.test(name)) return 'yaml';
  if (name.endsWith('.toml')) return 'toml';
  if (name.endsWith('.ini')) return 'ini';
  if (name.endsWith('.xml')) return 'xml';
  if (/^\.env(\..*)?$/.test(name) || name.endsWith('.env')) return 'env';
  if (/\.(json|geojson|jsonc)$/.test(name)) return 'json';
  switch (languageId) {
    case 'yaml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'ini':
      return 'ini';
    case 'xml':
      return 'xml';
    case 'dotenv':
      return 'env';
    default:
      return 'json';
  }
}

const JSON_PATHS: PathStyle[] = ['jsonpath', 'js', 'jq', 'pointer'];

/** Parse; JSON is parsed in slices (`yieldFn` between slices) so a 50 MB file doesn't freeze the extension host. */
export async function parseDoc(format: Format, text: string, yieldFn?: (progress: number) => Promise<boolean>): Promise<Parsed | undefined> {
  const t0 = performance.now();
  switch (format) {
    case 'json': {
      const p = new JsonParser(text);
      while (!p.step(yieldFn ? 25 : 1e9)) {
        if (yieldFn && !(await yieldFn(p.progress))) return undefined;
      }
      const r = p.result();
      let errors: RawErr[] = r.errors.map((e) => ({ offset: e.offset, message: e.message }));
      // jsonc-parser recovers and lists every error, which reads better in the banner (cheap below 8 MB)
      if (errors.length && text.length < 8 * 1024 * 1024) errors = allJsonErrors(text).map((e) => ({ offset: e.offset, message: e.message }));
      const st = r.store;
      return {
        format,
        store: st,
        errors,
        partial: r.partial,
        label: r.comments ? 'jsonc' : 'json',
        ms: performance.now() - t0,
        edit: (op, o) => jsonEdit(st, op, o),
        formatDoc: (indent, eol) => jsonFormat(text, indent, eol),
        minify: () => one(text, jsonMinify(text)),
        sortKeys: () => {
          const e = jsonSortKeys(st);
          return e ? [e] : [];
        },
        pathStyles: JSON_PATHS,
        syntaxes: ['json', 'yaml'],
        layout: 'tree',
      };
    }
    case 'yaml': {
      const r: YamlResult = parseYaml(text);
      const li = r.errors.length ? new LineIndex(text) : undefined;
      return {
        format,
        store: r.store,
        errors: r.errors.map((e) => ({ offset: e.offset, message: e.message, warning: e.warning, ...li!.pos(e.offset) })),
        partial: false,
        label: 'yaml',
        docs: r.docs.length,
        ms: performance.now() - t0,
        edit: (op, o) => yamlEdit(r, op, o),
        formatDoc: (indent) => one(text, yamlFormat(text, indent)),
        sortKeys: () => one(text, yamlSortKeys(text)),
        pathStyles: JSON_PATHS,
        syntaxes: ['yaml', 'json'],
        layout: 'tree',
      };
    }
    case 'toml': {
      const r: TomlResult = parseToml(text);
      return {
        format,
        store: r.store,
        errors: r.errors.map((e) => ({ offset: e.offset, message: e.message, line: e.line, col: e.col })),
        partial: !!r.errors.length,
        label: 'toml',
        ms: performance.now() - t0,
        edit: (op, o) => tomlEdit(r, op, o.eol),
        pathStyles: JSON_PATHS,
        syntaxes: ['json', 'yaml'],
        layout: 'tree',
      };
    }
    case 'ini':
    case 'env': {
      const r: IniResult = parseIni(text, format === 'env');
      return {
        format,
        store: r.store,
        errors: r.errors.map((e) => ({ offset: e.offset, message: e.message, line: e.line, col: 1, warning: true })),
        partial: false,
        label: format,
        ms: performance.now() - t0,
        edit: (op, o) => iniEdit(r, op, o.eol),
        pathStyles: ['jsonpath', 'js'],
        syntaxes: ['json', 'yaml'],
        layout: 'ini',
        keyWidth: r.keyWidth,
      };
    }
    case 'xml': {
      const r = parseXml(text);
      return {
        format,
        store: r.store,
        errors: r.errors.map((e) => ({ offset: e.offset, message: e.message, line: e.line, col: e.col })),
        partial: !!r.errors.length,
        label: 'xml',
        readOnly: 'xml',
        ms: performance.now() - t0,
        edit: () => {
          throw new EditError('Unsupported edit');
        },
        pathStyles: ['xpath', 'jsonpath'],
        syntaxes: ['xml', 'json', 'yaml'],
        layout: 'tree',
      };
    }
  }
}

function one(a: string, b: string): TextEdit[] {
  const e = minimalEdit(a, b);
  return e ? [e] : [];
}
