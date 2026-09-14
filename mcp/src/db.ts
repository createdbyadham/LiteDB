// The connection, and the part of read-only that the classifier cannot get
// wrong.
//
// Layer one of the safety model is `sqlClassifier` deciding what a statement
// is. That is parsing, and parsing can be beaten — a dialect quirk, a syntax
// nobody anticipated. So layer two does not read the SQL at all: reads run on
// a connection that is *physically* incapable of writing. SQLite gets a
// connection opened read-only; Postgres runs every read inside a READ ONLY
// transaction that is always rolled back. A statement that slips past the
// classifier still meets an engine that refuses it.
//
// Same construction the eval harness uses (`evals/src/fixture.ts`), for the
// same reason: model-authored SQL is about to run and being clever is not a
// safety property.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDialect } from '../../src/lib/schemaTypes';
import type { ServerConfig } from './config';

/**
 * busy=1 from TRUNCATE is a row, not an exception: SQLite only reports that
 * another connection kept the checkpoint from finishing.
 */
function checkpointBusy(connection: DatabaseSync): boolean {
    // TRUNCATE waits on readers through the busy handler. A short wait covers
    // a reader finishing; a long one would stall the agent's call behind a
    // program that simply has the file open. The retry timer covers the rest.
    connection.exec(`PRAGMA busy_timeout = ${CHECKPOINT_WAIT_MS}`);
    try {
        const row = connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
            | { busy?: number | bigint }
            | undefined;
        return Number(row?.busy ?? 0) !== 0;
    } finally {
        connection.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
}

/**
 * How long a statement waits on a lock before failing. The desktop app saves
 * by taking SQLite's own write lock for a few milliseconds; with no timeout an
 * agent's read or write that lands in those milliseconds fails outright with
 * "database is locked" instead of waiting its turn.
 */
const BUSY_TIMEOUT_MS = 5_000;
const CHECKPOINT_WAIT_MS = 250;

function openSqlite(path: string, readOnly: boolean): DatabaseSync {
    return new DatabaseSync(path, { readOnly, timeout: BUSY_TIMEOUT_MS });
}

export interface QueryResult {
    columns: string[];
    rows: unknown[][];
    /** Rows the engine reported changed. Always 0 for a statement that reads. */
    rowsAffected: number;
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
function quoteIdent(identifier: string): string {
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
const TABLE_CACHE_MS = 5_000;

/**
 * Case-insensitive fallback, because a model that read `Orders` in a schema
 * dump and typed `orders` has not made a mistake worth an error.
 */
function resolveAgainst(name: string, known: string[]): string {
    const exact = known.find((t) => t === name);
    if (exact) return exact;
    const insensitive = known.find((t) => t.toLowerCase() === name.toLowerCase());
    if (insensitive) return insensitive;
    throw new UnknownTableError(name, known);
}

// ---------------------------------------------------------------- SQLite ---

/**
 * SQLite connections live for one tool call, not for the session.
 *
 * The desktop app saves by writing a whole file image. A connection that
 * stays open across that does not reliably notice: in WAL mode SQLite trusts
 * its page cache while the WAL index is unchanged, and the app does not touch
 * the WAL. Measured, not guessed — a reader kept serving the old rows, and the
 * next approved write built WAL frames on those stale pages, which either
 * reverted the app's edit or left "database disk image is malformed". Closing
 * between calls means every call starts from the file as it is now, and holds
 * no handle the app has to wait for.
 */
class SqliteDatabase implements Database {
    readonly dialect: SqlDialect = 'sqlite';
    private reader: DatabaseSync | null = null;
    private writer: DatabaseSync | null = null;
    private tables: { names: string[]; at: number } | null = null;
    // ponytail: 1s retry while checkpoint is busy, cleared on close
    private flushRetry: ReturnType<typeof setTimeout> | null = null;
    private closed = false;

    constructor(
        private readonly path: string,
        private readonly writable: boolean,
        private readonly source: 'env' | 'handoff' = 'env',
    ) {
        const probe = openSqlite(path, true);
        try {
            // `columns()` arrived in node:sqlite some releases after the module
            // itself did, and everything below depends on it to tell a query from
            // a statement that only reports `changes`. Degrading gracefully was
            // the first instinct and the wrong one: without it every SELECT falls
            // through to the write branch and comes back as "0 rows changed" —
            // an answer that looks like data rather than like a failure. A server
            // that cannot read correctly should say so at startup.
            if (typeof probe.prepare('SELECT 1').columns !== 'function') {
                throw new Error(
                    `This Node (${process.version}) provides node:sqlite without ` +
                        'StatementSync.columns(), so LiteDB cannot distinguish a query from a ' +
                        'write and would report every read as 0 rows changed. Upgrade Node — ' +
                        '24 LTS or newer is safest.',
                );
            }
        } finally {
            probe.close();
        }
    }

    private readConnection(): DatabaseSync {
        if (!this.reader) this.reader = openSqlite(this.path, true);
        return this.reader;
    }

    private run(db: DatabaseSync, sql: string): QueryResult {
        const statement = db.prepare(sql);
        const meta = statement.columns();

        if (meta.length === 0) {
            // Nothing to return means it is not a query, so `changes` is this
            // statement's own count. Asking a SELECT for `changes` hands back
            // whatever the *previous* write did, which is how a read ends up
            // claiming it modified rows.
            const result = statement.run();
            return { columns: [], rows: [], rowsAffected: Number(result.changes) };
        }

        // Positional rows: `SELECT a.id, b.id` collapses to one key as an
        // object, understating the column count.
        statement.setReturnArrays(true);
        const rows = statement.all() as unknown as unknown[][];
        return {
            columns: meta.map((c, i) => c.name ?? c.column ?? `column${i + 1}`),
            rows,
            rowsAffected: 0,
        };
    }

    async read(sql: string): Promise<QueryResult> {
        return this.run(this.readConnection(), sql);
    }

    async write(sql: string): Promise<QueryResult> {
        if (!this.writable) throw new ReadOnlyServerError(this.source);
        if (!this.writer) this.writer = openSqlite(this.path, false);
        // A write may have been a CREATE or DROP.
        this.tables = null;
        return this.run(this.writer, sql);
    }

    /**
     * Fold the WAL back into the main file after an approved write.
     *
     * In WAL mode a write lands in `<file>-wal` and the main file's modified
     * time does not move until a checkpoint. The desktop app notices "someone
     * else wrote this file" by exactly that modified time, so without this it
     * cannot see an agent's write and saves its in-memory copy straight over
     * it. TRUNCATE also empties the -wal, so nothing stale is left beside a
     * file the app later rewrites. On a rollback-journal database it is a
     * no-op.
     *
     * The read connection is closed for the checkpoint so *we* are not the
     * reason TRUNCATE returns busy. busy=1 after that means another program
     * still has the file, and the app cannot see these writes until it closes.
     */
    async flushWrites(): Promise<void> {
        if (!this.writer) return;
        this.stopRetry();
        this.reader?.close();
        this.reader = null;
        this.tables = null;
        if (checkpointBusy(this.writer)) {
            this.scheduleRetry();
            throw new Error(
                'Could not fold these writes into the database file because another program has it open. LiteDB will not see them until that program closes.',
            );
        }
    }

    /** Retries on a connection of its own, so nothing stays open between calls. */
    private scheduleRetry(): void {
        this.flushRetry = setTimeout(() => {
            this.flushRetry = null;
            if (this.closed || !existsSync(this.path)) return;
            let busy = true;
            try {
                const connection = openSqlite(this.path, false);
                try {
                    busy = checkpointBusy(connection);
                } finally {
                    connection.close();
                }
            } catch {
                // Locked or mid-write elsewhere; same as busy.
            }
            if (busy) this.scheduleRetry();
        }, 1000);
        this.flushRetry.unref?.();
    }

    private stopRetry(): void {
        if (this.flushRetry) {
            clearTimeout(this.flushRetry);
            this.flushRetry = null;
        }
    }

    /**
     * Reader first, writer last: the last connection to close a WAL database
     * checkpoints and removes -wal/-shm, and a read-only connection cannot.
     */
    async release(): Promise<void> {
        this.reader?.close();
        this.reader = null;
        this.writer?.close();
        this.writer = null;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.stopRetry();
        await this.release();
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

// ------------------------------------------------------------ PostgreSQL ---

/* eslint-disable @typescript-eslint/no-explicit-any */

class PostgresDatabase implements Database {
    readonly dialect: SqlDialect = 'postgres';
    private tables: { names: string[]; at: number } | null = null;

    constructor(
        private readonly client: any,
        private readonly writable: boolean,
        private readonly source: 'env' | 'handoff' = 'env',
    ) {}

    async read(sql: string): Promise<QueryResult> {
        await this.client.query('BEGIN READ ONLY');
        try {
            const res = await this.client.query({ text: sql, rowMode: 'array' });
            return {
                columns: ((res.fields ?? []) as any[]).map((f) => String(f.name)),
                rows: (res.rows ?? []) as unknown[][],
                rowsAffected: 0,
            };
        } finally {
            // Always. A READ ONLY transaction has nothing to commit, and
            // leaving one open would idle the connection in transaction.
            await this.client.query('ROLLBACK');
        }
    }

    async write(sql: string): Promise<QueryResult> {
        if (!this.writable) throw new ReadOnlyServerError(this.source);
        // A write may have been a CREATE or DROP.
        this.tables = null;
        const res = await this.client.query({ text: sql, rowMode: 'array' });
        const fields = (res.fields ?? []) as any[];
        return {
            columns: fields.map((f) => String(f.name)),
            rows: (res.rows ?? []) as unknown[][],
            // Postgres puts rows *returned* in the same field for a SELECT, so
            // a statement that produced a result set reports no change.
            rowsAffected: fields.length > 0 ? 0 : Number(res.rowCount ?? 0),
        };
    }

    async tableNames(): Promise<string[]> {
        const now = Date.now();
        if (this.tables && now - this.tables.at < TABLE_CACHE_MS) return this.tables.names;
        const { rows } = await this.read(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             ORDER BY table_name`,
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
        const { rows } = await this.read(
            `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                    COALESCE(pk.is_pk, false) AS is_pk
             FROM information_schema.columns c
             LEFT JOIN (
                 SELECT kcu.column_name, true AS is_pk
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name
                  AND kcu.table_schema = tc.table_schema
                 WHERE tc.table_schema = 'public'
                   AND tc.table_name = ${literal(resolved)}
                   AND tc.constraint_type = 'PRIMARY KEY'
             ) pk ON pk.column_name = c.column_name
             WHERE c.table_schema = 'public' AND c.table_name = ${literal(resolved)}
             ORDER BY c.ordinal_position`,
        );
        return rows.map((r) => ({
            name: String(r[0]),
            type: String(r[1] ?? ''),
            isNotNull: r[2] === 'NO',
            defaultValue: r[3] === null || r[3] === undefined ? null : String(r[3]),
            isPrimaryKey: r[4] === true || r[4] === 't',
        }));
    }

    async foreignKeys(table: string): Promise<ForeignKeyInfo[]> {
        const resolved = await this.resolveTable(table);
        const { rows } = await this.read(
            `SELECT kcu.column_name, ccu.table_name, ccu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema = tc.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema = 'public'
               AND tc.table_name = ${literal(resolved)}
             ORDER BY kcu.ordinal_position`,
        );
        return rows.map((r) => ({
            column: String(r[0]),
            referencesTable: String(r[1]),
            referencesColumn: String(r[2]),
        }));
    }

    async indexes(table: string): Promise<IndexInfo[]> {
        const resolved = await this.resolveTable(table);
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
             JOIN pg_class t ON t.oid = ix.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public' AND t.relname = ${literal(resolved)}
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

    async flushWrites(): Promise<void> {
        // A server, not a file: nothing is watching its modified time.
    }

    async release(): Promise<void> {
        // The server arbitrates concurrent writers; nothing to hand back.
    }

    async close(): Promise<void> {
        await this.client.end();
    }
}

/**
 * A refused connection to `localhost` tries ::1 and 127.0.0.1 and rejects with
 * an AggregateError whose own message is empty — which reached the agent as a
 * blank error. Name the server (never the password) and the real causes.
 */
export function postgresConnectFailure(target: string, error: unknown): string {
    const causes =
        error instanceof AggregateError && error.errors.length > 0 ? error.errors : [error];
    const detail = [
        ...new Set(
            causes.map((cause) =>
                cause instanceof Error
                    ? cause.message || (cause as { code?: string }).code || cause.name
                    : String(cause),
            ),
        ),
    ].join('; ');
    let where = 'the Postgres server';
    try {
        const url = new URL(target);
        where = `Postgres at ${url.hostname}:${url.port || '5432'}`;
    } catch {
        // Not a URL; keep the generic name rather than echo the target.
    }
    return (
        `Could not connect to ${where}: ${detail || 'connection failed'}. ` +
        'Is the server running? If LiteDB is no longer connected to it, reconnect in the app.'
    );
}

export async function openDatabase(config: ServerConfig): Promise<Database> {
    const writable = config.policy !== 'read-only';

    if (config.dialect === 'sqlite') {
        return new SqliteDatabase(config.target, writable, config.source);
    }

    let pg: any;
    try {
        pg = await import('pg');
    } catch {
        throw new Error("Connecting to Postgres needs the 'pg' package. Run: npm install pg");
    }

    // Same coercions the eval harness uses, so a value means the same thing
    // whichever path it came back through: DATE stays a plain string (parsing
    // it to a JS Date shifts the day under a non-UTC TZ), NUMERIC and INT8
    // become numbers rather than strings.
    const types = pg.types ?? pg.default?.types;
    types.setTypeParser(1082, (v: string) => v);
    types.setTypeParser(1700, (v: string) => parseFloat(v));
    types.setTypeParser(20, (v: string) => parseInt(v, 10));

    const Client = pg.Client ?? pg.default?.Client;
    const client = new Client({ connectionString: config.target });
    try {
        await client.connect();
    } catch (error) {
        throw new Error(postgresConnectFailure(config.target, error));
    }
    return new PostgresDatabase(client, writable, config.source);
}

/* eslint-enable @typescript-eslint/no-explicit-any */
