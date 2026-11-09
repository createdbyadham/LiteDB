#!/usr/bin/env node
// Self-test for the MCP server. No model, no API key, no cost, CI can run it
// on every pull request.
//
// What it is actually protecting: this server's whole claim is that a write
// cannot run without being previewed first, and that claim is made of several
// separate pieces, the classifier, the policy floor, the token store, the
// read-only connection. Any one of them silently degrading leaves a server
// that still answers every question correctly and no longer guards anything.
// So the assertions below check the *outcome*, did the row change?, rather
// than checking that the right function was called.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { decisionFileName, parseRequest, requestFileName, serializeDecision } from '../../src/lib/agentApproval';
import { currentStateQueries, parseUndo, planUndo } from '../../src/lib/undoWrite';
import { parseLog } from '../../src/lib/auditLog';
import { pgSslHint } from '../../src/lib/pgSslHint';
import {
    mcpPolicyFromApp,
    parseHandoff,
    postgresTarget,
    serializeHandoff,
    type McpHandoff,
} from '../../src/lib/mcpHandoff';
import { mergeLiteDbMcp } from '../../src/lib/mcpAgentConfig';
import { CLAUDE_STORE_PACKAGE, windowsClaudeConfigPaths } from '../../src/lib/claudeDesktopMcp';
import * as approvals from './approvals';
import { installFileAudit as installAudit } from './auditFile';
import { ConfigError, IN_MEMORY_MESSAGE, NO_DATABASE_MESSAGE, defaultAuditPath, loadConfig, type ServerConfig } from './config';
import { openDatabase, postgresConnectFailure, ReadOnlyServerError, TooManyChangesError, type Database } from './db';
import { renderTable } from './render';
import { LiveSession, nodeToolContext } from './session';
import { executeApprovedInput, runApproved, runQuery, type ToolContext } from './tools/query';
import { describeTable, listTables } from './tools/schema';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        process.stdout.write(`  ok   ${name}\n`);
    } else {
        failures++;
        process.stdout.write(`  FAIL ${name}${detail ? `, ${detail}` : ''}\n`);
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
        'SSL off against a TLS-only host says to turn it on',
        pgSslHint(
            'error returned from database: no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", no encryption',
            false,
        )?.includes('Set SSL to Require') === true,
    );
    check(
        'SSL on against a host without TLS says to turn it off',
        pgSslHint(
            'error occurred while attempting to establish a TLS connection: server does not support TLS',
            true,
        )?.includes('Set SSL to Off') === true,
    );
    check(
        'a certificate the client cannot verify points at the CA setting',
        pgSslHint('error occurred while attempting to establish a TLS connection: invalid peer certificate: UnknownIssuer', true)?.includes(
            'CA certificate',
        ) === true,
    );
    {
        const refused = new AggregateError(
            [
                Object.assign(new Error('connect ECONNREFUSED ::1:5433'), { code: 'ECONNREFUSED' }),
                Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
            ],
            '',
        );
        const message = postgresConnectFailure('postgres://u:s3cret@localhost:5433/shop', refused);
        check(
            'a refused localhost connection is not a blank error',
            message.includes('localhost:5433') && message.includes('ECONNREFUSED 127.0.0.1:5433'),
            message,
        );
        check('and it does not leak the password', !message.includes('s3cret'), message);
    }

    check(
        'a wrong password gets no SSL hint',
        pgSslHint('error returned from database: password authentication failed for user "u"', false) === null,
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

    const sslHandoff = {
        ...pgHandoff,
        postgres: { ...pgHandoff.postgres!, ssl: true },
    };
    check(
        'handoff SSL encrypts without verifying the cert (matches the app checkbox)',
        postgresTarget(sslHandoff.postgres).includes('sslmode=no-verify') &&
            !postgresTarget(sslHandoff.postgres).includes('sslmode=require'),
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

    const roaming = 'C:\\Users\\ada\\AppData\\Roaming';
    const local = 'C:\\Users\\ada\\AppData\\Local';
    const normalOnly = windowsClaudeConfigPaths(roaming, local, false);
    check(
        'Windows always writes the documented Claude config',
        normalOnly.length === 1 &&
            normalOnly[0] === 'C:\\Users\\ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
    );
    check(
        'Windows skips the Store copy when the Store app is not installed',
        !normalOnly.some((p) => p.includes('Packages')),
        'writing it anyway creates a fake package folder for an app that is not there',
    );
    const withStore = windowsClaudeConfigPaths(roaming, local, true);
    check(
        'Windows writes both when the Store app is installed',
        withStore.length === 2 &&
            withStore[0] === normalOnly[0] &&
            withStore[1] ===
                `C:\\Users\\ada\\AppData\\Local\\Packages\\${CLAUDE_STORE_PACKAGE}\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json`,
    );

    // --------------------------------------------------------- read-only ---
    process.stdout.write('\nread-only policy\n');

    approvals.reset();
    let harness = buildFixture();
    let config = configFor(harness, 'read-only');
    let db: Database = await openDatabase(config);
    let ctx: ToolContext = nodeToolContext(db, config);
    installAudit(harness.auditPath);

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
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

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
            'two shipped orders out of four, measured, not estimated',
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

        // The agent that skips the preview and calls execute_approved with SQL
        // in hand. It must be refused, and told which step it missed, a
        // generic "Required" had one guessing at empty tokens.
        const skipped = z
            .object(executeApprovedInput)
            .safeParse({ sql: "DELETE FROM orders WHERE status = 'pending'" });
        check('execute_approved with SQL and no token is rejected', !skipped.success);
        check(
            'the rejection points at query',
            !skipped.success && skipped.error.issues[0]?.message === approvals.NO_TOKEN_MESSAGE,
            skipped.success ? '' : skipped.error.issues[0]?.message,
        );
        check(
            'SQL cannot ride along with a token',
            !('sql' in (z.object(executeApprovedInput).safeParse({ token: 'x', sql: 'DROP TABLE orders' }).data ?? {})),
        );

        const ordersBeforeBlank = countRows(harness, 'orders');
        const blank = await runApproved(ctx, '   ');
        check('a blank token is refused', blank.isError === true);
        check('a blank token points at query', blank.text === approvals.NO_TOKEN_MESSAGE, blank.text);
        check('a blank token changes nothing', countRows(harness, 'orders') === ordersBeforeBlank);

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
        // worked, otherwise "Execution failed" describes a database that did
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

    // ------------------------------------------ approval in the window ---
    process.stdout.write('\napproval in the LiteDB window\n');

    {
        // The handoff switches it on; an app that does not say so keeps the old way.
        const dir = mkdtempSync(join(tmpdir(), 'litedb-handoff-test-'));
        const handoffPath = join(dir, 'mcp-handoff.json');
        const base = { version: 1, connectionId: 'sqlite:x', label: 'x', dialect: 'sqlite', policy: 'guarded', sqlitePath: join(dir, 'x.db') };
        try {
            writeFileSync(handoffPath, JSON.stringify({ ...base, approveInApp: true }));
            check(
                'an app that shows requests gets them',
                loadConfig({ LITEDB_HANDOFF_PATH: handoffPath }).approvalsDir === join(dirname(handoffPath), 'approvals'),
            );
            writeFileSync(handoffPath, JSON.stringify(base));
            check(
                'an older app leaves the asking to the host',
                !loadConfig({ LITEDB_HANDOFF_PATH: handoffPath }).approvalsDir,
                'it has no window to answer, so waiting on one would hang every write',
            );
            check('without the switch, every write asks', !loadConfig({ LITEDB_HANDOFF_PATH: handoffPath }).directWrites);
            writeFileSync(handoffPath, JSON.stringify({ ...base, directWrites: { maxRows: 25 } }));
            check(
                'the switch in the app reaches the server',
                loadConfig({ LITEDB_HANDOFF_PATH: handoffPath }).directWrites?.maxRows === 25,
            );
            writeFileSync(handoffPath, JSON.stringify({ ...base, production: true, directWrites: { maxRows: 25 } }));
            check(
                'never on a production connection',
                !loadConfig({ LITEDB_HANDOFF_PATH: handoffPath }).directWrites,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    approvals.reset();
    harness = buildFixture();
    config = { ...configFor(harness, 'guarded'), approvalsDir: join(harness.dir, 'approvals'), approvalWaitMs: 300 };
    db = await openDatabase(config);
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

    try {
        const dir = join(harness.dir, 'approvals');
        const before = countRows(harness, 'orders');
        const tokenIn = (text: string) => /token: ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';
        const answer = (token: string, decision: 'approved' | 'declined') =>
            writeFileSync(join(dir, decisionFileName(token)), serializeDecision({ token, decision, at: new Date().toISOString() }));

        const token = tokenIn((await runQuery(ctx, "UPDATE orders SET status = 'refunded' WHERE customer_id = 1")).text);
        const waiting = await runApproved(ctx, token);
        check(
            'with no answer, the call says it is waiting',
            waiting.text.startsWith('WAITING FOR APPROVAL IN LITEDB') && waiting.isError !== true,
        );
        check('nothing ran while waiting', countRows(harness, 'orders', "status = 'refunded'") === 0);
        check('the token survives the wait', approvals.size() === 1);

        const requestPath = join(dir, requestFileName(token));
        const request = existsSync(requestPath) ? parseRequest(readFileSync(requestPath, 'utf8')) : null;
        check('the request is on disk for the window', request?.token === token);
        check('it carries the exact row count', request?.statements[0]?.affectedRows === 2);
        const diff = request?.statements[0]?.diff;
        check(
            'it shows the rows it changes, old and new',
            diff?.mode === 'update' &&
                diff.rows.length === 2 &&
                diff.changes?.[0]?.column === 'status' &&
                diff.changes[0].values.every((v) => v === 'refunded'),
            JSON.stringify(diff),
        );

        answer(token, 'approved');
        const approved = await runApproved(ctx, token);
        check('after Approve in the window, it runs', approved.text.startsWith('Executed.'), approved.text);
        check('the rows changed', countRows(harness, 'orders', "status = 'refunded'") === 2);
        check(
            'the request and the answer are cleaned up',
            !existsSync(requestPath) && !existsSync(join(dir, decisionFileName(token))),
        );

        const second = tokenIn((await runQuery(ctx, 'DELETE FROM orders WHERE id = 4')).text);
        // Answered while the call waits, as the window does.
        setTimeout(() => answer(second, 'declined'), 50);
        const declined = await runApproved(ctx, second);
        check('Decline in the window refuses it', declined.isError === true && declined.text.startsWith('DECLINED in LiteDB'));
        check('nothing was deleted', countRows(harness, 'orders') === before);
        check('a declined token is spent', (await runApproved(ctx, second)).isError === true);
        check(
            'the log records the decline',
            auditEntries(harness).some((e) => e.decision === 'declined' && e.outcome === 'not-run'),
        );

        const third = tokenIn((await runQuery(ctx, 'DELETE FROM orders WHERE id = 3')).text);
        writeFileSync(
            join(dir, decisionFileName(third)),
            serializeDecision({ token: 'some-other-token', decision: 'approved', at: new Date().toISOString() }),
        );
        const forged = await runApproved(ctx, third);
        check(
            "an answer naming another token does not count",
            forged.text.startsWith('WAITING') && countRows(harness, 'orders', 'id = 3') === 1,
        );
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // -------------------------------------------------------------- undo ---
    process.stdout.write('\nundo\n');

    approvals.reset();
    harness = buildFixture();
    config = configFor(harness, 'guarded');
    db = await openDatabase(config);
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

    try {
        const tokenIn = (text: string) => /token: ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';
        const approve = async (sql: string) => runApproved(ctx, tokenIn((await runQuery(ctx, sql)).text));
        const lastUndo = () => {
            const link = auditEntries(harness).filter((e) => e.decision === 'approved').pop()?.undo;
            return link ? parseUndo(readFileSync(join(dirname(harness.auditPath), link), 'utf8')) : null;
        };
        // What the app does: read what is there now, plan, run the plan.
        const undoIt = () => {
            const record = lastUndo();
            if (!record) return null;
            const own = new DatabaseSync(harness.dbPath);
            try {
                const current = currentStateQueries(record).flatMap(
                    (sql) => own.prepare(sql).all().map((row) => Object.values(row as Record<string, unknown>)),
                );
                const plan = planUndo(record, current);
                for (const sql of plan.statements) own.exec(sql);
                return plan;
            } finally {
                own.close();
            }
        };

        await approve("DELETE FROM orders WHERE status = 'shipped'");
        const deleted = lastUndo();
        check('a DELETE saves the rows it removed', deleted?.kind === 'delete' && deleted.rows.length === 2);
        check('keyed by the primary key', deleted?.key.join() === 'id');
        const restored = undoIt();
        check('undo puts them back', restored?.restore === 2 && countRows(harness, 'orders', "status = 'shipped'") === 2);

        await approve("UPDATE orders SET status = 'refunded' WHERE customer_id = 1");
        const updated = lastUndo();
        check(
            'an UPDATE saves the old values and the new',
            updated?.kind === 'update' && updated.assigned?.join() === 'status' && updated.after?.every((v) => v[0] === 'refunded') === true,
        );
        // Someone changes one of the rows again before the undo.
        const other = new DatabaseSync(harness.dbPath);
        other.exec("UPDATE orders SET status = 'disputed' WHERE id = 2");
        other.close();
        const reverted = undoIt();
        check(
            'undo reverts what is still as the write left it, and leaves newer work alone',
            reverted?.restore === 1 &&
                reverted.skipped === 1 &&
                countRows(harness, 'orders', "id = 1 AND status = 'shipped'") === 1 &&
                countRows(harness, 'orders', "id = 2 AND status = 'disputed'") === 1,
        );

        const before = countRows(harness, 'customers');
        await approve("INSERT INTO customers (email, country) VALUES ('new@example.com', 'FR'), ('two@example.com', 'FR')");
        const inserted = lastUndo();
        check('a SQLite INSERT notes the new rowids', inserted?.kind === 'insert' && inserted.rowids?.upTo === (inserted.rowids?.after ?? 0) + 2);
        undoIt();
        check('undo removes the rows it added', countRows(harness, 'customers') === before);

        await approve("UPDATE orders SET total = total + 1 WHERE id = 1; UPDATE orders SET total = total + 1 WHERE id = 2");
        check(
            'a script is not saved for undo: its statements depend on each other',
            auditEntries(harness).filter((e) => e.decision === 'approved').slice(-2).every((e) => !e.undo),
        );
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ---------------------------------------------- writes without asking ---
    process.stdout.write('\nwrites without asking\n');

    approvals.reset();
    harness = buildFixture();
    config = { ...configFor(harness, 'guarded'), directWrites: { maxRows: 2 } };
    db = await openDatabase(config);
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

    try {
        const write = (sql: string) => runQuery(ctx, sql, { direct: true });
        const ran = (text: string) => text.startsWith('Executed without approval');
        const asked = (text: string) => text.startsWith('APPROVAL REQUIRED');

        const bounded = await write("UPDATE orders SET status = 'held' WHERE status = 'shipped'");
        check(
            'a bounded UPDATE within the limit runs in one call',
            ran(bounded.text) && countRows(harness, 'orders', "status = 'held'") === 2,
            bounded.text,
        );
        const entry = auditEntries(harness).pop();
        check(
            'it is logged as run without approval, with its limit, its rows and an undo',
            entry?.decision === 'allowed' && entry.directLimit === 2 && entry.actualRows === 2 && Boolean(entry.undo),
        );

        const tooMany = await write('UPDATE orders SET total = 1 WHERE id > 0');
        check(
            'over the limit it asks, and says why',
            asked(tooMany.text) && tooMany.text.includes('more than the 2') && countRows(harness, 'orders', 'total = 1') === 0,
            tooMany.text,
        );
        check('a write with no WHERE clause asks', asked((await write('DELETE FROM customers')).text) && countRows(harness, 'customers') === 3);
        check('a schema change asks', asked((await write('CREATE TABLE notes (id INTEGER PRIMARY KEY)')).text));

        const two = await write("INSERT INTO customers (email) VALUES ('a@example.com'), ('b@example.com')");
        check('an INSERT of listed rows within the limit runs', ran(two.text) && countRows(harness, 'customers') === 5, two.text);
        check(
            'an INSERT of more rows than the limit asks',
            asked((await write("INSERT INTO customers (email) VALUES ('c@x'), ('d@x'), ('e@x')")).text) &&
                countRows(harness, 'customers') === 5,
        );
        check(
            'an INSERT fed by a SELECT asks: its size is not in the statement',
            asked((await write('INSERT INTO customers (email) SELECT email FROM customers WHERE id = 1')).text),
        );
        const upsert = await write(
            "INSERT INTO customers (id, email) VALUES (1, 'x@example.com') ON CONFLICT(id) DO UPDATE SET email = excluded.email",
        );
        check('an upsert asks', asked(upsert.text) && countRows(harness, 'customers', "email = 'x@example.com'") === 0);
        check('INSERT OR REPLACE asks', asked((await write("INSERT OR REPLACE INTO customers (id, email) VALUES (1, 'y@x')")).text));

        const viaQuery = await runQuery(ctx, 'DELETE FROM orders WHERE id = 4');
        check('query never writes, even where write may', asked(viaQuery.text) && countRows(harness, 'orders', 'id = 4') === 1);

        // The limit holds when the write runs, not only when it is counted.
        let rolledBack = false;
        try {
            await db.writeAll(['UPDATE orders SET total = 2 WHERE id > 0'], { maxChanges: 2 });
        } catch (error) {
            rolledBack = error instanceof TooManyChangesError;
        }
        check('a run over its row limit is rolled back', rolledBack && countRows(harness, 'orders', 'total = 2') === 0);

        const off = await runQuery({ ...ctx, config: { ...ctx.config, directWrites: null } }, 'DELETE FROM orders WHERE id = 4', {
            direct: true,
        });
        check(
            'switched off, write previews and says why',
            asked(off.text) && off.text.includes('does not allow writes without approval') && countRows(harness, 'orders', 'id = 4') === 1,
        );
        const readOnly = await runQuery({ ...ctx, config: { ...ctx.config, policy: 'read-only' } }, 'DELETE FROM orders WHERE id = 4', {
            direct: true,
        });
        check('a read-only connection refuses it all the same', readOnly.text.startsWith('REFUSED') && countRows(harness, 'orders', 'id = 4') === 1);
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ---------------------------------------------------- WAL visibility ---
    process.stdout.write('\nWAL visibility\n');

    approvals.reset();
    harness = buildFixture();
    {
        const walSetup = new DatabaseSync(harness.dbPath);
        walSetup.exec('PRAGMA journal_mode=WAL');
        walSetup.close();
    }
    config = configFor(harness, 'guarded');
    db = await openDatabase(config);
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

    try {
        const mtimeBefore = statSync(harness.dbPath).mtimeMs;
        const preview = await runQuery(ctx, "UPDATE orders SET status = 'refunded' WHERE id = 2");
        const token = /token: ([0-9a-f-]{36})/.exec(preview.text)?.[1] ?? '';
        // Clear of any filesystem timestamp granularity.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = await runApproved(ctx, token);
        check('an approved write to a WAL-mode file runs', result.text.startsWith('Executed.'));
        check(
            "and moves the main file's modified time",
            statSync(harness.dbPath).mtimeMs !== mtimeBefore,
            'the app spots outside writes by mtime; a write left sitting in -wal is invisible to it and gets saved over',
        );
        check(
            'a successful checkpoint is not reported as a warning',
            !result.text.includes('another program'),
        );
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    approvals.reset();
    harness = buildFixture();
    {
        const walSetup = new DatabaseSync(harness.dbPath);
        walSetup.exec('PRAGMA journal_mode=WAL');
        walSetup.close();
    }
    config = configFor(harness, 'guarded');
    db = await openDatabase(config);
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);
    try {
        const holder = new DatabaseSync(harness.dbPath);
        holder.exec('BEGIN');
        holder.prepare('SELECT * FROM orders').all();
        try {
            const preview = await runQuery(ctx, "UPDATE orders SET status = 'held' WHERE id = 1");
            const token = /token: ([0-9a-f-]{36})/.exec(preview.text)?.[1] ?? '';
            const result = await runApproved(ctx, token);
            check(
                'a busy checkpoint is reported to the agent',
                result.text.startsWith('Executed.') && result.text.includes('another program'),
                result.text,
            );
        } finally {
            holder.exec('ROLLBACK');
            holder.close();
        }
    } finally {
        await db.close();
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ------------------------------------------- app saves between calls ---
    process.stdout.write('\napp saves the file between tool calls\n');

    // The desktop app writes a whole file image. Before connections were
    // released per call, a WAL-mode file came out of this sequence with the
    // app's edit reverted or "database disk image is malformed".
    approvals.reset();
    harness = buildFixture();
    {
        const walSetup = new DatabaseSync(harness.dbPath);
        walSetup.exec('PRAGMA journal_mode=WAL');
        walSetup.close();
    }
    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        LITEDB_SQLITE_PATH: harness.dbPath,
        LITEDB_POLICY: 'guarded',
        LITEDB_AUDIT_PATH: harness.auditPath,
        LITEDB_HANDOFF_PATH: join(harness.dir, 'no-handoff.json'),
    });
    const session = new LiveSession();
    try {
        const approve = async (sql: string) => {
            const preview = await session.run((c) => runQuery(c, sql));
            const token = /token: ([0-9a-f-]{36})/.exec(preview.text)?.[1] ?? '';
            return session.run((c) => runApproved(c, token));
        };

        await session.run((c) => runQuery(c, 'SELECT * FROM orders'));
        const first = await approve("UPDATE orders SET status = 'agent-1' WHERE id = 1");
        check('the first agent write runs', first.text.startsWith('Executed.'), first.text);
        check(
            'no -wal is left behind once the call ends',
            !existsSync(`${harness.dbPath}-wal`),
            'a handle kept open between calls is what goes stale under the app',
        );

        // The app: copy the main file, edit it hard enough to split pages,
        // write the image back over the original.
        const appCopy = join(harness.dir, 'app-copy.sqlite');
        writeFileSync(appCopy, readFileSync(harness.dbPath));
        {
            const app = new DatabaseSync(appCopy);
            app.exec('BEGIN');
            const insert = app.prepare(
                "INSERT INTO orders (customer_id, status, total) VALUES (1, 'app-bulk', 1)",
            );
            for (let i = 0; i < 2000; i++) insert.run();
            app.exec("UPDATE orders SET status = 'app' WHERE id = 2");
            app.exec('COMMIT');
            app.close();
        }
        writeFileSync(harness.dbPath, readFileSync(appCopy));

        const seen = await session.run((c) =>
            runQuery(c, "SELECT status FROM orders WHERE id = 2"),
        );
        check("the agent's next read sees the app's save", seen.text.includes('app'), seen.text);

        const second = await approve("UPDATE orders SET status = 'agent-2' WHERE id = 3");
        check('a later agent write runs', second.text.startsWith('Executed.'), second.text);

        const verify = new DatabaseSync(harness.dbPath, { readOnly: true });
        try {
            const integrity = (verify.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
                .integrity_check;
            check('the file is not corrupted', integrity === 'ok', integrity);
            const statuses = verify
                .prepare('SELECT status FROM orders WHERE id IN (1, 2, 3) ORDER BY id')
                .all()
                .map((r) => (r as { status: string }).status)
                .join(',');
            check(
                "neither side's write is lost",
                statuses === 'agent-1,app,agent-2',
                statuses,
            );
            check(
                "and the app's bulk insert survived",
                countRows(harness, 'orders', "status = 'app-bulk'") === 2000,
            );
        } finally {
            verify.close();
        }
    } finally {
        await session.close();
        process.env = savedEnv;
        rmSync(harness.dir, { recursive: true, force: true });
    }

    // ------------------------------------------------------ the AI floor ---
    process.stdout.write('\nAI policy floor\n');

    approvals.reset();
    harness = buildFixture();
    config = configFor(harness, 'unrestricted');
    db = await openDatabase(config);
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

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
    ctx = nodeToolContext(db, config);
    installAudit(harness.auditPath);

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
        'pgvector returns a string, not an array, this is the shape that actually arrives',
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
