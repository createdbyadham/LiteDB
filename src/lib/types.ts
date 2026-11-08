// Shared database types used by both SQLite and PostgreSQL services.

export interface TableInfo {
    /**
     * Unique key for the table in this connection, and what the UI shows.
     * In Postgres, tables outside the default schema are `schema.table`.
     */
    name: string;
    sql: string;
    /** Views are listed but read-only. Absent means table. */
    type?: 'table' | 'view';
    /** Postgres schema. Absent for SQLite. */
    schema?: string;
    /** The bare table name, without its schema. */
    table?: string;
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
    /** Position in the primary key, 1-based. 0 when not part of it. */
    pk: number;
    /** The column's default expression, as the database spells it. */
    defaultValue?: string | null;
    /**
     * Filled in by the database when left out of an INSERT: identity, serial,
     * SQLite's INTEGER PRIMARY KEY, or a generated column.
     */
    generated?: boolean;
}

/** Every primary-key column, in key order. SQLite numbers them 1..n; pg marks each 1. */
export function primaryKeyColumns(columns: ColumnInfo[]): ColumnInfo[] {
    return columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk || a.cid - b.cid);
}

export type FilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'is null' | 'is not null';

export const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
    { value: '=', label: 'equals', needsValue: true },
    { value: '!=', label: 'does not equal', needsValue: true },
    { value: 'contains', label: 'contains', needsValue: true },
    { value: '>', label: 'greater than', needsValue: true },
    { value: '>=', label: 'at least', needsValue: true },
    { value: '<', label: 'less than', needsValue: true },
    { value: '<=', label: 'at most', needsValue: true },
    { value: 'is null', label: 'is NULL', needsValue: false },
    { value: 'is not null', label: 'is not NULL', needsValue: false },
];

/** One condition on one column, ANDed with the others. */
export interface ColumnFilter {
    column: string;
    op: FilterOp;
    /** Typed text, or the exact value when following a foreign key. */
    value?: unknown;
}

/** One page of a table, as the grid asks for it. */
export interface TableQuery {
    limit: number;
    offset: number;
    /** Case-insensitive substring match against every column. */
    search?: string;
    sortColumn?: string | null;
    sortDirection?: 'asc' | 'desc';
    filters?: ColumnFilter[];
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
    /** `total` is the planner's estimate: the table is too large to count on every page. */
    totalEstimated?: boolean;
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

/** A foreign key in another table that points at this one. */
export interface ReferencingKey {
    /** The referencing table's key. */
    table: string;
    /** Its columns, in key order. */
    columns: string[];
    /** The columns of this table they point at, in the same order. */
    refColumns: string[];
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

/**
 * A name as an editor completion inserts it: bare when the database reads it
 * back unchanged, quoted otherwise. Postgres folds unquoted names to lower
 * case, so `createdAt` goes in as `"createdAt"`; SQLite does not, so
 * `Suppliers` goes in as written. Spaces and other characters always quote.
 */
export function completionName(name: string, dialect: 'sqlite' | 'postgres'): string {
    const plain = dialect === 'sqlite' ? /^[a-z_][a-z0-9_]*$/i : /^[a-z_][a-z0-9_]*$/;
    return plain.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** A SQL string literal: `it's` → `'it''s'`. */
export function quoteLiteral(value: string): string {
    if (value.includes('\0')) throw new Error('Invalid string literal');
    return `'${value.replace(/'/g, "''")}'`;
}
