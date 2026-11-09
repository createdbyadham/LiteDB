// The connection, and the part of read-only that the classifier cannot get
// wrong.
//
// Layer one of the safety model is `sqlClassifier` deciding what a statement
// is. That is parsing, and parsing can be beaten, a dialect quirk, a syntax
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
import type { ServerConfig } from './config';
import { PostgresCatalog, ReadOnlyServerError, SqliteCatalog, type Database, type QueryResult } from './catalog';

export * from './catalog';

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

// ---------------------------------------------------------------- SQLite ---

/**
 * SQLite connections live for one tool call, not for the session.
 *
 * The desktop app now opens the file natively and shares it through SQLite's
 * own locking. Before 2.5 it saved by writing a whole file image, which a
 * long-lived connection here did not notice, so this server opened per call
 * to be safe with those versions. That is still the right shape: every call
 * starts from the file as it is now, and holds no handle anything else has
 * to wait for.
 */
class SqliteDatabase extends SqliteCatalog {
    private reader: DatabaseSync | null = null;
    private writer: DatabaseSync | null = null;
    // ponytail: 1s retry while checkpoint is busy, cleared on close
    private flushRetry: ReturnType<typeof setTimeout> | null = null;
    private closed = false;

    constructor(
        private readonly path: string,
        private readonly writable: boolean,
        private readonly source: 'env' | 'handoff' = 'env',
    ) {
        super();
        const probe = openSqlite(path, true);
        try {
            // `columns()` arrived in node:sqlite some releases after the module
            // itself did, and everything below depends on it to tell a query from
            // a statement that only reports `changes`. Degrading gracefully was
            // the first instinct and the wrong one: without it every SELECT falls
            // through to the write branch and comes back as "0 rows changed",
            // an answer that looks like data rather than like a failure. A server
            // that cannot read correctly should say so at startup.
            if (typeof probe.prepare('SELECT 1').columns !== 'function') {
                throw new Error(
                    `This Node (${process.version}) provides node:sqlite without ` +
                        'StatementSync.columns(), so LiteDB cannot distinguish a query from a ' +
                        'write and would report every read as 0 rows changed. Upgrade Node, ' +
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
}

// ------------------------------------------------------------ PostgreSQL ---

/* eslint-disable @typescript-eslint/no-explicit-any */

class PostgresDatabase extends PostgresCatalog {

    constructor(
        private readonly client: any,
        private readonly writable: boolean,
        private readonly source: 'env' | 'handoff' = 'env',
    ) {
        super();
    }

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
 * an AggregateError whose own message is empty, which reached the agent as a
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
