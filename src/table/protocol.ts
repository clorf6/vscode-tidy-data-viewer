// Messages between the table host (src/table) and its webview (webview/table). Type-only: imported by both sides.

export type TableKind = 'csv' | 'jsonl' | 'log' | 'parquet';
export type ColType = 'int' | 'float' | 'bool' | 'date' | 'json' | 'string' | 'empty';
export type Density = 'compact' | 'normal' | 'comfortable';

/** A logical column. `key` is stable across inserts/deletes (UI state is keyed by it). */
export interface ColMeta {
  key: number;
  name: string;
  type: ColType;
  /** Parquet: physical / logical type, shown in the schema panel. */
  physical?: string;
  logical?: string;
  /** Parquet: OPTIONAL / REQUIRED / REPEATED. */
  repetition?: string;
}

/** Cell kinds for JSONL/Parquet cells (one char per column): s string, n number, b bool, z null, o object, a array, u missing. */
export type CellKinds = string;

export interface LogLine {
  /** Level code, see LEVELS. */
  lv: number;
  /** ANSI styling runs over the stripped text: [start, end, style] — style is "fg;bg;flags" (see webview/table/log.ts). */
  sp?: [number, number, string][];
  /** Timestamp range in the text. */
  ts?: [number, number];
  /** Level token range in the text. */
  lt?: [number, number];
}

export interface RowData {
  /** Stable row id (source row index, or ≥ ADDED_BASE for inserted rows). */
  id: number;
  /** 1-based line number in the source (for the gutter); 0 for new rows. */
  ln: number;
  /** Display strings, one per logical column. Long values are cut (see `tr`). */
  c: string[];
  k?: CellKinds;
  /** Indices of cells whose value was truncated for display. */
  tr?: number[];
  /** 1 = invalid line (JSONL), 2 = edited. */
  f?: number;
  log?: LogLine;
}

export type FilterOp = 'contains' | 'notContains' | 'equals' | 'notEquals' | 'startsWith' | 'endsWith' | 'regex' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty' | 'in';

export interface Filter {
  key: number;
  op: FilterOp;
  value?: string;
  values?: string[];
}

export interface SortSpec {
  key: number;
  dir: 'asc' | 'desc';
}

export interface Query {
  sort?: SortSpec | null;
  filters: Filter[];
  /** Logs: bitmask of visible levels (bit = level code); undefined = all. */
  levels?: number;
  /** Text filter ("filter rows to matches"; for logs the line filter). */
  text?: string;
  regex?: boolean;
  matchCase?: boolean;
  word?: boolean;
  /** Columns the text filter looks at (default: all). */
  keys?: number[];
}

export interface Stats {
  key: number;
  count: number;
  empty: number;
  distinct: number;
  distinctCapped: boolean;
  numeric?: { min: number; max: number; sum: number; mean: number; count: number };
  minStr?: string;
  maxStr?: string;
  top: [string, number][];
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  kind: TableKind;
}

export interface Settings {
  density: Density;
  wrap: boolean;
  follow: boolean;
}

export interface Meta {
  /** Rows in the document (excluding the header row). */
  total: number;
  /** Rows in the current (filtered/sorted) view. */
  count: number;
  /** View version; row replies with another version are stale. */
  vv: number;
  columns: ColMeta[];
  indexing: boolean;
  /** 0..1 while indexing. */
  progress?: number;
  hasHeader: boolean;
  delimiter?: string;
  encoding: string;
  eol: string;
  readOnly: boolean;
  readOnlyReason?: string;
  dirty: boolean;
  warnings: string[];
  invalid?: number;
  levelCounts?: number[];
  /** Logs: level detection still running (streamed files). */
  levelsPending?: boolean;
  query: Query;
  /** Can the header row be toggled (delimited files only). */
  headerToggle: boolean;
  /** Parquet: extra facts for the schema panel. */
  parquet?: { rowGroups: number; createdBy?: string; compression?: string; version?: number };
}

export type EditOp =
  | { op: 'set'; row: number; key: number; value: string }
  | { op: 'paste'; row: number; keys: number[]; rows: string[][] }
  | { op: 'clear'; rows: number[]; keys: number[] }
  | { op: 'insertRows'; at: number; count: number }
  | { op: 'deleteRows'; rows: number[] }
  | { op: 'insertCol'; at: number; name: string }
  | { op: 'renameCol'; key: number; name: string }
  | { op: 'deleteCol'; key: number };

export type CopyFormat = 'tsv' | 'csv' | 'markdown' | 'json';

/** Webview → host */
export type ToHost =
  | { type: 'ready'; query?: Query; hasHeader?: boolean }
  | { type: 'rows'; vv: number; blocks: number[]; bs: number }
  | { type: 'query'; query: Query }
  | { type: 'search'; id: number; q: string; regex: boolean; matchCase: boolean; word: boolean; keys: number[]; from: number }
  | { type: 'stats'; key: number; top: number }
  | { type: 'record'; row: number; vv: number }
  | { type: 'edit'; edit: EditOp }
  | { type: 'copy'; text: string }
  | { type: 'copyRange'; r0: number; r1: number; keys: number[]; format: CopyFormat; header: boolean }
  | { type: 'pasteReq' }
  | { type: 'header'; value: boolean }
  | { type: 'viewCols'; keys: number[] }
  | { type: 'command'; id: 'openAsText' | 'export' | 'reload' | 'goToRow' | 'settings' }
  | { type: 'follow'; on: boolean }
  | { type: 'findLevel'; from: number; dir: 1 | -1; mask: number; vv: number }
  | { type: 'findInvalid'; from: number; dir: 1 | -1; vv: number }
  | { type: 'setting'; key: 'wrap' | 'density'; value: unknown };

/** Host → webview */
export type ToView =
  | { type: 'init'; strings: Record<string, string>; file: FileInfo; settings: Settings; meta: Meta }
  | { type: 'meta'; meta: Meta; reset?: boolean }
  | { type: 'rows'; vv: number; b: number; bs: number; rows: RowData[] }
  | { type: 'dropped'; vv: number; blocks: number[] }
  | { type: 'progress'; task: string; pct: number }
  /** Streamed: `hits` holds the new [viewRow, logicalColumn] pairs since the previous message for this id, in scan
   * order (from the requested start row to the end, then wrapping around). */
  | { type: 'searchResult'; id: number; total: number; hits: number[]; capped: boolean; done: boolean; error?: string; levels?: number[]; ms?: number }
  | { type: 'stats'; stats: Stats }
  | { type: 'record'; row: number; vv: number; data: RowData | null }
  | { type: 'focusSearch' }
  | { type: 'goTo'; row: number }
  | { type: 'paste'; text: string }
  | { type: 'found'; row: number }
  | { type: 'banner'; kind: 'changed' | 'none' }
  | { type: 'error'; message: string };

export const ADDED_BASE = 0x40000000;
/** Log levels; index = code. */
export const LEVELS = ['', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export const LV_NONE = 0;
export const LV_TRACE = 1;
export const LV_DEBUG = 2;
export const LV_INFO = 3;
export const LV_WARN = 4;
export const LV_ERROR = 5;
export const LV_FATAL = 6;
/** Max characters of a cell sent for grid display. */
export const CELL_MAX = 600;
