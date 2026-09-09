// Read-only guard for model-generated SQL.
//
// The harness executes text produced by an LLM, so "the model would not do
// that" is not a security model. This is the first of two layers; the second
// is the engine itself (a read-only SQLite connection, a READ ONLY Postgres
// transaction) in fixture.ts. Either alone would be insufficient: the guard
// can be out-thought, and the engine layer alone would still let a model burn
// the run on a statement we never intended to execute.

export type GuardVerdict =
    | { ok: true; sql: string }
    | { ok: false; reason: string };

// Statement keywords that must not appear anywhere in a read-only query.
// The write verbs are checked across the whole statement rather than just the
// leading token because Postgres allows data-modifying CTEs, e.g.
//   WITH x AS (<write> FROM t RETURNING *) SELECT * FROM x
//
// Deliberately excluded: `replace`, a legitimate string function in both
// engines. It cannot lead a statement here anyway, since the leading token is
// constrained to SELECT or WITH.
const FORBIDDEN_KEYWORDS = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
    'grant', 'revoke', 'attach', 'detach', 'pragma', 'vacuum', 'reindex',
    'copy', 'call', 'merge', 'begin', 'commit', 'rollback', 'savepoint', 'set',
];

// Compiled once, and deliberately built with String.raw: writing the word
// boundary as a plain "\b" inside a template literal yields a backspace
// character instead, which silently matches nothing. The self-test asserts
// this scan actually fires.
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> =
    FORBIDDEN_KEYWORDS.map(
        (keyword) => [keyword, new RegExp(String.raw`\b${keyword}\b`, 'i')] as const,
    );

/**
 * Blank out comments and quoted spans so keyword matching cannot be defeated
 * by (or false-positive on) their contents. Literals collapse to empty quotes
 * rather than vanishing, which keeps statement structure intact.
 */
function stripNoise(sql: string): string {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/"(?:[^"]|"")*"/g, '""');
}

export function guardReadOnly(rawSql: string): GuardVerdict {
    const trimmed = rawSql.trim();
    if (!trimmed) return { ok: false, reason: 'empty statement' };

    const stripped = stripNoise(trimmed);

    const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
    if (statements.length === 0) {
        return { ok: false, reason: 'no executable statement' };
    }
    if (statements.length > 1) {
        return { ok: false, reason: `expected a single statement, found ${statements.length}` };
    }

    if (!/^\s*(with|select)\b/i.test(stripped)) {
        const lead = (stripped.trim().split(/\s+/)[0] ?? '').toLowerCase();
        return { ok: false, reason: `must start with SELECT or WITH (got "${lead}")` };
    }

    for (const [keyword, pattern] of FORBIDDEN_PATTERNS) {
        if (pattern.test(stripped)) {
            return { ok: false, reason: `forbidden keyword "${keyword}"` };
        }
    }

    return { ok: true, sql: trimmed.replace(/;\s*$/, '') };
}
