// Messages and row shapes shared by the tree host (src/tree) and its webview (webview/tree). No runtime imports here:
// the webview bundle includes this file, so it must stay free of `vscode` and of the parser libraries.

/** Value kind of a node. */
export const enum Kind {
  Obj = 0,
  Arr = 1,
  Str = 2,
  Num = 3,
  True = 4,
  False = 5,
  Null = 6,
  /** YAML alias (`*name`); value = alias name. */
  Alias = 7,
  /** XML/YAML comment; value = comment text. */
  Comment = 8,
  /** TOML date/time, YAML timestamp; value = source text. */
  Date = 9,
}

/** What the key of a node is. */
export const enum KeyKind {
  /** Root (no key). */
  None = 0,
  /** Object property. */
  Prop = 1,
  /** Array element (key = position). */
  Index = 2,
  /** XML attribute (`@id`). */
  Attr = 3,
  /** INI section. */
  Section = 4,
  /** YAML document in a multi-document stream. */
  Doc = 5,
  /** XML element (key = tag name). */
  Elem = 6,
  /** XML text / CDATA / comment pseudo-node. */
  Text = 7,
  /** XML declaration / processing instruction. */
  Decl = 8,
}

export const enum RowKind {
  Node = 0,
  /** Closing bracket line in pretty mode. */
  Close = 1,
  /** Header of an array shown as a table. */
  TableHead = 2,
  /** One element of an array shown as a table. */
  TableRow = 3,
}

export type Format = 'json' | 'yaml' | 'toml' | 'ini' | 'env' | 'xml';
export type Mode = 'tree' | 'pretty';
export type Syntax = 'json' | 'yaml' | 'xml';
export type PathStyle = 'jsonpath' | 'js' | 'jq' | 'pointer' | 'xpath';

/** A collapsed container's inline summary item: [key, kind, text]. */
export type PreviewItem = [string | number | null, Kind, string];

export interface Cell {
  id: number;
  t: Kind;
  v?: string;
  /** child count of a container cell */
  n?: number;
  /** full length when `v` was truncated */
  tr?: number;
}

export interface Row {
  /** node id (for TableHead: the array) */
  id: number;
  r: RowKind;
  /** indentation level */
  d: number;
  /** parent node id (-1 at the top) */
  pid: number;
  k?: string | number;
  kk: KeyKind;
  t: Kind;
  /** primitive value text (strings unquoted, possibly truncated) */
  v?: string;
  /** full length when `v` was truncated */
  tr?: number;
  /** child count for containers */
  n?: number;
  /** expanded */
  x?: 1;
  /** collapsed preview items and whether more follow */
  pv?: PreviewItem[];
  pm?: 1;
  /** badge: YAML tag, &anchor, … */
  tag?: string;
  anchor?: string;
  /** YAML alias: id of the anchored node */
  alias?: number;
  /** trailing comment (YAML/INI) */
  c?: string;
  /** read-only node */
  ro?: 1;
  /** search hit: 1 key, 2 value, 3 both; 4 = current match */
  m?: number;
  /** array can be shown as a table (and is, when 2) */
  tb?: 1 | 2;
  /** last sibling (pretty mode commas) */
  last?: 1;
  /** pretty mode: line number (1-based) and YAML dash count */
  ln?: number;
  dash?: number;
  /** XML element attributes (pretty mode) */
  attrs?: [string, string][];
  /** table rows: owning table (array node id), row position and cells by column */
  tid?: number;
  ti?: number;
  cells?: (Cell | null)[];
  /** table header: columns, widths in characters, sort state */
  cols?: string[];
  cw?: number[];
  sort?: { col: number; desc: boolean };
  /** source line for INI rows (1-based) */
  line?: number;
}

export interface Status {
  format: Format;
  label: string;
  nodes: number;
  bytes: number;
  docs?: number;
  /** null when valid */
  errors: ErrorInfo[];
  /** the tree shown is from an earlier version because the current text does not parse */
  stale?: boolean;
  /** why editing is unavailable (empty when editable) */
  readOnly?: string;
  parseMs?: number;
  canFormat: boolean;
  canMinify: boolean;
  canSort: boolean;
  /** formats for "Copy path" */
  pathStyles: PathStyle[];
  syntaxes: Syntax[];
}

export interface ErrorInfo {
  message: string;
  line: number;
  col: number;
  offset: number;
  severity?: 'error' | 'warning';
}

export interface ViewMsg {
  type: 'view';
  version: number;
  mode: Mode;
  syntax: Syntax;
  total: number;
  start: number;
  rows: Row[];
  status: Status;
  depth: number;
  /** row to select / scroll to (-1: keep) */
  sel?: number;
  selId?: number;
  scrollTo?: number;
  /** keep the scroll position the webview has (re-render of the same document) */
  keepScroll?: boolean;
  /** the INI/.env grouped table look */
  layout: 'tree' | 'ini';
  /** widest key in characters (INI layout) */
  keyWidth?: number;
  filter: boolean;
}

export interface RowsMsg {
  type: 'rows';
  version: number;
  start: number;
  rows: Row[];
}

export interface SearchMsg {
  type: 'search';
  count: number;
  /** 0-based index of the current match, -1 when none */
  current: number;
  capped?: boolean;
  error?: string;
  /** still scanning: count is partial */
  busy?: boolean;
  /** search time so far (ms) */
  ms?: number;
}

export interface FocusSearchMsg {
  type: 'focusSearch';
}

export interface SelectionMsg {
  type: 'selection';
  id: number;
  crumbs: { id: number; label: string; kk: KeyKind }[];
  path: string;
  /** value kind, child count, source position for the status bar */
  info?: string;
}

export interface InitMsg {
  type: 'init';
  strings: Record<string, string>;
  fileName: string;
  format: Format;
  indent: number;
  expandDepth: number;
  /** the webview's saved state is stale (different file) */
}

export interface BusyMsg {
  type: 'busy';
  on: boolean;
  text?: string;
}

export interface ValueMsg {
  type: 'value';
  id: number;
  text: string;
  truncated?: boolean;
  /** for what: popover or edit */
  purpose: 'show' | 'edit';
}

export interface NoticeMsg {
  type: 'notice';
  text: string;
  kind: 'info' | 'error';
}

export type HostMsg = InitMsg | ViewMsg | RowsMsg | SearchMsg | SelectionMsg | BusyMsg | ValueMsg | NoticeMsg | FocusSearchMsg;

export type EditOp =
  | { op: 'set'; id: number; value: string; type: 'string' | 'number' | 'boolean' | 'null' }
  | { op: 'rename'; id: number; key: string }
  | { op: 'delete'; id: number }
  | { op: 'add'; id: number; key?: string; value: string; type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'; after?: number }
  | { op: 'duplicate'; id: number }
  | { op: 'move'; id: number; dir: -1 | 1 };

export interface SearchQuery {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord?: boolean;
  /** what to match: keys and values, keys only or values only */
  scope?: 'all' | 'keys' | 'values';
  filter: boolean;
}

/** State the webview keeps with setState (survives the webview being re-created while hidden). */
export interface WebState {
  uri?: string;
  scrollTop?: number;
  mode?: Mode;
  syntax?: Syntax;
  search?: SearchQuery;
  selPath?: (string | number)[];
}

export type WebMsg =
  | { type: 'ready'; state?: WebState }
  | { type: 'rows'; start: number; end: number; version: number }
  | { type: 'toggle'; id: number; expand?: boolean; recursive?: boolean }
  | { type: 'depth'; depth: number }
  | { type: 'mode'; mode: Mode; syntax?: Syntax }
  | { type: 'table'; id: number; on: boolean }
  | { type: 'tableSort'; id: number; col: number }
  | { type: 'select'; id: number }
  | { type: 'reveal'; id: number; select?: boolean }
  | { type: 'search'; query: SearchQuery }
  | { type: 'searchNav'; dir: 1 | -1 }
  | { type: 'edit'; edit: EditOp }
  | { type: 'copy'; text: string }
  | { type: 'copyNode'; id: number; what: 'value' | 'json' | 'yaml' | 'xml' | 'key' | 'path'; style?: PathStyle }
  | { type: 'getValue'; id: number; purpose: 'show' | 'edit' }
  | { type: 'openUrl'; url: string }
  | { type: 'action'; name: 'format' | 'minify' | 'sortKeys' | 'openText' }
  | { type: 'source'; id: number }
  | { type: 'gotoError'; index: number }
  | { type: 'openCell'; id: number };
