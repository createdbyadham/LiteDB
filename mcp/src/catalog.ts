// What litedb-mcp knows about a database, apart from how it talks to it.
//
// The catalog queries (tables, columns, keys, indexes) are plain SQL over
// `read()`. They live here, free of Node imports, so two hosts share them: the
// npm server, which runs them through node:sqlite and pg (db.ts), and the
// desktop app, which serves the same tools over its own connection.

import type { SqlDialect } from '../../src/lib/schemaTypes';

export interface QueryResult {
    columns: string[];
    rows: unknown[][];
    /** Rows the engine reported changed. Always 0 for a statement that reads. */
    rowsAffected: number;
    /** More rows existed than came back. Only the app caps them. */
    truncated?: boolean;
}

export interface ColumnInfo {
    name: string;
    type: string;
    isPrimaryKey: boolean;
    isNotNull: boolean;
    defaultValue: string | null;
}

export interface ForeignKeyInfo {
    column: string;
    referencesTable: string;
    referencesColumn: string;
}

export interface IndexInfo {
    name: string;
    unique: boolean;
    columns: string[];
}

export class UnknownTableError extends Error {
    constructor(name: string, known: string[]) {
        const shown = known.slice(0, 20).join(', ');
        super(
            `No table named "${name}". Tables in this database: ${shown}` +
                (known.length > 20 ? `, ... (${known.length} total)` : ''),
        );
        this.name = 'UnknownTableError';
    }
}

export interface WriteAllOptions {
    maxChanges?: number;
}

/** A run rolled back for changing more rows than it was allowed to. */
export class TooManyChangesError extends Error {
    constructor(
        readonly limit: number,
        message = `Rolled back, nothing changed: this would change more than the ${limit} rows allowed.`,
    ) {
        super(message);
        this.name = 'TooManyChangesError';
    }
}

/** The statements whose changes count against a run's row limit. */
const CHANGES_ROWS = /^\s*(INSERT|UPDATE|DELETE)\b/i;

export class ReadOnlyServerError extends Error {
    constructor(source: 'env' | 'handoff' = 'env') {
        super(
            source === 'handoff'
                ? 'This connection is read-only in LiteDB, so nothing that changes the ' +
                      'database can run. Switch the policy dropdown in the status bar to ' +
                      'guarded to allow writes behind an approval step.'
                : 'This server is running read-only (LITEDB_POLICY=read-only), so nothing ' +
                      'that changes the database can run. Restart it with LITEDB_POLICY=guarded ' +
                      'to allow writes behind an approval step.',
        );
        this.name = 'ReadOnlyServerError';
    }
}

export interface Database {
    readonly dialect: SqlDialect;
    /** Run a statement on a connection the engine will not let write. */
    read(sql: string): Promise<QueryResult>;
    /** Run a statement that may change data. Refused when the server is read-only. */
    write(sql: string): Promise<QueryResult>;
    /**
     * Run statements as one transaction: all of them, or none, with the
     * failing statement's own error raised. With `maxChanges`, a run whose
     * INSERT, UPDATE and DELETE statements change more rows than that is
     * rolled back too, with a TooManyChangesError.
     */
    writeAll(sqls: string[], options?: WriteAllOptions): Promise<QueryResult[]>;
    /** Every base table, ordered by name. */
    tableNames(): Promise<string[]>;
    /**
     * Resolve a caller-supplied name against the real tables.
     *
     * The only way a model-supplied identifier is allowed into a query this
     * file builds. Matching against the live table list rather than testing it
     * against a pattern makes identifier injection structurally impossible
     * instead of pattern-dependent: the string that reaches the SQL is one the
     * database told us about, not one the caller wrote.
     */
    resolveTable(name: string): Promise<string>;
    columns(table: string): Promise<ColumnInfo[]>;
    foreignKeys(table: string): Promise<ForeignKeyInfo[]>;
    indexes(table: string): Promise<IndexInfo[]>;
    /** Whether the pgvector extension is installed. Always false on SQLite. */
    hasPgVector(): Promise<boolean>;
    /** Quote an identifier for this dialect. */
    quote(identifier: string): string;
    /**
     * Make committed writes visible to other processes watching the file.
     * Only does anything for SQLite in WAL mode — see SqliteDatabase.
     */
    flushWrites(): Promise<void>;
    /**
     * No tool call is using the connection. SQLite closes its file handles —
     * see SqliteDatabase — and reopens on the next call. Postgres keeps its
     * client.
     */
    release(): Promise<void>;
    close(): Promise<void>;
}

/** Both dialects quote with double quotes and escape by doubling. */
export function quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

/** A single-quoted SQL string literal. Only ever wraps names we resolved. */
export function literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * How long a table list may be reused.
 *
 * `describe_table` resolves the table, then asks for columns, foreign keys and
 * indexes — each of which resolves it again — and `list_tables` does that once
 * per table, so an uncached catalogue read turns a schema dump into O(n^2)
 * queries against information_schema. A few seconds of staleness is the right
 * trade: names still come from the database rather than from the caller, which
 * is the property that matters, and a write through this server clears the
 * cache outright.
 */
export const TABLE_CACHE_MS = 5_000;

/**
 * Case-insensitive fallback, because a model that read `Orders` in a schema
 * dump and typed `orders` has not made a mistake worth an error.
 */
export function resolveAgainst(name: string, known: string[]): string {
    const exact = known.find((t) => t === name);
    if (exact) return exact;
    const insensitive = known.find((t) => t.toLowerCase() === name.toLowerCase());
    if (insensitive) return insensitive;
    throw new UnknownTableError(name, known);
}

/**
 * BEGIN, each statement, COMMIT, through `write`. On a failure, ROLLBACK and
 * raise the statement's error.
 */
export async function inTransaction(
    write: (sql: string) => Promise<QueryResult>,
    sqls: string[],
    options: WriteAllOptions = {},
): Promise<QueryResult[]> {
    await write('BEGIN');
    try {
        const results: QueryResult[] = [];
        for (const sql of sqls) results.push(await write(sql));
        if (options.maxChanges !== undefined) {
            // A statement with RETURNING reports its changes as the rows it
            // returns, and no rowsAffected.
            const changed = results.reduce(
                (sum, result, i) =>
                    CHANGES_ROWS.test(sqls[i]) ? sum + (result.rowsAffected || result.rows.length) : sum,
                0,
            );
            if (changed > options.maxChanges) {
                throw new TooManyChangesError(
                    options.maxChanges,
                    `Rolled back, nothing changed: this would change ${changed} rows, more than the ${options.maxChanges} allowed.`,
                );
            }
        }
        await write('COMMIT');
        return results;
    } catch (error) {
        try {
            await write('ROLLBACK');
        } catch {
            // Postgres has already aborted the transaction, or BEGIN itself
            // failed. Either way the original error is the one worth raising.
        }
        throw error;
    }
}

/** SQLite's catalog, over whatever runs the SQL. */
export abstract class SqliteCatalog implements Database {
    readonly dialect: SqlDialect = 'sqlite';
    protected tables: { names: string[]; at: number } | null = null;

    abstract read(sql: string): Promise<QueryResult>;
    abstract write(sql: string): Promise<QueryResult>;
    abstract flushWrites(): Promise<void>;
    abstract release(): Promise<void>;
    abstract close(): Promise<void>;

    writeAll(sqls: string[], options?: WriteAllOptions): Promise<QueryResult[]> {
        return inTransaction((sql) => this.write(sql), sqls, options);
    }

    async tableNames(): Promise<string[]> {
        const now = Date.now();
        if (this.tables && now - this.tables.at < TABLE_CACHE_MS) return this.tables.names;
        const { rows } = await this.read(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
        );
        const names = rows.map((r) => String(r[0]));
        this.tables = { names, at: now };
        return names;
    }

    async resolveTable(name: string): Promise<string> {
        return resolveAgainst(name, await this.tableNames());
    }

    async columns(table: string): Promise<ColumnInfo[]> {
        const resolved = await this.resolveTable(table);
        const { rows } = await this.read(`PRAGMA table_info(${quoteIdent(resolved)})`);
        // cid, name, type, notnull, dflt_value, pk
        return rows.map((r) => ({
            name: String(r[1]),
            type: String(r[2] ?? ''),
            isNotNull: Number(r[3]) === 1,
            defaultValue: r[4] === null || r[4] === undefined ? null : String(r[4]),
            isPrimaryKey: Number(r[5]) > 0,
        }));
    }

    async foreignKeys(table: string): Promise<ForeignKeyInfo[]> {
        const resolved = await this.resolveTable(table);
        const { rows } = await this.read(`PRAGMA foreign_key_list(${quoteIdent(resolved)})`);
        // id, seq, table, from, to, on_update, on_delete, match
        return rows.map((r) => ({
            column: String(r[3]),
            referencesTable: String(r[2]),
            referencesColumn: r[4] === null ? '' : String(r[4]),
        }));
    }

    async indexes(table: string): Promise<IndexInfo[]> {
        const resolved = await this.resolveTable(table);
        const { rows } = await this.read(`PRAGMA index_list(${quoteIdent(resolved)})`);
        // seq, name, unique, origin, partial
        const infos: IndexInfo[] = [];
        for (const row of rows) {
            const name = String(row[1]);
            const { rows: cols } = await this.read(`PRAGMA index_info(${quoteIdent(name)})`);
            infos.push({
                name,
                unique: Number(row[2]) === 1,
                // seqno, cid, name — name is null for an expression index.
                columns: cols.map((c) => (c[2] === null ? '(expression)' : String(c[2]))),
            });
        }
        return infos;
    }

    async hasPgVector(): Promise<boolean> {
        return false;
    }

    quote(identifier: string): string {
        return quoteIdent(identifier);
    }
}

/** Postgres's catalog, over whatever runs the SQL. */
export abstract class PostgresCatalog implements Database {
    readonly dialect: SqlDialect = 'postgres';
    protected tables: { names: string[]; at: number } | null = null;
    /** Where each listed name lives. Same naming as the app's sidebar. */
    protected locations = new Map<string, { schema: string; table: string }>();

    abstract read(sql: string): Promise<QueryResult>;
    abstract write(sql: string): Promise<QueryResult>;
    abstract flushWrites(): Promise<void>;
    abstract release(): Promise<void>;
    abstract close(): Promise<void>;

    writeAll(sqls: string[], options?: WriteAllOptions): Promise<QueryResult[]> {
        return inTransaction((sql) => this.write(sql), sqls, options);
    }

    /**
     * Tables in every schema the role can use, not just `public` — Supabase's
     * `auth` and `storage`, and any app's own schemas. A table in the default
     * schema keeps its bare name; elsewhere it is `schema.table`, which is
     * also how an agent writes it back in SQL.
     */
    async tableNames(): Promise<string[]> {
        const now = Date.now();
        if (this.tables && now - this.tables.at < TABLE_CACHE_MS) return this.tables.names;
        const { rows } = await this.read(
            `SELECT n.nspname, c.relname, n.nspname = current_schema() AS in_default
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
               AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
               AND has_schema_privilege(n.oid, 'USAGE')
             ORDER BY n.nspname = current_schema() DESC, n.nspname, c.relname`,
        );
        this.locations.clear();
        const names = rows.map((r) => {
            const schema = String(r[0]);
            const table = String(r[1]);
            const name = r[2] === true || r[2] === 't' ? table : `${schema}.${table}`;
            this.locations.set(name, { schema, table });
            return name;
        });
        this.tables = { names, at: now };
        return names;
    }

    async resolveTable(name: string): Promise<string> {
        return resolveAgainst(name, await this.tableNames());
    }

    /** `'"schema"."table"'::regclass`: the catalog's handle on a listed table. */
    private async regclass(table: string): Promise<string> {
        const resolved = await this.resolveTable(table);
        const loc = this.locations.get(resolved) ?? { schema: 'public', table: resolved };
        return `${literal(`${quoteIdent(loc.schema)}.${quoteIdent(loc.table)}`)}::regclass`;
    }

    /** The listed name for a schema and table, for foreign-key targets. */
    private nameFor(schema: string, table: string): string {
        for (const [name, loc] of this.locations) {
            if (loc.schema === schema && loc.table === table) return name;
        }
        return `${schema}.${table}`;
    }

    async columns(table: string): Promise<ColumnInfo[]> {
        const rel = await this.regclass(table);
        const { rows } = await this.read(
            `SELECT a.attname,
                    format_type(a.atttypid, a.atttypmod),
                    a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid),
                    EXISTS (
                        SELECT 1 FROM pg_index i
                        WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)
                    )
             FROM pg_attribute a
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
        );
        return rows.map((r) => ({
            name: String(r[0]),
            type: String(r[1] ?? ''),
            isNotNull: r[2] === true || r[2] === 't',
            defaultValue: r[3] === null || r[3] === undefined ? null : String(r[3]),
            isPrimaryKey: r[4] === true || r[4] === 't',
        }));
    }

    async foreignKeys(table: string): Promise<ForeignKeyInfo[]> {
        const rel = await this.regclass(table);
        // pg_catalog rather than information_schema, which pairs every column
        // of a composite key with every other and hides tables the role does
        // not own.
        const { rows } = await this.read(
            `SELECT a.attname, rn.nspname, rt.relname, ra.attname
             FROM pg_constraint c
             JOIN pg_class rt ON rt.oid = c.confrelid
             JOIN pg_namespace rn ON rn.oid = rt.relnamespace
             CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refattnum
             WHERE c.contype = 'f' AND c.conrelid = ${rel}
             ORDER BY c.conname, k.ord`,
        );
        await this.tableNames();
        return rows.map((r) => ({
            column: String(r[0]),
            referencesTable: this.nameFor(String(r[1]), String(r[2])),
            referencesColumn: String(r[3]),
        }));
    }

    async indexes(table: string): Promise<IndexInfo[]> {
        const rel = await this.regclass(table);
        const { rows } = await this.read(
            `SELECT i.relname,
                    ix.indisunique,
                    ARRAY(
                        SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                        FROM generate_subscripts(ix.indkey, 1) AS k
                        ORDER BY k
                    ) AS cols
             FROM pg_index ix
             JOIN pg_class i ON i.oid = ix.indexrelid
             WHERE ix.indrelid = ${rel}
             ORDER BY i.relname`,
        );
        return rows.map((r) => ({
            name: String(r[0]),
            unique: r[1] === true || r[1] === 't',
            columns: Array.isArray(r[2]) ? (r[2] as unknown[]).map(String) : [],
        }));
    }

    async hasPgVector(): Promise<boolean> {
        try {
            const { rows } = await this.read(
                `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
            );
            return rows.length > 0;
        } catch {
            return false;
        }
    }

    quote(identifier: string): string {
        return quoteIdent(identifier);
    }
}
