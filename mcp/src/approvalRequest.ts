// What the LiteDB window is shown before an agent's write runs.
//
// The protocol and its limits are in src/lib/agentApproval.ts. This builds
// the request, with the row count and a sample of the rows it changes. How it
// reaches the window depends on the host: the npm server writes it to a file
// the app watches (appApproval.ts), and the app shows it directly.

import {
    buildDiffQuery,
    REQUEST_VERSION,
    shapeDiff,
    type ApprovalAnswer,
    type ApprovalDiff,
    type ApprovalRequest,
} from '../../src/lib/agentApproval';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import { TTL_MS, type PendingApproval } from './approvals';
import type { Database } from './catalog';

/** The window's answer, or 'waiting' when nobody has answered within one call. */
export type AppAnswer = ApprovalAnswer | 'waiting';

export interface RequestContext {
    db: Database;
    config: { connectionId: string };
    /** The MCP host's own name for itself. */
    client?: string | null;
}

/** The rows a statement would change, read-only. A failure is shown, not thrown. */
async function sampleRows(db: Database, statement: StatementClassification): Promise<ApprovalDiff | null> {
    const query = buildDiffQuery(statement);
    if (!query) return null;
    try {
        return shapeDiff(query, await db.read(query.sql));
    } catch (error) {
        return {
            mode: query.mode,
            columns: [],
            rows: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function buildRequest(ctx: RequestContext, approval: PendingApproval): Promise<ApprovalRequest> {
    const { decision, estimates } = approval;
    const statements = [];
    for (const statement of decision.statements) {
        const estimate = estimates.find((e) => e.statement === statement);
        statements.push({
            sql: statement.sql,
            kind: statement.kind,
            verb: statement.verb,
            table: statement.table,
            unbounded: statement.unbounded,
            reason: statement.reason,
            affectedRows: estimate?.exactRows ?? null,
            estimatedRows: estimate?.estimatedRows ?? null,
            tableRows: estimate?.tableRows ?? null,
            tableRowsCapped: estimate?.tableRowsCapped ?? false,
            diff: statement.kind === 'read' ? null : await sampleRows(ctx.db, statement),
        });
    }
    return {
        version: REQUEST_VERSION,
        token: approval.token,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(approval.createdAt + TTL_MS).toISOString(),
        client: ctx.client ?? null,
        connection: ctx.config.connectionId,
        connectionId: ctx.config.connectionId,
        dialect: ctx.db.dialect,
        policy: decision.appliedPolicy,
        reason: decision.reason,
        destructive: decision.kind === 'destructive',
        requireTypedConfirmation: decision.requireTypedConfirmation,
        confirmPhrase: decision.worst?.table ?? decision.worst?.verb ?? 'RUN',
        statements,
    };
}
