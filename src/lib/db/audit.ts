// Changes made by hand in the grid, edits, inserts, deletes, imports, go in
// the audit log next to the editor's statements, so "every hand-made change"
// in the README is true of the table editor as well.

import { recordDecision } from '@/lib/queryGate';
import { policyFor } from '@/lib/queryGate';
import { classifyStatement } from '@/lib/sqlClassifier';
import type { OpenConnection } from './connections';

export function auditGridWrite(
    conn: OpenConnection,
    statements: string[],
    outcome: { ok: true; rows?: number } | { ok: false; error: string },
): void {
    if (statements.length === 0) return;
    void recordDecision({
        statements: statements.map((sql) => classifyStatement(sql)),
        decision: 'allowed',
        outcome: outcome.ok ? 'ok' : 'error',
        provenance: 'user',
        policy: policyFor(conn.id),
        error: outcome.ok ? null : outcome.error,
        actualRows: outcome.ok ? (outcome.rows ?? null) : null,
        connection: { label: conn.label, dialect: conn.dialect },
    });
}
