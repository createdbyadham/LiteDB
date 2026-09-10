// A small SQL tokenizer, shared by the statement classifier and the read-only
// guard.
//
// Everything the write-safety layer promises rests on reading SQL correctly.
// Splitting on a bare `;` is wrong the moment a semicolon appears inside a
// string literal, and matching keywords with a regex is wrong the moment a
// column is named "delete". Both mistakes fail open — the statement runs
// anyway, classified as something safer than it is — so they are worth the
// hundred lines it takes to avoid them.
//
// This is deliberately not a parser. It knows where strings, comments,
// identifiers and parentheses begin and end, and nothing about grammar. That
// is enough to split statements, find a leading verb, and tell a top-level
// WHERE from one buried in a subquery.
//
// Kept free of browser, Tauri and network imports so the eval harness can
// exercise it directly.

export type TokenKind =
    /** A bare keyword or unquoted identifier. Uppercased in `value`. */
    | 'word'
    /** A quoted identifier: "col", `col`, [col]. Never matched as a keyword. */
    | 'ident'
    /** A string literal, including Postgres dollar-quoted bodies. */
    | 'string'
    | 'number'
    | 'punct';

export interface SqlToken {
    /** Uppercased for `word`; the unquoted text for `ident`; raw otherwise. */
    value: string;
    kind: TokenKind;
    /**
     * Parenthesis nesting depth. `(` and `)` both report the depth *outside*
     * the group they delimit, so a token at depth 0 is genuinely top-level.
     */
    depth: number;
    start: number;
    end: number;
}

const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const WHITESPACE = /\s/;

/** Opening quote character -> closing quote character, for identifiers. */
const IDENT_QUOTES: Record<string, string> = { '"': '"', '`': '`', '[': ']' };

/**
 * Scan `sql` into tokens, discarding whitespace and comments.
 *
 * Unterminated strings and comments run to the end of the input rather than
 * throwing: this is fed model output and user keystrokes, and a half-typed
 * query must still classify as *something* so the gate can refuse it.
 */
export function tokenize(sql: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    const n = sql.length;
    let i = 0;
    let depth = 0;

    while (i < n) {
        const ch = sql[i];

        if (WHITESPACE.test(ch)) {
            i++;
            continue;
        }

        // -- line comment
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n') i++;
            continue;
        }

        // /* block comment */. Not nested: Postgres allows nesting, but a
        // nested comment mis-scanned here ends the comment early and produces
        // extra tokens, which can only make a statement look more dangerous
        // than it is. That is the safe direction to be wrong in.
        if (ch === '/' && sql[i + 1] === '*') {
            const close = sql.indexOf('*/', i + 2);
            i = close === -1 ? n : close + 2;
            continue;
        }

        // $tag$ dollar-quoted string $tag$ (Postgres). Checked before the
        // number and word branches because the tag may be empty ($$...$$).
        if (ch === '$') {
            const opener = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
            if (opener) {
                const tag = opener[0];
                const close = sql.indexOf(tag, i + tag.length);
                const end = close === -1 ? n : close + tag.length;
                tokens.push({ value: sql.slice(i, end), kind: 'string', depth, start: i, end });
                i = end;
                continue;
            }
        }

        // 'string literal', with '' as the escape.
        if (ch === "'") {
            const start = i;
            i++;
            while (i < n) {
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            tokens.push({ value: sql.slice(start, i), kind: 'string', depth, start, end: i });
            continue;
        }

        // Quoted identifier. Emitted as `ident`, never `word`, so a column
        // named "delete" cannot be mistaken for the statement verb.
        const closer = IDENT_QUOTES[ch];
        if (closer) {
            const start = i;
            i++;
            let inner = '';
            while (i < n) {
                if (sql[i] === closer) {
                    if (closer !== ']' && sql[i + 1] === closer) {
                        inner += closer;
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                inner += sql[i];
                i++;
            }
            tokens.push({ value: inner, kind: 'ident', depth, start, end: i });
            continue;
        }

        if (ch === '(') {
            tokens.push({ value: '(', kind: 'punct', depth, start: i, end: i + 1 });
            depth++;
            i++;
            continue;
        }

        if (ch === ')') {
            // Clamp at zero so unbalanced input cannot drive depth negative
            // and make a nested token look top-level.
            depth = Math.max(0, depth - 1);
            tokens.push({ value: ')', kind: 'punct', depth, start: i, end: i + 1 });
            i++;
            continue;
        }

        if (DIGIT.test(ch)) {
            const start = i;
            while (i < n && /[0-9.eE+-]/.test(sql[i])) {
                // Only consume a sign when it is part of an exponent.
                if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(sql[i - 1])) break;
                i++;
            }
            tokens.push({ value: sql.slice(start, i), kind: 'number', depth, start, end: i });
            continue;
        }

        if (WORD_START.test(ch)) {
            const start = i;
            while (i < n && WORD_CHAR.test(sql[i])) i++;
            tokens.push({
                value: sql.slice(start, i).toUpperCase(),
                kind: 'word',
                depth,
                start,
                end: i,
            });
            continue;
        }

        tokens.push({ value: ch, kind: 'punct', depth, start: i, end: i + 1 });
        i++;
    }

    return tokens;
}

export interface SplitStatement {
    /** Statement text as the user wrote it, trimmed, semicolon removed. */
    sql: string;
    /** Offset of `sql` within the original script, for error reporting. */
    start: number;
    tokens: SqlToken[];
}

/**
 * Split a script into statements on top-level semicolons.
 *
 * Replaces the naive `script.split(';')` the editor used, which split
 * `SELECT ';'` into two statements and would have handed the classifier
 * fragments to guess at.
 */
export function splitStatements(script: string): SplitStatement[] {
    const tokens = tokenize(script);
    const statements: SplitStatement[] = [];

    let current: SqlToken[] = [];

    const flush = (end: number): void => {
        if (current.length === 0) return;
        const from = current[0].start;
        const sql = script.slice(from, end).trim();
        if (sql) statements.push({ sql, start: from, tokens: current });
        current = [];
    };

    for (const token of tokens) {
        if (token.kind === 'punct' && token.value === ';' && token.depth === 0) {
            flush(token.start);
            continue;
        }
        current.push(token);
    }
    // A script ending in `;` leaves `current` empty, so this yields nothing —
    // a trailing semicolon must not produce a phantom statement.
    flush(script.length);

    return statements;
}
