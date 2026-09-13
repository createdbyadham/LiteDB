// The gate, as a protocol.
//
// In the desktop app the write-safety layer ends in a dialog. Here it ends in
// a tool result, and the shape of that result is the whole design:
//
//   * A read runs and returns rows.
//   * A write does not run. It returns what it *would* do — the statement, the
//     row count, the plan — and a single-use token.
//   * Running it is a second, separately named tool call: `execute_approved`.
//   * A statement the policy forbids gets neither, and says why.
//
// Why that is worth doing, when the model could just be handed a connection
// string: an MCP host asks its user before it calls a tool. Splitting a write
// into preview-then-execute means the call the user is asked to approve is the
// one that says `execute_approved`, attached to a result that already told
// them "4,812 rows in orders". Approving a write becomes a decision with the
// number in front of it, rather than a yes to `query({sql: "..."})`.
//
// The honest limit, because a safety feature that overclaims is worse than
// none: LiteDB cannot make the host ask. A user who allowlists
// `execute_approved` has turned the prompt off, and this server has no way to
// know or prevent that. What it can guarantee is narrower and still worth
// having — that the write was classified, that its impact was measured and
// reported before anything ran, that what runs is byte-for-byte what was
// previewed, and that all of it reaches the audit log either way.

import {
    previewStatement,
    type ImpactEstimate,
    type PreviewRunner,
} from '../../../src/lib/impactPreview';
import { ROW_PROBE_LIMIT } from '../../../src/lib/schemaSamples';
import type { StatementClassification } from '../../../src/lib/sqlClassifier';
import { evaluateScript, type GateDecision } from '../../../src/lib/sqlPolicy';
import * as approvals from '../approvals';
import { record } from '../audit';
import type { ServerConfig } from '../config';
import type { Database, QueryResult } from '../db';
import { formatCount, pluralRows, renderTable } from '../render';

export interface ToolContext {
    db: Database;
    config: ServerConfig;
}

export interface ToolResult {
    text: string;
    isError?: boolean;
}

/** A preview must never be able to change anything, so it reads. */
function previewRunner(db: Database): PreviewRunner {
    return async (sql: string) => (await db.read(sql)).rows;
}

function describeStatement(statement: StatementClassification, index: number): string {
    const parts: string[] = [statement.kind];
    if (statement.table) parts.push(`table: ${statement.table}`);
    if (statement.unbounded) parts.push('unbounded (no WHERE clause)');
    return `  ${index + 1}. ${statement.sql}\n     ${parts.join(' · ')} — ${statement.reason}`;
}

function describeImpact(estimate: ImpactEstimate): string {
    const lines: string[] = [];

    if (estimate.exactRows !== null) {
        let total = '';
        if (estimate.tableRows !== null) {
            const where = estimate.statement.table ? ` in ${estimate.statement.table}` : '';
            total = estimate.tableRowsCapped
                ? ` of at least ${formatCount(ROW_PROBE_LIMIT - 1)}${where}`
                : ` of ${formatCount(estimate.tableRows)}${where}`;
        }
        const everyRow =
            estimate.tableRows !== null &&
            !estimate.tableRowsCapped &&
            estimate.exactRows === estimate.tableRows &&
            estimate.exactRows > 0;
        lines.push(
            `     affects: ${pluralRows(estimate.exactRows)}${total}` +
                (everyRow ? '  <- every row in the table' : ''),
        );
    } else if (estimate.estimatedRows !== null) {
        // Labelled as the planner's guess, not measured. The difference
        // matters to whoever is deciding whether to say yes.
        lines.push(
            `     affects: ~${formatCount(estimate.estimatedRows)} rows (planner estimate)`,
        );
    } else {
        lines.push('     affects: could not be determined');
    }

    if (estimate.error) lines.push(`     preview problem: ${estimate.error}`);
    if (estimate.plan) {
        const plan = estimate.plan.split('\n').slice(0, 6).join('\n       ');
        lines.push(`     plan: ${plan}`);
    }
    return lines.join('\n');
}

function footer(decision: GateDecision): string {
    return `Policy in force: ${decision.appliedPolicy} · assessed as: ${decision.kind}`;
}

/** Execute one statement at a time, so a failure names the statement. */
async function readStatements(
    db: Database,
    statements: StatementClassification[],
): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    for (const statement of statements) {
        results.push(await db.read(statement.sql));
    }
    return results;
}

/**
 * Run approved statements — all of them, or none.
 *
 * A script is approved as a unit. Letting the first `UPDATE` commit and the
 * second fail would leave the database in a state nobody agreed to, and the
 * caller reading "Execution failed" would reasonably conclude nothing
 * happened. So more than one statement runs inside a transaction.
 *
 * A single statement is left alone deliberately. It is already atomic, and
 * wrapping it would break the handful of statements that cannot run inside a
 * transaction at all — `VACUUM`, `CREATE INDEX CONCURRENTLY` — for no gain.
 */
async function runApprovedStatements(
    db: Database,
    statements: StatementClassification[],
): Promise<QueryResult[]> {
    if (statements.length <= 1) {
        return statements.length === 0 ? [] : [await db.write(statements[0].sql)];
    }

    await db.write('BEGIN');
    try {
        const results: QueryResult[] = [];
        for (const statement of statements) {
            results.push(await db.write(statement.sql));
        }
        await db.write('COMMIT');
        return results;
    } catch (error) {
        try {
            await db.write('ROLLBACK');
        } catch {
            // Postgres has already aborted the transaction, or BEGIN itself
            // failed. Either way the original error is the one worth raising.
        }
        throw error;
    }
}

function renderResults(
    statements: StatementClassification[],
    results: QueryResult[],
    maxRows: number,
): string {
    return results
        .map((result, i) => {
            const prefix = results.length > 1 ? `Statement ${i + 1}: ${statements[i].sql}\n` : '';
            if (result.columns.length === 0) {
                return `${prefix}${pluralRows(result.rowsAffected)} changed.`;
            }
            return `${prefix}${pluralRows(result.rows.length)} returned.\n\n${renderTable(
                result.columns,
                result.rows,
                { maxRows },
            )}`;
        })
        .join('\n\n');
}

/** Total of the per-statement estimates, or null when none could be made. */
function totalEstimate(estimates: ImpactEstimate[]): number | null {
    return estimates.reduce<number | null>((total, e) => {
        const rows = e.exactRows ?? e.estimatedRows;
        return rows === null ? total : (total ?? 0) + rows;
    }, null);
}

export async function runQuery(ctx: ToolContext, sql: string): Promise<ToolResult> {
    // Provenance is always 'ai'. That is not a default — it is what MCP means,
    // and it is what holds generated SQL to the policy floor no matter how
    // permissively the server was started.
    const decision = evaluateScript(sql, ctx.config.policy, 'ai');

    if (decision.action === 'block') {
        await record({
            statements: decision.statements,
            decision: 'blocked',
            outcome: 'not-run',
            error: decision.reason,
        });
        return {
            text: ['REFUSED — nothing ran.', '', decision.reason, '', footer(decision)].join('\n'),
            isError: true,
        };
    }

    if (decision.action === 'allow') {
        // Only reads reach here: `unrestricted` is floored to `guarded` for
        // generated SQL and `yolo` is rejected at startup, so "a write ran
        // without a preview" is not a path this server has.
        const started = Date.now();
        try {
            const results = await readStatements(ctx.db, decision.statements);
            await record({
                statements: decision.statements,
                decision: 'allowed',
                outcome: 'ok',
                durationMs: Date.now() - started,
                actualRows: results.reduce((sum, r) => sum + r.rows.length, 0),
            });
            return { text: renderResults(decision.statements, results, ctx.config.maxRows) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await record({
                statements: decision.statements,
                decision: 'allowed',
                outcome: 'error',
                error: message,
                durationMs: Date.now() - started,
            });
            return { text: `Query failed: ${message}`, isError: true };
        }
    }

    // confirm — measure the impact, hand back a token, run nothing.
    const runner = previewRunner(ctx.db);
    const estimates: ImpactEstimate[] = [];
    for (const statement of decision.statements) {
        if (statement.kind === 'read') continue;
        estimates.push(await previewStatement(statement, ctx.db.dialect, runner));
    }

    const approval = approvals.create(
        sql,
        decision,
        estimates,
        ctx.config.connectionId,
        ctx.config.target,
    );

    // Logged now, before anything is approved. A write the agent proposed and
    // never came back for is worth being able to see.
    await record({
        statements: decision.statements,
        decision: 'pending',
        outcome: 'not-run',
        estimatedRows: totalEstimate(estimates),
    });

    const body = decision.statements.map((statement, i) => {
        const estimate = estimates.find((e) => e.statement === statement);
        return estimate
            ? `${describeStatement(statement, i)}\n${describeImpact(estimate)}`
            : describeStatement(statement, i);
    });

    const typedWarning = decision.requireTypedConfirmation
        ? '\nThis destroys data with no predicate bounding it. Check the row count ' +
          'above with the person you are working for before calling execute_approved.'
        : '';

    return {
        text: [
            'APPROVAL REQUIRED — nothing has run.',
            '',
            decision.reason,
            '',
            ...body,
            '',
            footer(decision),
            '',
            'To run exactly the statements above, call execute_approved with:',
            `  token: ${approval.token}`,
            '',
            `The token is single-use and expires in ${approvals.TTL_MS / 60000} minutes. ` +
                'The SQL is held server-side, so execute_approved takes no SQL argument and ' +
                'nothing can be substituted for what was previewed.' +
                typedWarning,
        ].join('\n'),
    };
}

export async function runApproved(ctx: ToolContext, token: string): Promise<ToolResult> {
    let approval: approvals.PendingApproval;
    try {
        approval = approvals.claim(token, ctx.config.connectionId, ctx.config.target);
    } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
    }

    const { decision, estimates } = approval;
    const estimated = totalEstimate(estimates);
    const started = Date.now();

    try {
        const results = await runApprovedStatements(ctx.db, decision.statements);
        const actualRows = results.reduce((sum, r) => sum + r.rowsAffected, 0);
        try {
            await ctx.db.flushWrites();
        } catch (error) {
            // The write is committed. Failing the call now would report a
            // change that happened as one that did not, so log it instead: the
            // app may not notice this write until the file is reopened.
            console.error('Could not checkpoint after an approved write:', error);
        }

        await record({
            statements: decision.statements,
            decision: 'approved',
            outcome: 'ok',
            durationMs: Date.now() - started,
            estimatedRows: estimated,
            actualRows,
        });

        // Saying so when the two disagree is the point of keeping both. A log
        // holding only the estimate cannot tell you the preview was wrong.
        const surprise =
            estimated !== null && actualRows !== estimated
                ? `\n\nNote: the preview said ${pluralRows(estimated)} and the database ` +
                  `reported ${pluralRows(actualRows)}. Either the data changed between ` +
                  "the preview and now, or the number shown was the planner's estimate " +
                  'rather than an exact count.'
                : '';

        return {
            text:
                `Executed.\n\n${renderResults(decision.statements, results, ctx.config.maxRows)}` +
                surprise,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await record({
            statements: decision.statements,
            decision: 'approved',
            outcome: 'error',
            error: message,
            estimatedRows: estimated,
            durationMs: Date.now() - started,
        });
        return { text: `Execution failed: ${message}`, isError: true };
    }
}
