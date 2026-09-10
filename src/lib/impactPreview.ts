// Estimates what a statement will do, before it does it.
//
// The approval dialog asks the user to authorise a write. "Are you sure?" is
// not a question anyone can answer well; "this deletes 4,812 of 4,900 rows in
// orders" is. Two sources feed that number:
//
//   1. An exact count, for a bounded UPDATE or DELETE. The predicate limiting
//      the write is the same predicate that counts what it will hit, so
//      `DELETE FROM t WHERE p` becomes `SELECT COUNT(*) FROM t WHERE p`. This
//      is exact, not an estimate, and it is the common case.
//   2. The planner's estimate, for everything else, via EXPLAIN.
//
// The safety rule that governs this whole file: **nothing here may change the
// database.** Every query it builds is passed through the read-only guard
// before it runs, and the EXPLAIN it issues is never EXPLAIN ANALYZE — which
// in Postgres executes the statement it claims to be explaining.

import type { StatementClassification } from './sqlClassifier';
import { canPreviewExactly } from './sqlPolicy';
import { guardReadOnly } from './sqlGuard';
import type { SqlDialect } from './schemaTypes';

/** Rows come back as arrays from SQLite and as objects from Postgres. */
export type PreviewRunner = (
    sql: string,
) => Promise<unknown[][] | Record<string, unknown>[] | null>;

export interface ImpactEstimate {
    statement: StatementClassification;
    /** Exact affected-row count, when the predicate allows one. */
    exactRows: number | null;
    /** Planner estimate, when EXPLAIN provided one. */
    estimatedRows: number | null;
    /** Total rows in the target table, so a count reads as a proportion. */
    tableRows: number | null;
    /** Plan text for the dialog's detail view. */
    plan: string | null;
    /** Why no preview is available. Null when one is. */
    error: string | null;
}

/**
 * `SELECT COUNT(*) FROM <table> WHERE <predicate>`, or null when the statement
 * is not the shape that allows an exact count.
 *
 * The table name and predicate are spliced back in as the caller wrote them.
 * That is safe from statement injection for a structural reason, not a
 * hopeful one: both were extracted from a single statement produced by
 * `splitStatements`, which had already split on every top-level semicolon, so
 * neither fragment can contain one. `guardReadOnly` then re-checks the result
 * before it is allowed to run.
 */
export function buildCountQuery(statement: StatementClassification): string | null {
    if (!canPreviewExactly(statement)) return null;
    return `SELECT COUNT(*) FROM ${statement.table} WHERE ${statement.predicate}`;
}

/** `SELECT COUNT(*) FROM <table>`, for the denominator. */
export function buildTableCountQuery(statement: StatementClassification): string | null {
    if (!statement.table) return null;
    return `SELECT COUNT(*) FROM ${statement.table}`;
}

/**
 * The EXPLAIN form for a dialect.
 *
 * Never ANALYZE. In Postgres `EXPLAIN ANALYZE DELETE ...` really deletes, so
 * the one thing this must not do is add it for better numbers.
 */
export function buildExplainQuery(sql: string, dialect: SqlDialect): string {
    return dialect === 'postgres'
        ? `EXPLAIN (FORMAT JSON) ${sql}`
        : `EXPLAIN QUERY PLAN ${sql}`;
}

/** First cell of the first row, whichever row shape the driver returned. */
function firstCell(rows: unknown[][] | Record<string, unknown>[] | null): unknown {
    if (!rows || rows.length === 0) return undefined;
    const row = rows[0];
    if (Array.isArray(row)) return row[0];
    if (row && typeof row === 'object') return Object.values(row)[0];
    return undefined;
}

/** Coerce a driver's count to a number. Postgres returns bigints as strings. */
function toCount(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

interface PlanNode {
    'Node Type'?: unknown;
    'Plan Rows'?: unknown;
    Plans?: unknown;
    'Relation Name'?: unknown;
    Plan?: unknown;
}

function isPlanNode(value: unknown): value is PlanNode {
    return typeof value === 'object' && value !== null;
}

/**
 * Pull the row estimate and a readable summary out of a Postgres JSON plan.
 *
 * The top node of a write plan is a ModifyTable (`Delete on orders`), whose
 * own `Plan Rows` is 0 — the rows it *returns*, not the rows it changes. The
 * estimate that matters is on the child that feeds it.
 */
function readPostgresPlan(raw: unknown): { rows: number | null; text: string | null } {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { rows: null, text: raw };
        }
    }

    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isPlanNode(root)) return { rows: null, text: null };

    const plan = isPlanNode(root.Plan) ? root.Plan : root;
    const lines: string[] = [];
    let best: number | null = null;

    const walk = (node: unknown, depth: number): void => {
        if (!isPlanNode(node)) return;
        const type = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Node';
        const relation =
            typeof node['Relation Name'] === 'string' ? ` on ${node['Relation Name']}` : '';
        const rows = toCount(node['Plan Rows']);
        lines.push(
            `${'  '.repeat(depth)}${type}${relation}${rows === null ? '' : ` (rows=${rows})`}`,
        );
        // A ModifyTable's own estimate is the rows it returns, which is zero
        // without RETURNING. Its child carries the count that matters.
        if (rows !== null && depth > 0 && best === null) best = rows;
        const children = node.Plans;
        if (Array.isArray(children)) for (const child of children) walk(child, depth + 1);
    };
    walk(plan, 0);

    if (best === null) best = toCount(plan['Plan Rows']);
    return { rows: best, text: lines.join('\n') || null };
}

/** Join SQLite's `EXPLAIN QUERY PLAN` rows into readable plan text. */
function readSqlitePlan(rows: unknown[][] | Record<string, unknown>[] | null): string | null {
    if (!rows || rows.length === 0) return null;
    const lines = rows.map((row) => {
        if (Array.isArray(row)) return String(row[row.length - 1] ?? '');
        if (row && typeof row === 'object') {
            const detail = (row as Record<string, unknown>).detail;
            return String(detail ?? Object.values(row).pop() ?? '');
        }
        return '';
    });
    return lines.filter(Boolean).join('\n') || null;
}

/**
 * Preview one statement.
 *
 * Every failure is caught and reported as `error` rather than thrown. A
 * preview that cannot be produced must not block the approval dialog from
 * opening — the user still needs to decide, with less information — and it
 * must never be mistaken for "this affects nothing".
 */
export async function previewStatement(
    statement: StatementClassification,
    dialect: SqlDialect,
    run: PreviewRunner,
): Promise<ImpactEstimate> {
    const estimate: ImpactEstimate = {
        statement,
        exactRows: null,
        estimatedRows: null,
        tableRows: null,
        plan: null,
        error: null,
    };

    const safeRun = async (
        sql: string,
    ): Promise<unknown[][] | Record<string, unknown>[] | null> => {
        const verdict = guardReadOnly(sql);
        // Refusing our own generated query means the statement was shaped in a
        // way this file did not anticipate. Reporting that is correct; running
        // it anyway is not.
        if (!verdict.ok) throw new Error(`preview query rejected by guard: ${verdict.reason}`);
        return run(verdict.sql);
    };

    try {
        const countSql = buildCountQuery(statement);
        if (countSql) estimate.exactRows = toCount(firstCell(await safeRun(countSql)));

        const tableSql = buildTableCountQuery(statement);
        if (tableSql && (countSql || statement.unbounded)) {
            estimate.tableRows = toCount(firstCell(await safeRun(tableSql)));
        }
    } catch (error) {
        estimate.error = error instanceof Error ? error.message : String(error);
    }

    // An unbounded statement hits everything, so the table count *is* the
    // impact. Stating that outright beats leaving the field blank.
    if (statement.unbounded && estimate.exactRows === null && estimate.tableRows !== null) {
        estimate.exactRows = estimate.tableRows;
    }

    try {
        const explainSql = buildExplainQuery(statement.sql, dialect);
        // EXPLAIN of a write reads as a write verb to the guard, so this call
        // deliberately bypasses `safeRun`. It is safe for a narrower reason:
        // buildExplainQuery never emits ANALYZE, and without ANALYZE neither
        // engine executes the statement being explained.
        const rows = await run(explainSql);
        if (dialect === 'postgres') {
            const { rows: planRows, text } = readPostgresPlan(firstCell(rows));
            estimate.estimatedRows = planRows;
            estimate.plan = text;
        } else {
            estimate.plan = readSqlitePlan(rows);
        }
    } catch (error) {
        // A failed EXPLAIN is not fatal — an exact count may already be in
        // hand — so it only becomes `error` when nothing else was learned.
        if (estimate.exactRows === null && estimate.error === null) {
            estimate.error = error instanceof Error ? error.message : String(error);
        }
    }

    return estimate;
}

/**
 * Preview every statement that changes something. Reads are skipped: they have
 * no impact to approve, and previewing them would double the work of running
 * them.
 */
export async function previewImpact(
    statements: StatementClassification[],
    dialect: SqlDialect,
    run: PreviewRunner,
): Promise<ImpactEstimate[]> {
    const previews: ImpactEstimate[] = [];
    for (const statement of statements) {
        if (statement.kind === 'read') continue;
        previews.push(await previewStatement(statement, dialect, run));
    }
    return previews;
}
