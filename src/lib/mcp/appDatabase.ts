// The database an agent's tools run against, inside the app.
//
// The same catalog the npm server uses (mcp/src/catalog.ts), over the app's
// own Rust connections instead of node:sqlite and pg, and with the same
// guarantees: a read runs where the engine refuses to write, and an agent
// never shares a transaction with the editor.
//
// SQLite gets connections of its own, opened read-only for reads and opened
// per tool call, as the npm server does. The editor's connection may be inside
// a BEGIN the user typed, and an agent's statements must not land in it.
// Postgres runs on the app's pool, never on the editor's session, with every
// read in a READ ONLY transaction that is rolled back (src-tauri/src/db).

import {
    PostgresCatalog,
    ReadOnlyServerError,
    SqliteCatalog,
    type QueryResult,
} from '../../../mcp/src/catalog';
import { dbClose, dbOpenSqlite, dbRun, type RunOptions, type RunResponse, type StatementResult } from '@/lib/db/native';

/** Rows one statement may bring back. Past it, the result says it was cut. */
const ROW_CAP = 10_000;

const READ: RunOptions = { readOnly: true, fullBlobs: true, maxRows: ROW_CAP };
const WRITE: RunOptions = { fullBlobs: true, maxRows: ROW_CAP };

function failed(response: RunResponse): void {
    const error = response.errors[0];
    if (error) throw new Error(error.message);
}

function shape(result: StatementResult | undefined): QueryResult {
    if (!result) return { columns: [], rows: [], rowsAffected: 0 };
    return {
        columns: result.columns,
        rows: result.rows,
        // As the npm server reports it: a statement that returns rows changed
        // none, whatever the engine counted.
        rowsAffected: result.returnsRows ? 0 : result.rowsAffected,
        ...(result.truncated ? { truncated: true } : {}),
    };
}

/** One result per statement sent: the last a string produced, when it held several. */
function perStatement(response: RunResponse, count: number): QueryResult[] {
    failed(response);
    return Array.from({ length: count }, (_, i) => {
        const produced = response.results.filter((r) => r.statement === i);
        return shape(produced[produced.length - 1]);
    });
}

let opened = 0;

export class AppSqliteDatabase extends SqliteCatalog {
    private reader: Promise<string> | null = null;
    private writer: Promise<string> | null = null;

    constructor(
        private readonly path: string,
        private readonly writable: boolean,
    ) {
        super();
    }

    private open(readOnly: boolean): Promise<string> {
        opened += 1;
        const id = `mcp-${readOnly ? 'read' : 'write'}-${opened}:${this.path}`;
        return dbOpenSqlite(id, this.path, false, readOnly).then(() => id);
    }

    private writing(): Promise<string> {
        if (!this.writable) throw new ReadOnlyServerError('handoff');
        // A write may have been a CREATE or DROP.
        this.tables = null;
        this.writer ??= this.open(false);
        return this.writer;
    }

    async read(sql: string): Promise<QueryResult> {
        this.reader ??= this.open(true);
        return perStatement(await dbRun(await this.reader, [sql], READ), 1)[0];
    }

    async write(sql: string): Promise<QueryResult> {
        return perStatement(await dbRun(await this.writing(), [sql], WRITE), 1)[0];
    }

    async writeAll(sqls: string[]): Promise<QueryResult[]> {
        const id = await this.writing();
        return perStatement(await dbRun(id, sqls, { ...WRITE, transaction: true }), sqls.length);
    }

    async flushWrites(): Promise<void> {
        // The app's own connection sees them through SQLite's locking, and the
        // grid reloads when the file's data_version moves.
    }

    /** No tool call is using the file: hand the connections back. */
    async release(): Promise<void> {
        const handles = [this.reader, this.writer];
        this.reader = null;
        this.writer = null;
        for (const handle of handles) {
            if (!handle) continue;
            await handle.then(dbClose).catch(() => undefined);
        }
    }

    async close(): Promise<void> {
        await this.release();
    }
}

export class AppPostgresDatabase extends PostgresCatalog {
    constructor(
        /** The app's own connection; the agent uses its pool. */
        private readonly id: string,
        private readonly writable: boolean,
    ) {
        super();
    }

    private check(): void {
        if (!this.writable) throw new ReadOnlyServerError('handoff');
        this.tables = null;
    }

    async read(sql: string): Promise<QueryResult> {
        return perStatement(await dbRun(this.id, [sql], READ), 1)[0];
    }

    async write(sql: string): Promise<QueryResult> {
        this.check();
        return perStatement(await dbRun(this.id, [sql], WRITE), 1)[0];
    }

    async writeAll(sqls: string[]): Promise<QueryResult[]> {
        this.check();
        return perStatement(await dbRun(this.id, sqls, { ...WRITE, transaction: true }), sqls.length);
    }

    async flushWrites(): Promise<void> {}

    async release(): Promise<void> {}

    /** The connection is the app's; closing it is the app's to do. */
    async close(): Promise<void> {}
}
