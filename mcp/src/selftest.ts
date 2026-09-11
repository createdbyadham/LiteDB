#!/usr/bin/env node
// Self-test for the MCP server. No model, no API key, no cost — CI can run it
// on every pull request.
//
// What it is actually protecting: this server's whole claim is that a write
// cannot run without being previewed first, and that claim is made of several
// separate pieces — the classifier, the policy floor, the token store, the
// read-only connection. Any one of them silently degrading leaves a server
// that still answers every question correctly and no longer guards anything.
// So the assertions below check the *outcome* — did the row change? — rather
// than checking that the right function was called.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseLog } from '../../src/lib/auditLog';
import {
    mcpPolicyFromApp,
    parseHandoff,
    postgresTarget,
    serializeHandoff,
    type McpHandoff,
} from '../../src/lib/mcpHandoff';
import { mergeLiteDbMcp } from '../../src/lib/mcpAgentConfig';
import * as approvals from './approvals';
import { installAudit } from './audit';
import { ConfigError, IN_MEMORY_MESSAGE, NO_DATABASE_MESSAGE, defaultAuditPath, loadConfig, type ServerConfig } from './config';
import { openDatabase, ReadOnlyServerError, type Database } from './db';
import { renderTable } from './render';
import { runApproved, runQuery, type ToolContext } from './tools/query';
import { describeTable, listTables } from './tools/schema';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        process.stdout.write(`  ok   ${name}\n`);
    } else {
        failures++;
        process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
    }
}

const SCHEMA = `
CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    country TEXT
);
CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    status TEXT,
    total REAL DEFAULT 0
);
CREATE INDEX orders_status_idx ON orders(status);
`;

const SEED = `
INSERT INTO customers (id, email, country) VALUES
    (1, 'ada@example.com', 'DE'),
    (2, 'grace@example.com', 'US'),
    (3, 'alan@example.com', 'DE');
INSERT INTO orders (id, customer_id, status, total) VALUES
    (1, 1, 'shipped', 19.99),
    (2, 1, 'pending', 5.00),
    (3, 2, 'shipped', 42.50),
    (4, 3, 'cancelled', 0);
`;

interface Harness {
    dir: string;
    dbPath: string;
    auditPath: string;
}

function buildFixture(): Harness {
    const dir = mkdtempSync(join(tmpdir(), 'litedb-mcp-test-'));
    const dbPath = join(dir, 'fixture.sqlite');
    const auditPath = join(dir, 'audit', 'sql-audit.jsonl');

    const writer = new DatabaseSync(dbPath);
    writer.exec(SCHEMA);
    writer.exec(SEED);
    writer.close();

    return { dir, dbPath, auditPath };
}

function configFor(harness: Harness, policy: ServerConfig['policy']): ServerConfig {
    return {
        dialect: 'sqlite',
        target: harness.dbPath,
        connectionId: `sqlite:${harness.dbPath}`,
        policy,
        maxRows: 50,
        auditPath: harness.auditPath,
        embeddingModelId: 'minilm',
        modelCachePath: join(harness.dir, 'models'),
        source: 'env',
    };
}

/** Count rows on a connection of our own, so no tool is asked to grade itself. */
function countRows(harness: Harness, table: string, predicate = '1=1'): number {
    const db = new DatabaseSync(harness.dbPath, { readOnly: true });
    try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`).get() as {
            n: number;
        };
        return Number(row.n);
    } finally {
        db.close();
    }
}

function auditEntries(harness: Harness) {
    try {
        return parseLog(readFileSync(harness.auditPath, 'utf8'));
    } catch {
        return [];
    }
}

function threw(work: () => unknown): Error | null {
    try {
        work();
        return null;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}

async function main(): Promise<void> {
    // ------------------------------------------------------------ config ---
    process.stdout.write('\nconfig\n');

    const missingHandoff = join(tmpdir(), 'litedb-mcp-no-handoff.json');
    const noDb = threw(() => loadConfig({ LITEDB_HANDOFF_PATH: missingHandoff }));
    check(
        'refuses to start with no database',
        noDb instanceof ConfigError &&
            noDb.retryable &&
            noDb.message === NO_DATABASE_MESSAGE,
        'the error has to mention both the app and the env vars',
    );

    check(
        'refuses two databases at once',
        threw(() =>
            loadConfig({ LITEDB_DATABASE_URL: 'postgres://x/y', LITEDB_SQLITE_PATH: 'a.db' }),
        ) instanceof ConfigError,
    );

    const yolo = threw(() => loadConfig({ LITEDB_SQLITE_PATH: 'a.db', LITEDB_POLICY: 'yolo' }));
    check(
        'refuses LITEDB_POLICY=yolo',
        yolo instanceof ConfigError && /yolo/i.test(yolo.message) && !yolo.retryable,
        'YOLO has no banner and nobody watching over MCP; it must not be reachable',
    );

    check(
        'defaults to read-only',
        loadConfig({ LITEDB_SQLITE_PATH: 'a.db' }).policy === 'read-only',
        'the app defaults to guarded because a person is in front of it; a server is not',
    );

    check(
        'postgres identity excludes credentials',
        (() => {
            const id = loadConfig({
                LITEDB_DATABASE_URL: 'postgres://someone:hunter2@db.internal:5433/shop',
            }).connectionId;
            return id === 'postgres:db.internal:5433/shop' && !id.includes('hunter2');
        })(),
        'the connection id is written to the audit log',
    );

    check(
        'the audit path lands under the app identifier',
        defaultAuditPath({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }).includes(
            'com.adhamehab.litedb',
        ),
    );

    check('YOLO in the app maps down to guarded', mcpPolicyFromApp('yolo') === 'guarded');
    check('guarded in the app stays guarded', mcpPolicyFromApp('guarded') === 'guarded');

    const handoffDir = mkdtempSync(join(tmpdir(), 'litedb-mcp-handoff-'));
    const handoffFile = join(handoffDir, 'mcp-handoff.json');
    const sqliteHandoff: McpHandoff = {
        version: 1,
        updatedAt: '2026-09-11T00:00:00.000Z',
        connectionId: 'sqlite:/tmp/shop.db',
        label: 'sqlite:shop.db',
        dialect: 'sqlite',
        policy: 'guarded',
        sqlitePath: '/tmp/shop.db',
    };
    writeFileSync(handoffFile, serializeHandoff(sqliteHandoff));

    check(
        'handoff supplies the open SQLite file',
        loadConfig({ LITEDB_HANDOFF_PATH: handoffFile }).target === '/tmp/shop.db' &&
            loadConfig({ LITEDB_HANDOFF_PATH: handoffFile }).policy === 'guarded' &&
            loadConfig({ LITEDB_HANDOFF_PATH: handoffFile }).source === 'handoff',
    );

    check(
        'env wins over the handoff file',
        loadConfig({
            LITEDB_HANDOFF_PATH: handoffFile,
            LITEDB_SQLITE_PATH: '/other.db',
        }).target === '/other.db' &&
            loadConfig({
                LITEDB_HANDOFF_PATH: handoffFile,
                LITEDB_SQLITE_PATH: '/other.db',
            }).source === 'env' &&
            loadConfig({
                LITEDB_HANDOFF_PATH: handoffFile,
                LITEDB_SQLITE_PATH: '/other.db',
            }).policy === 'read-only',
    );

    const yoloHandoff = { ...sqliteHandoff, policy: 'yolo' as const };
    writeFileSync(handoffFile, serializeHandoff(yoloHandoff));
    check(
        'YOLO in the handoff becomes guarded, not a refusal',
        loadConfig({ LITEDB_HANDOFF_PATH: handoffFile }).policy === 'guarded',
        'YOLO means a human is watching the window, which is exactly what is not true over MCP',
    );

    const memoryHandoff = { ...sqliteHandoff, policy: 'guarded' as const, sqlitePath: null };
    writeFileSync(handoffFile, serializeHandoff(memoryHandoff));
    const memory = threw(() => loadConfig({ LITEDB_HANDOFF_PATH: handoffFile }));
    check(
        'in-memory SQLite is refused with a specific error',
        memory instanceof ConfigError &&
            memory.retryable &&
            memory.message === IN_MEMORY_MESSAGE,
    );

    const pgHandoff: McpHandoff = {
        version: 1,
        updatedAt: '2026-09-11T00:00:00.000Z',
        connectionId: 'postgres:localhost:5432/shop',
        label: 'postgres:localhost/shop',
        dialect: 'postgres',
        policy: 'read-only',
        postgres: {
            host: 'localhost',
            port: 5432,
            database: 'shop',
            username: 'ada',
            password: 's3cret',
            ssl: false,
        },
    };
    writeFileSync(handoffFile, serializeHandoff(pgHandoff));
    const fromPg = loadConfig({ LITEDB_HANDOFF_PATH: handoffFile });
    check(
        'handoff Postgres URL includes the password',
        fromPg.target === postgresTarget(pgHandoff.postgres!) && fromPg.target.includes('s3cret'),
    );
    check(
        'handoff Postgres identity still excludes the password',
        fromPg.connectionId === 'postgres:localhost:5432/shop' && !fromPg.connectionId.includes('s3cret'),
    );

    const roundTrip = parseHandoff(serializeHandoff(pgHandoff));
    check('handoff round-trips', roundTrip.postgres?.password === 's3cret');

    check(
        'LITEDB_POLICY overrides the handoff policy',
        loadConfig({ LITEDB_HANDOFF_PATH: handoffFile, LITEDB_POLICY: 'unrestricted' }).policy ===
            'unrestricted',
    );

    const mergedDesktop = JSON.parse(
        mergeLiteDbMcp('{"preferences":{"sidebarMode":"epitaxy"}}', {
            command: 'npx',
            args: ['-y', 'litedb-mcp'],
        }),
    );
    check(
        'Claude Desktop merge keeps preferences',
        mergedDesktop.preferences?.sidebarMode === 'epitaxy',
    );
    check(
        'Claude Desktop merge puts mcpServers at the top level',
        mergedDesktop.mcpServers?.litedb?.command === 'npx' && !('mcpServers' in (mergedDesktop.preferences ?? {})),
    );

    // --------------------------------------------------------- read-only ---
    process.stdout.write('\nread-only policy\n');

    approvals.reset();
    let harness = buildFixture();
    let config = configFor(harness, 'read-only');
    let db: Database = await openDatabase(config);
    let ctx: ToolContext = { db, config };
    installAudit({
        connection: config.connectionId,
        dialect: 'sqlite',
        policy: 'read-only',
        path: harness.auditPath,
    });

    try {
        const read = await runQuery(ctx, 'SELECT id, status FROM orders ORDER BY id');
        check('a read runs', !read.isError && read.text.includes('shipped'));

        const before = countRows(harness, 'orders');
        const deletion = await runQuery(ctx, 'DELETE FROM orders WHERE id = 1');
        check('a bounded DELETE is refused', deletion.isError === true);
        check('the refusal says why', /read-only/i.test(deletion.text));
        check('nothing was deleted', countRows(harness, 'orders') === before);

        const update = await runQuery(ctx, "UPDATE orders SET status = 'shipped'");
        check('an unbounded UPDATE is refused', update.isError === true);
        check(
            'no approval token was issued',
            !/token:/.test(update.text) && approvals.size() === 0,
            'a refusal must not leave something that could later be executed',
        );

        // The engine, not the classifier. This is the layer that holds when
        // parsing is wrong.
        let engineRefused = false;
        try {
            await db.write("UPDATE orders SET status = 'x'");
        } catch (error) {
            engineRefused = error instanceof ReadOnlyServerError;
        }
        check('the connection itself refuses a write', engineRefused);

        let sqliteRefused = false;
        try {
            await db.read("UPDATE orders SET status = 'x'");
        } catch {
            sqliteRefused = true;
        }
        check(
            'SQLite refuses a write on the read connection',
            sqliteRefused,
            'defence in depth: this must fail even if the classifier let it through',
        );

        const entries = auditEntries(harness);
        check(
            'the refusal was logged',
            entries.some((e) => e.decision === 'blocked' && e.outcome === 'not-run'),
        );
        check(
            "a model's read was logged too",
            entries.some((e) => e.kind === 'read' && e.provenance === 'ai'),
            'a read is a record of what the model was allowed to see',
        );
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ----------------------------------------------------------- guarded ---
    process.stdout.write('\nguarded policy\n');

    approvals.reset();
    harness = buildFixture();
    config = configFor(harness, 'guarded');
    db = await openDatabase(config);
    ctx = { db, config };
    installAudit({
        connection: config.connectionId,
        dialect: 'sqlite',
        policy: 'guarded',
        path: harness.auditPath,
    });

    try {
        const before = countRows(harness, 'orders');
        const preview = await runQuery(ctx, "DELETE FROM orders WHERE status = 'shipped'");

        check('a write is not executed', countRows(harness, 'orders') === before);
        check('the preview asks for approval', preview.text.startsWith('APPROVAL REQUIRED'));
        check(
            'the preview is not an error',
            preview.isError !== true,
            'it is an offer, not a refusal',
        );
        check(
            'the exact row count is shown',
            preview.text.includes('2 rows of 4 in orders'),
            'two shipped orders out of four — measured, not estimated',
        );
        check('a token is offered', /token: [0-9a-f-]{36}/.test(preview.text));

        check(
            'the proposal was logged before approval',
            auditEntries(harness).some((e) => e.decision === 'pending' && e.outcome === 'not-run'),
            'a write proposed and abandoned should still leave a trace',
        );

        const token = /token: ([0-9a-f-]{36})/.exec(preview.text)?.[1] ?? '';
        const executed = await runApproved(ctx, token);
        check('approval executes it', executed.text.startsWith('Executed.'));
        check('the rows are gone', countRows(harness, 'orders') === before - 2);
        check('the count is reported', executed.text.includes('2 rows changed'));

        const replay = await runApproved(ctx, token);
        check(
            'the token cannot be reused',
            replay.isError === true,
            'one approval must not authorise the same DELETE twice',
        );

        check('an unknown token is refused', (await runApproved(ctx, 'not-a-token')).isError === true);

        const entries = auditEntries(harness);
        check(
            'the execution was logged as approved',
            entries.some((e) => e.decision === 'approved' && e.actualRows === 2),
        );
        check(
            'the estimate is kept alongside what happened',
            entries.some((e) => e.decision === 'approved' && e.estimatedRows === 2),
            'a log holding only the estimate cannot tell you the preview was wrong',
        );

        const unbounded = await runQuery(ctx, 'DELETE FROM customers');
        check(
            'an unbounded DELETE warns harder',
            /no predicate bounding it/.test(unbounded.text),
            'the class of statement where a mis-click is unrecoverable',
        );
        check(
            'an unbounded DELETE reports the whole table',
            /every row in the table/.test(unbounded.text),
        );

        const reads = await runQuery(ctx, 'SELECT COUNT(*) FROM customers');
        check('reads still run without a prompt', !reads.isError && /3/.test(reads.text));

        // Approved as a unit, so a failure halfway must undo the half that
        // worked — otherwise "Execution failed" describes a database that did
        // in fact change.
        const partial = await runQuery(
            ctx,
            "UPDATE customers SET country = 'FR' WHERE id = 1; " +
                "UPDATE customers SET country = 'XX' WHERE no_such_column = 1",
        );
        const partialToken = /token: ([0-9a-f-]{36})/.exec(partial.text)?.[1] ?? '';
        const partialResult = await runApproved(ctx, partialToken);
        check('a failing statement fails the call', partialResult.isError === true);
        check(
            'and the statement before it is rolled back',
            countRows(harness, 'customers', "country = 'FR'") === 0,
            'a multi-statement approval is all or nothing',
        );

        const mixed = await runQuery(
            ctx,
            "SELECT 1; UPDATE customers SET country = 'FR' WHERE id = 1",
        );
        check(
            'a mixed script is gated by its worst statement',
            mixed.text.startsWith('APPROVAL REQUIRED'),
        );
        check(
            'the write in a mixed script did not run',
            countRows(harness, 'customers', "country = 'FR'") === 0,
            'nothing in a script needing approval may execute before approval',
        );
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ------------------------------------------------------ the AI floor ---
    process.stdout.write('\nAI policy floor\n');

    approvals.reset();
    harness = buildFixture();
    config = configFor(harness, 'unrestricted');
    db = await openDatabase(config);
    ctx = { db, config };
    installAudit({
        connection: config.connectionId,
        dialect: 'sqlite',
        policy: 'unrestricted',
        path: harness.auditPath,
    });

    try {
        const before = countRows(harness, 'orders');
        const result = await runQuery(ctx, 'DELETE FROM orders WHERE id = 1');
        check(
            'unrestricted still previews generated SQL',
            result.text.startsWith('APPROVAL REQUIRED'),
            "raising the connection speeds up your own typing, not the model's writes",
        );
        check('and still does not execute it', countRows(harness, 'orders') === before);
        check(
            'the floor is visible in the result',
            /Policy in force: guarded/.test(result.text),
            'the user should be able to see that the floor was applied',
        );
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ------------------------------------------------------ approvals ---
    process.stdout.write('\napproval store\n');

    approvals.reset();
    const fakeDecision = {
        action: 'confirm' as const,
        kind: 'write' as const,
        worst: null,
        statements: [],
        reason: 'test',
        requireTypedConfirmation: false,
        appliedPolicy: 'guarded' as const,
    };

    const held = approvals.create('DELETE FROM orders', fakeDecision, [], 'sqlite:a', '/a.db', 1_000);
    check('an approval is stored', approvals.size() === 1);
    check(
        'the SQL is held server-side',
        held.sql === 'DELETE FROM orders',
        'execute_approved takes no SQL argument, so nothing can be substituted',
    );

    check(
        'an approval expires',
        threw(() => approvals.claim(held.token, 'sqlite:a', '/a.db', 1_000 + approvals.TTL_MS + 1)) !==
            null,
        'the row count that justified it goes stale',
    );

    approvals.reset();
    const fresh = approvals.create('DELETE FROM orders', fakeDecision, [], 'sqlite:a', '/a.db', 1_000);
    check(
        'a fresh approval is claimable',
        approvals.claim(fresh.token, 'sqlite:a', '/a.db', 1_000).token === fresh.token,
    );
    check('claiming removes it', approvals.size() === 0);

    approvals.reset();
    const bound = approvals.create('DELETE FROM orders', fakeDecision, [], 'sqlite:a', '/a.db', 1_000);
    check(
        'a token cannot run against a different database',
        threw(() => approvals.claim(bound.token, 'sqlite:b', '/b.db', 1_000)) !== null,
    );
    check(
        'the mismatched token is still claimable on the original database',
        approvals.claim(bound.token, 'sqlite:a', '/a.db', 1_000).token === bound.token,
    );

    approvals.reset();
    const role = approvals.create(
        'DELETE FROM orders',
        fakeDecision,
        [],
        'postgres:localhost:5432/shop',
        'postgres://ada@localhost:5432/shop',
        1_000,
    );
    check(
        'a token cannot run as a different role on the same database',
        threw(() =>
            approvals.claim(
                role.token,
                'postgres:localhost:5432/shop',
                'postgres://admin@localhost:5432/shop',
                1_000,
            ),
        ) !== null,
    );

    // ------------------------------------------------------ schema tools ---
    process.stdout.write('\nschema tools\n');

    harness = buildFixture();
    config = configFor(harness, 'read-only');
    db = await openDatabase(config);
    ctx = { db, config };
    installAudit({
        connection: config.connectionId,
        dialect: 'sqlite',
        policy: 'read-only',
        path: harness.auditPath,
    });

    try {
        const tables = await listTables(ctx);
        check(
            'list_tables finds both tables',
            /customers/.test(tables.text) && /orders/.test(tables.text),
        );
        check('list_tables reports row counts', /4 rows/.test(tables.text));
        check('list_tables reports the primary key', /primary key: id/.test(tables.text));

        const described = await describeTable(ctx, 'ORDERS', true);
        check('describe_table is case-insensitive', /Table: orders/.test(described.text));
        check('it reports the primary key', /PRIMARY KEY/.test(described.text));
        check(
            'it reports foreign keys',
            /customer_id -> customers\.id/.test(described.text),
            'a model that cannot see the join key will invent one',
        );
        check('it reports indexes', /orders_status_idx/.test(described.text));
        check(
            'it reports the values a column actually holds',
            /values: [^\n]*shipped/.test(described.text),
            'the difference between a query that runs and one that is right',
        );

        let unknown = '';
        try {
            await describeTable(ctx, 'nope', false);
        } catch (error) {
            unknown = error instanceof Error ? error.message : '';
        }
        check('an unknown table lists the real ones', /customers/.test(unknown));
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ----------------------------------------------------------- render ---
    process.stdout.write('\nrendering\n');

    check(
        'NULL and empty string render differently',
        /NULL/.test(
            renderTable(
                ['a', 'b'],
                [
                    [null, ''],
                    [1, 'x'],
                ],
                { maxRows: 10 },
            ),
        ),
        'they are different answers to "what is in this cell"',
    );

    check(
        'truncation announces itself',
        /1 more row/.test(renderTable(['a'], [[1], [2], [3]], { maxRows: 2 })),
        'a truncated result that looks complete is how a model invents a total',
    );

    check(
        'a vector array is summarised, not printed',
        /\[384 floats\]/.test(
            renderTable(['v'], [[Array.from({ length: 384 }, () => 0.1)]], { maxRows: 1 }),
        ),
    );

    check(
        'a pgvector string is summarised too',
        /\[384 floats\]/.test(
            renderTable(['v'], [[`[${Array.from({ length: 384 }, () => 0.1).join(',')}]`]], {
                maxRows: 1,
            }),
        ),
        'pgvector returns a string, not an array — this is the shape that actually arrives',
    );

    check(
        'an ordinary bracketed string is left alone',
        /\["a","b"\]/.test(
            renderTable(['v'], [['["a","b"]'.padEnd(70, ' ')]], { maxRows: 1 }),
        ),
        'the vector summary must not swallow JSON stored as text',
    );

    process.stdout.write('\n');
    process.stdout.write(failures === 0 ? 'self-test passed\n' : `self-test FAILED (${failures})\n`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
});
