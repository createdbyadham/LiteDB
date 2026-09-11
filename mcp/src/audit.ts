// Writing the audit log from Node, into the same file the desktop app uses.
//
// Sharing the file is the point. The log exists to answer "what has touched
// this database?", and an agent reaching the database over MCP is exactly the
// kind of thing that question is about. A separate server-side log would
// answer a narrower question nobody asks. So `litedb-mcp` appends to
// `<app data>/com.adhamehab.litedb/audit/sql-audit.jsonl`, in the same
// one-object-per-line format, and the app's audit view shows both histories
// interleaved with no work on its side.
//
// The format, the parser and the append ordering all stay in
// `src/lib/auditLog.ts`. This file is only the place the bytes land.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
    newAuditId,
    recordAudit,
    setAuditSink,
    type AuditDecision,
    type AuditEntry,
    type AuditOutcome,
    type AuditSink,
} from '../../src/lib/auditLog';
import type { SqlDialect } from '../../src/lib/schemaTypes';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import type { SafetyPolicy } from '../../src/lib/sqlPolicy';

function createFileSink(path: string): AuditSink {
    let ensured = false;

    return {
        async append(line: string): Promise<void> {
            if (!ensured) {
                await mkdir(dirname(path), { recursive: true });
                ensured = true;
            }
            await appendFile(path, line, 'utf8');
        },
        async read(): Promise<string> {
            try {
                return await readFile(path, 'utf8');
            } catch (error) {
                // No log yet is not a failure; it is a log with nothing in it.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
                throw error;
            }
        },
        location(): string {
            return path;
        },
    };
}

export interface AuditContext {
    connection: string;
    dialect: SqlDialect;
    policy: SafetyPolicy;
    path: string;
}

let context: AuditContext | null = null;

/** Point `recordAudit` at a file and remember what to stamp entries with. */
export function installAudit(next: AuditContext): void {
    context = next;
    setAuditSink(createFileSink(next.path));
}

export interface DecisionRecord {
    statements: StatementClassification[];
    decision: AuditDecision;
    outcome: AuditOutcome;
    error?: string | null;
    estimatedRows?: number | null;
    actualRows?: number | null;
    durationMs?: number | null;
}

/**
 * One entry per statement, mirroring `queryGate.recordDecision`.
 *
 * Provenance is hard-coded to `ai` and never passed in. Over MCP the caller is
 * a model by construction — that is what the protocol is for — so offering a
 * `user` option would only create a way to mislabel the log.
 */
export async function record(entry: DecisionRecord): Promise<void> {
    if (!context) return;
    const at = new Date().toISOString();

    for (const statement of entry.statements) {
        const row: AuditEntry = {
            id: newAuditId(),
            at,
            provenance: 'ai',
            connection: context.connection,
            dialect: context.dialect,
            sql: statement.sql,
            kind: statement.kind,
            verb: statement.verb,
            table: statement.table,
            policy: context.policy,
            decision: entry.decision,
            outcome: entry.outcome,
            error: entry.error ?? null,
            estimatedRows: entry.estimatedRows ?? null,
            actualRows: entry.actualRows ?? null,
            durationMs: entry.durationMs ?? null,
            // The MCP host does not tell the server which model is driving it,
            // and inventing a name would be worse than admitting we do not
            // know. `connection` plus `provenance: 'ai'` already records that
            // it arrived over MCP.
            model: null,
            prompt: null,
        };
        await recordAudit(row);
    }
}
