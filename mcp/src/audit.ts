// Recording what agents do, into the same log the desktop app uses.
//
// The npm server writes the file through auditFile.ts; served from inside the
// app, entries go straight into the app's own log.
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
// `src/lib/auditLog.ts`. This file only decides what an entry says.

import {
    newAuditId,
    recordAudit,
    type AuditDecision,
    type AuditEntry,
    type AuditOutcome,
} from '../../src/lib/auditLog';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import type { ToolConfig } from './toolConfig';

/**
 * What an entry is stamped with: the connection and policy of the call, and
 * which host made it. A tool context is one. Passed per call rather than held
 * here, because the app serves several hosts at once.
 */
export interface AuditScope {
    config: Pick<ToolConfig, 'connectionId' | 'dialect' | 'policy'>;
    /** The MCP host's own name for itself (clientInfo.name), once the handshake has said. */
    client?: string | null;
}

export interface DecisionRecord {
    statements: StatementClassification[];
    decision: AuditDecision;
    outcome: AuditOutcome;
    error?: string | null;
    estimatedRows?: number | null;
    actualRows?: number | null;
    durationMs?: number | null;
    /** The Undo file for this write, relative to the audit folder. */
    undo?: string | null;
    /** Ran without approval, under this connection's row limit for agents. */
    directLimit?: number | null;
}

/**
 * One entry per statement, mirroring `queryGate.recordDecision`.
 *
 * Provenance is hard-coded to `ai` and never passed in. Over MCP the caller is
 * a model by construction — that is what the protocol is for — so offering a
 * `user` option would only create a way to mislabel the log.
 */
export async function record(scope: AuditScope, entry: DecisionRecord): Promise<void> {
    const at = new Date().toISOString();

    for (const statement of entry.statements) {
        const row: AuditEntry = {
            id: newAuditId(),
            at,
            provenance: 'ai',
            connection: scope.config.connectionId,
            dialect: scope.config.dialect,
            sql: statement.sql,
            kind: statement.kind,
            verb: statement.verb,
            table: statement.table,
            policy: scope.config.policy,
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
            // The host's own name for itself (clientInfo.name). Unlike a model
            // name this is something the protocol does tell us.
            client: scope.client ?? null,
            ...(entry.undo ? { undo: entry.undo } : {}),
            ...(entry.directLimit ? { directLimit: entry.directLimit } : {}),
        };
        await recordAudit(row);
    }
}
