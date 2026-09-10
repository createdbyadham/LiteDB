// Compiles generated SQL without running it, so the model can fix its own
// mistakes before a human ever sees them.
//
// The repair loop this feeds used to depend on *executing* the query and
// catching the engine's error. That only ever helped read-only queries — the
// guard refused to speculatively execute anything else — which meant the
// failure people actually hit went uncaught: the model writes an UPDATE, it
// lands in the editor, you click Execute, and *then* it turns out `orders` has
// no column called `customer_name`.
//
// Both engines can parse and name-resolve a statement without performing it.
// `EXPLAIN <statement>` compiles it and hands back the plan; nothing is
// inserted, updated or deleted. That gives a real check on writes:
//
//   * syntax errors
//   * unknown tables and columns
//   * arity and, in Postgres, most type errors
//
// The one rule that makes this safe: **never ANALYZE.** `EXPLAIN ANALYZE`
// executes the statement it claims to be explaining, so a "validator" that
// added it for richer output would delete the user's rows.
// `buildValidateQuery` is the only place these are constructed, and the
// self-test asserts what it emits.

import { classifyScript, type StatementClassification } from './sqlClassifier';
import type { SqlDialect } from './schemaTypes';

/** Executes a query and throws on engine error. Return value is ignored. */
export type ValidateRunner = (sql: string) => Promise<unknown>;

export interface ValidationFailure {
    statement: StatementClassification;
    /** The engine's own message, passed to the model verbatim. */
    error: string;
}

/**
 * Verbs Postgres accepts after EXPLAIN.
 *
 * An allowlist rather than a denylist, because Postgres rejects everything
 * else at the *grammar*, with a message indistinguishable from a real defect.
 * Measured against Postgres 16 rather than assumed:
 *
 *   EXPLAIN TRUNCATE orders     ->  syntax error at or near "TRUNCATE"
 *   EXPLAIN COPY orders TO ...  ->  syntax error at or near "COPY"
 *   EXPLAIN DROP TABLE orders   ->  syntax error at or near "DROP"
 *
 * There is no "cannot explain this" wording to key off. So a kind-based
 * denylist got this wrong in both directions: TRUNCATE classifies as
 * destructive and COPY as write, both of which it let through — meaning a
 * valid TRUNCATE was reported to the model as a syntax error and sent back to
 * be "fixed".
 */
const POSTGRES_EXPLAINABLE = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'WITH', 'TABLE',
    'EXECUTE', 'DECLARE',
]);

/**
 * Whether a statement can be compiled by EXPLAIN on this dialect.
 *
 * SQLite explains anything, including DDL, so everything is checked there.
 *
 * `unknown` statements are deliberately included on both dialects. The first
 * version excluded them, which silently skipped the most basic failure there
 * is: `SELEC * FROM orders` has no recognisable verb, so it classified as
 * unknown and sailed through unchecked. A verb the classifier cannot read is
 * far more likely to be a typo than a valid utility statement it has never
 * heard of — and when it is wrong, the cost is one wasted repair attempt, not
 * a wrong answer.
 */
export function canValidate(statement: StatementClassification, dialect: SqlDialect): boolean {
    if (!statement.sql.trim()) return false;
    // Already a plan request; wrapping it again explains the EXPLAIN.
    if (statement.verb === 'EXPLAIN') return false;
    if (dialect === 'sqlite') return true;
    return POSTGRES_EXPLAINABLE.has(statement.verb) || statement.kind === 'unknown';
}

/**
 * The compile-only form of a statement.
 *
 * Plain `EXPLAIN`, never `EXPLAIN ANALYZE`, and never the JSON variant — the
 * output is discarded, so the cheapest form that still compiles the statement
 * is the right one.
 */
export function buildValidateQuery(sql: string): string {
    return `EXPLAIN ${sql.trim().replace(/;\s*$/, '')}`;
}

/**
 * Compile every statement in a script. Returns the first failure, or null.
 *
 * Stops at the first failure because that is what gets fed back to the model:
 * a later error produced by a statement the first one may have invalidated is
 * noise, and one precise message repairs better than three vague ones.
 */
export async function validateScript(
    script: string,
    dialect: SqlDialect,
    run: ValidateRunner,
): Promise<ValidationFailure | null> {
    const { statements } = classifyScript(script);

    for (const statement of statements) {
        if (!canValidate(statement, dialect)) continue;
        try {
            await run(buildValidateQuery(statement.sql));
        } catch (error) {
            // No message-based escape hatch here, deliberately. An earlier
            // version skipped errors matching /cannot|not supported/, on the
            // assumption that Postgres says something like "cannot EXPLAIN this
            // statement". It does not — it reports `syntax error at or near
            // "TRUNCATE"`, which is exactly what a genuine defect looks like.
            // The pattern could never fire, and widening it to catch "syntax
            // error" would swallow the errors this exists to find. Knowing
            // which statements are explainable is `canValidate`'s job.
            return { statement, error: error instanceof Error ? error.message : String(error) };
        }
    }

    return null;
}
