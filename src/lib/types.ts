// Shared database types used by both SQLite and PostgreSQL services.

export interface TableInfo {
    name: string;
    sql: string;
    /** Views are listed but read-only. Absent means table. */
    type?: 'table' | 'view';
}

/**
 * Hidden column carrying a row's physical address (SQLite rowid, Postgres
 * ctid) for tables with no primary key, so their rows can still be edited
 * and deleted one at a time. Never shown, never exported.
 */
export const ROW_LOCATOR = '__litedb_row__';

export interface ColumnInfo {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    pk: number;
}

/** Every primary-key column, in key order. SQLite numbers them 1..n; pg marks each 1. */
export function primaryKeyColumns(columns: ColumnInfo[]): ColumnInfo[] {
    return columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk || a.cid - b.cid);
}

/** One page of a table, as the grid asks for it. */
export interface TableQuery {
    limit: number;
    offset: number;
    /** Case-insensitive substring match against every column. */
    search?: string;
    sortColumn?: string | null;
    sortDirection?: 'asc' | 'desc';
}

export interface TablePage {
    columns: string[];
    rows: RowData[];
    /** Rows matching the search, across all pages. */
    total: number;
    /** Set when rows are addressed by ROW_LOCATOR instead of a primary key. */
    rowLocator?: string;
    /** Views: shown, never written. */
    readOnly?: boolean;
}

/** `100%_off` → `100\%\_off`, for LIKE … ESCAPE '\'. */
export function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, ch => `\\${ch}`);
}

export interface ForeignKeyInfo {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
}

export interface IndexInfo {
    name: string;
    unique: boolean;
    columns: string[];
}

export interface RowData {
    [key: string]: unknown;
}

// Table/column names interpolated into SQL. SQL.js and our pg path don't
// support parameterized identifiers, so names are always written through
// quoteIdent: wrapped in double quotes with embedded quotes doubled, which is
// the standard escape in both SQLite and Postgres. That keeps real names like
// "Order Details", "line-items" or "Orders" (mixed case in pg) working, where
// an allowlist of [A-Za-z0-9_] rejected them.
type IdentKind = 'table' | 'column' | 'identifier';

export function assertIdent(name: string, kind: IdentKind = 'identifier'): string {
    if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')) {
        throw new Error(`Invalid ${kind} name: ${String(name)}`);
    }
    return name;
}

/** `Order Details` → `"Order Details"`, `a"b` → `"a""b"`. */
export function quoteIdent(name: string, kind: IdentKind = 'identifier'): string {
    assertIdent(name, kind);
    return `"${name.replace(/"/g, '""')}"`;
}

/** A SQL string literal: `it's` → `'it''s'`. */
export function quoteLiteral(value: string): string {
    if (value.includes('\0')) throw new Error('Invalid string literal');
    return `'${value.replace(/'/g, "''")}'`;
}
