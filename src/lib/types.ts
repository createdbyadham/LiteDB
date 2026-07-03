// Shared database types used by both SQLite and PostgreSQL services.

export interface TableInfo {
    name: string;
    sql: string;
}

export interface ColumnInfo {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    pk: number;
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

// Guard for table/column names interpolated into SQL. SQL.js and our pg path
// don't support parameterized identifiers, so the only safe option is to
// allowlist the characters before quoting.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertIdent(name: string, kind: 'table' | 'column' = 'identifier'): string {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid ${kind} name: ${name}`);
    }
    return name;
}
