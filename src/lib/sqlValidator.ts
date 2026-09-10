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
 * Whether a statement can be compiled by EXPLAIN on this dialect.
 *
 * SQLite explains anything, including DDL. Postgres refuses utility statements
 * — `EXPLAIN CREATE TABLE ...` is itself an error — so those are reported as
 * unvalidated rather than invalid. Calling a valid `CREATE TABLE` broken
 * because the checker cannot read it would send the model into a repair loop
 * fixing nothing.
 *
 * `unknown` statements are deliberately *included*. The first version excluded
 * them, which silently skipped the most basic failure there is: `SELEC * FROM
 * orders` has no recognisable verb, so it classified as unknown and sailed
 * through unchecked. Unknown is exactly where the classifier has no opinion
 * and the engine has a good one — ask the engine.
 */
export function canValidate(statement: StatementClassification, dialect: SqlDialect): boolean {
    if (!statement.sql.trim()) return false;
    // Already a plan request; wrapping it again explains the EXPLAIN.
    if (statement.verb === 'EXPLAIN') return false;
    if (dialect === 'sqlite') return true;
    // Postgres cannot explain utility statements. Everything else, including
    // what the classifier could not read, is worth asking about.
    return statement.kind !== 'ddl' && statement.kind !== 'session';
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
            const message = error instanceof Error ? error.message : String(error);
            // A refusal to explain is the checker's limitation, not the
            // statement's defect. Treating it as a defect would have the model
            // "fix" working SQL.
            if (/cannot|not supported|utility statement/i.test(message)) continue;
            return { statement, error: message };
        }
    }

    return null;
}
