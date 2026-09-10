// Classifies a SQL statement by what it does to the database.
//
// This is the input to every decision the write-safety layer makes: whether a
// statement runs at all, whether it needs approval, what the approval dialog
// shows, and what the audit log records. It answers three questions the
// read-only guard in sqlGuard.ts cannot: what category the statement falls in,
// *why*, and what it targets.
//
// Three traps drive most of the code here. All of them fail open — they make a
// dangerous statement look safe — so each is handled explicitly:
//
//   1. `EXPLAIN ANALYZE DELETE FROM t` actually deletes. In Postgres, ANALYZE
//      executes the statement it is explaining. Treating every EXPLAIN as a
//      read is a data-loss bug.
//   2. `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` deletes, and
//      leads with WITH. Classifying on the leading keyword alone misses it.
//   3. `UPDATE t SET x = (SELECT y FROM z WHERE q)` has no WHERE of its own —
//      the only WHERE belongs to the subquery. It rewrites every row. A
//      substring search for "where" calls this bounded; it is not.
//
// Kept free of browser, Tauri and network imports so the eval harness can
// exercise it directly.

import { splitStatements, tokenize, type SqlToken } from './sqlTokenizer';

export type StatementKind =
    /** Returns rows, changes nothing. */
    | 'read'
    /** Changes rows, bounded by a predicate. */
    | 'write'
    /** Unbounded row change, or removal of a schema object. */
    | 'destructive'
    /** Creates or alters a schema object without destroying data. */
    | 'ddl'
    /** Changes engine or session state: transactions, SET, PRAGMA writes. */
    | 'session'
    /** Unrecognised. Gated as if destructive — see `effectiveKind`. */
    | 'unknown';

/**
 * Ordering used to reduce a multi-statement script to a single risk level, and
 * to compare a statement against a policy ceiling. Not a claim that DDL is
 * always safer than a write — it is the order in which the gate escalates.
 */
export const KIND_SEVERITY: Record<StatementKind, number> = {
    read: 0,
    session: 1,
    ddl: 2,
    write: 3,
    destructive: 4,
    unknown: 5,
};

/**
 * What a statement is gated *as*. An unrecognised statement is treated as
 * destructive rather than waved through: the classifier not recognising
 * something is precisely when it is least safe to assume it is harmless.
 */
export function effectiveKind(kind: StatementKind): Exclude<StatementKind, 'unknown'> {
    return kind === 'unknown' ? 'destructive' : kind;
}

export interface StatementClassification {
    /** The statement as written, trimmed, without its terminating semicolon. */
    sql: string;
    kind: StatementKind;
    /** Leading keyword, uppercased. Empty when the statement has no keyword. */
    verb: string;
    /** Write target, schema-qualified as written. Null when not identifiable. */
    table: string | null;
    /**
     * True for an UPDATE, DELETE or TRUNCATE with no predicate of its own —
     * the case the spec calls out for hard interception.
     */
    unbounded: boolean;
    /** The top-level WHERE predicate, verbatim. Feeds the row-count preview. */
    predicate: string | null;
    /** Plain-language justification, shown to the user in the approval dialog. */
    reason: string;
}

/** Verbs that can begin a statement, used to find the target of an EXPLAIN. */
const STATEMENT_VERBS = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'MERGE', 'CREATE', 'DROP',
    'ALTER', 'TRUNCATE', 'VALUES', 'TABLE', 'REPLACE', 'COPY', 'GRANT', 'REVOKE',
]);

/** Verbs that modify rows, wherever they appear — including inside a CTE. */
const MODIFYING_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);

/**
 * Words that end a WHERE predicate at the same nesting level. Everything
 * between WHERE and one of these is the predicate.
 */
const PREDICATE_TERMINATORS = new Set([
    'RETURNING', 'ORDER', 'LIMIT', 'GROUP', 'HAVING', 'WINDOW', 'FETCH', 'OFFSET',
]);

/** Noise between a verb and its target: DELETE FROM ONLY "public"."t". */
const TARGET_SKIP = new Set(['FROM', 'INTO', 'TABLE', 'ONLY', 'IF', 'EXISTS', 'NOT']);

/** Object keywords after DROP, used only to describe what is being removed. */
const DROP_OBJECTS = new Set([
    'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'TRIGGER', 'SEQUENCE',
    'FUNCTION', 'PROCEDURE', 'TYPE', 'EXTENSION', 'MATERIALIZED',
]);

/** Index of the first top-level `WHERE`, or -1. */
function topLevelWhereIndex(tokens: SqlToken[]): number {
    return tokens.findIndex((t) => t.kind === 'word' && t.value === 'WHERE' && t.depth === 0);
}

/** Text of the top-level WHERE predicate, or null when there is none. */
function extractPredicate(sql: string, tokens: SqlToken[]): string | null {
    const whereAt = topLevelWhereIndex(tokens);
    if (whereAt === -1) return null;

    const from = tokens[whereAt].end;
    for (let i = whereAt + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === 'word' && token.depth === 0 && PREDICATE_TERMINATORS.has(token.value)) {
            return sql.slice(from, token.start).trim() || null;
        }
    }
    return sql.slice(from).trim() || null;
}

/**
 * The identifier a verb acts on — the table for a write, the created object
 * for a CREATE. Joins `schema.table` back together.
 *
 * Sliced from the original text rather than read off `token.value`, because
 * the tokenizer uppercases bare words: reading `value` would turn a table
 * named `Orders` into `ORDERS`, which the row-count preview would then quote
 * into a name that does not exist.
 */
function extractTarget(sql: string, tokens: SqlToken[], verbIndex: number): string | null {
    let i = verbIndex + 1;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.kind === 'word' && (TARGET_SKIP.has(token.value) || DROP_OBJECTS.has(token.value))) {
            i++;
            continue;
        }
        if (token.kind !== 'word' && token.kind !== 'ident') return null;
        break;
    }
    if (i >= tokens.length) return null;

    const first = i;
    // schema.table — a dot immediately followed by another name part.
    while (
        tokens[i + 1]?.kind === 'punct' &&
        tokens[i + 1].value === '.' &&
        (tokens[i + 2]?.kind === 'word' || tokens[i + 2]?.kind === 'ident')
    ) {
        i += 2;
    }
    return sql.slice(tokens[first].start, tokens[i].end) || null;
}

/** Slice out the parenthesised group a token at `index` sits inside. */
function sliceEnclosingGroup(sql: string, tokens: SqlToken[], index: number): string {
    const depth = tokens[index].depth;
    for (let i = index + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === 'punct' && token.value === ')' && token.depth === depth - 1) {
            return sql.slice(tokens[index].start, token.start);
        }
    }
    return sql.slice(tokens[index].start);
}

/**
 * Classify a single statement.
 *
 * Re-tokenizes rather than reusing script-level token offsets, so offsets stay
 * local to `sql`. Scripts are short and this runs once per execution, not per
 * row.
 */
export function classifyStatement(sql: string, recursionDepth = 0): StatementClassification {
    const trimmed = sql.trim().replace(/;\s*$/, '').trim();
    const tokens = tokenize(trimmed);
    const base = { sql: trimmed, table: null, unbounded: false, predicate: null };

    if (!trimmed || tokens.length === 0) {
        return { ...base, kind: 'unknown', verb: '', reason: 'empty statement' };
    }

    // A statement whose first token is a quoted identifier, a literal or
    // punctuation has no verb to reason about, so it is unrecognised rather
    // than harmless.
    const verb = tokens[0].kind === 'word' ? tokens[0].value : '';
    if (!verb) {
        return {
            ...base,
            kind: 'unknown',
            verb: '',
            reason: 'statement does not begin with a SQL keyword',
        };
    }

    const predicate = extractPredicate(trimmed, tokens);
    const hasTopLevelWhere = topLevelWhereIndex(tokens) !== -1;

    switch (verb) {
        // `TABLE t` is the Postgres shorthand for `SELECT * FROM t`.
        case 'SELECT':
        case 'VALUES':
        case 'SHOW':
        case 'DESCRIBE':
        case 'DESC':
        case 'TABLE':
            return { ...base, kind: 'read', verb, predicate, reason: 'reads rows, changes nothing' };

        case 'EXPLAIN':
            return classifyExplain(trimmed, tokens, recursionDepth);

        case 'ANALYZE':
            // Bare ANALYZE collects planner statistics. It writes catalog data
            // but no user rows.
            return { ...base, kind: 'ddl', verb, reason: 'refreshes planner statistics' };

        case 'WITH':
            return classifyCte(trimmed, tokens, predicate, recursionDepth);

        case 'PRAGMA': {
            const assigns = tokens.some((t) => t.kind === 'punct' && t.value === '=');
            return assigns
                ? { ...base, kind: 'session', verb, reason: 'changes a SQLite engine setting' }
                : { ...base, kind: 'read', verb, reason: 'reads a SQLite engine setting' };
        }

        case 'INSERT':
        case 'REPLACE':
        case 'COPY':
        case 'MERGE': {
            const table = extractTarget(trimmed, tokens, 0);
            return {
                ...base,
                kind: 'write',
                verb,
                table,
                predicate,
                reason: `adds or replaces rows in ${table ?? 'a table'}`,
            };
        }

        case 'UPDATE':
        case 'DELETE': {
            const table = extractTarget(trimmed, tokens, 0);
            const target = table ?? 'the table';
            const action = verb === 'UPDATE' ? 'rewrites' : 'removes';
            if (!hasTopLevelWhere) {
                return {
                    ...base,
                    kind: 'destructive',
                    verb,
                    table,
                    unbounded: true,
                    reason: `${verb} with no WHERE clause — ${action} every row in ${target}`,
                };
            }
            return {
                ...base,
                kind: 'write',
                verb,
                table,
                predicate,
                reason: `${action} rows in ${target} matching the WHERE clause`,
            };
        }

        case 'TRUNCATE': {
            const table = extractTarget(trimmed, tokens, 0);
            return {
                ...base,
                kind: 'destructive',
                verb,
                table,
                unbounded: true,
                reason: `empties ${table ?? 'the table'} completely`,
            };
        }

        case 'DROP': {
            const object = tokens
                .find((t) => t.kind === 'word' && DROP_OBJECTS.has(t.value))
                ?.value.toLowerCase();
            const table = extractTarget(trimmed, tokens, 0);
            return {
                ...base,
                kind: 'destructive',
                verb,
                table,
                unbounded: true,
                reason: `permanently removes the ${object ?? 'object'} ${table ?? ''}`.trim(),
            };
        }

        case 'ALTER': {
            const table = extractTarget(trimmed, tokens, 0);
            // ALTER TABLE t DROP COLUMN c destroys that column's data; every
            // other ALTER adds, renames or re-types.
            const drops = tokens.some(
                (t) => t.kind === 'word' && t.depth === 0 && t.value === 'DROP',
            );
            return drops
                ? {
                      ...base,
                      kind: 'destructive',
                      verb,
                      table,
                      unbounded: true,
                      reason: `drops part of ${table ?? 'a table'}, destroying the data it holds`,
                  }
                : {
                      ...base,
                      kind: 'ddl',
                      verb,
                      table,
                      reason: `changes the structure of ${table ?? 'a table'}`,
                  };
        }

        case 'CREATE':
        case 'REINDEX':
        case 'COMMENT':
        case 'VACUUM':
        case 'GRANT':
        case 'REVOKE':
            return {
                ...base,
                kind: 'ddl',
                verb,
                table: extractTarget(trimmed, tokens, 0),
                reason: 'changes schema or permissions without removing rows',
            };

        case 'BEGIN':
        case 'START':
        case 'COMMIT':
        case 'END':
        case 'ROLLBACK':
        case 'SAVEPOINT':
        case 'RELEASE':
        case 'SET':
        case 'RESET':
        case 'DISCARD':
        case 'ATTACH':
        case 'DETACH':
            return {
                ...base,
                kind: 'session',
                verb,
                reason: 'changes transaction or session state',
            };

        default:
            return {
                ...base,
                kind: 'unknown',
                verb,
                reason: `unrecognised statement "${verb}" — gated as destructive`,
            };
    }
}

/**
 * `EXPLAIN` is a read — unless it is `EXPLAIN ANALYZE`, which runs the
 * statement for real and reports what happened. The ANALYZE check ignores
 * nesting depth on purpose, so the Postgres option-list form
 * `EXPLAIN (ANALYZE, BUFFERS) DELETE ...` is caught too.
 */
function classifyExplain(
    sql: string,
    tokens: SqlToken[],
    recursionDepth: number,
): StatementClassification {
    const base = { sql, table: null, unbounded: false, predicate: null };
    const planOnly: StatementClassification = {
        ...base,
        kind: 'read',
        verb: 'EXPLAIN',
        reason: 'shows the query plan without running it',
    };

    const executes = tokens.some((t) => t.kind === 'word' && t.value === 'ANALYZE');
    if (!executes || recursionDepth > 4) return planOnly;

    const innerAt = tokens.findIndex(
        (t) => t.kind === 'word' && t.depth === 0 && STATEMENT_VERBS.has(t.value),
    );
    if (innerAt === -1) return planOnly;

    const inner = classifyStatement(sql.slice(tokens[innerAt].start), recursionDepth + 1);
    return {
        ...inner,
        sql,
        verb: 'EXPLAIN',
        reason: `EXPLAIN ANALYZE runs the statement for real — ${inner.reason}`,
    };
}

/**
 * A CTE is a read unless one of its branches modifies rows. Postgres allows
 * `WITH x AS (DELETE ... RETURNING *) SELECT * FROM x`, which deletes while
 * leading with a harmless-looking keyword.
 *
 * The modifying branch is re-classified on its own so a bounded DELETE inside
 * a CTE is recognised as bounded, rather than being flagged unbounded because
 * its WHERE sits below the statement's top level.
 */
function classifyCte(
    sql: string,
    tokens: SqlToken[],
    predicate: string | null,
    recursionDepth: number,
): StatementClassification {
    const base = { sql, table: null, unbounded: false, predicate };

    if (recursionDepth > 4) {
        return { ...base, kind: 'unknown', verb: 'WITH', reason: 'CTE nested too deeply to classify' };
    }

    const modifyingAt = tokens.findIndex(
        (t) => t.kind === 'word' && t.depth > 0 && MODIFYING_VERBS.has(t.value),
    );
    if (modifyingAt === -1) {
        return { ...base, kind: 'read', verb: 'WITH', reason: 'reads rows, changes nothing' };
    }

    const branch = classifyStatement(
        sliceEnclosingGroup(sql, tokens, modifyingAt),
        recursionDepth + 1,
    );
    return {
        ...branch,
        sql,
        verb: 'WITH',
        reason: `data-modifying CTE — ${branch.reason}`,
    };
}

export interface ScriptClassification {
    statements: StatementClassification[];
    /** The most severe kind in the script, gated (so never 'unknown'). */
    kind: Exclude<StatementKind, 'unknown'>;
    /** The statement that set `kind`, for the approval dialog's headline. */
    worst: StatementClassification | null;
}

/** Classify every statement in a script and report the worst of them. */
export function classifyScript(script: string): ScriptClassification {
    const statements = splitStatements(script).map((s) => classifyStatement(s.sql));

    let worst: StatementClassification | null = null;
    for (const statement of statements) {
        if (worst === null || KIND_SEVERITY[statement.kind] > KIND_SEVERITY[worst.kind]) {
            worst = statement;
        }
    }

    return {
        statements,
        kind: worst ? effectiveKind(worst.kind) : 'read',
        worst,
    };
}
