// Which statement the cursor is in, for "run the statement under the cursor".
//
// Built on the same splitter the safety layer uses, so a `;` inside a string
// or a comment does not end a statement here either.
//
// Free of browser and Tauri imports so the self-test can run it.

import { splitStatements } from './sqlTokenizer';

export interface StatementRange {
    /** Offset of the statement's first character in the script. */
    from: number;
    /** Offset just past its last character, before any `;`. */
    to: number;
    sql: string;
}

export function statementRanges(script: string): StatementRange[] {
    return splitStatements(script).map((s) => ({ from: s.start, to: s.start + s.sql.length, sql: s.sql }));
}

/**
 * The statement containing `offset`, or the one just before it when the
 * cursor sits after a `;` or in the blank lines between statements.
 */
export function statementAt(script: string, offset: number): StatementRange | null {
    const ranges = statementRanges(script);
    if (ranges.length === 0) return null;
    let previous: StatementRange | null = null;
    for (const range of ranges) {
        // `to + 1` keeps the statement when the cursor is right after its `;`.
        if (offset >= range.from && offset <= range.to + 1) return range;
        if (range.from <= offset) previous = range;
    }
    return previous ?? ranges[0];
}

/** Replace `from`..`to` with `insert`; the placed SQL then starts at `start`. */
export interface Placement {
    from: number;
    to: number;
    insert: string;
    start: number;
}

/**
 * Where Text to SQL puts what it wrote. An empty script takes it whole.
 * Otherwise it goes in after the statement containing `offset`, past that
 * statement's `;`, as a statement of its own: nothing already there is split
 * or replaced, and a `;` is added wherever two statements would run together.
 */
export function placeAfterStatement(script: string, offset: number, sql: string): Placement {
    if (!script.trim()) return { from: 0, to: script.length, insert: sql, start: 0 };
    const current = statementAt(script, offset);
    let at = current ? current.to : script.length;
    let probe = at;
    while (probe < script.length && /\s/.test(script[probe])) probe++;
    if (script[probe] === ';') at = probe + 1;
    const lead = script.slice(0, at).trimEnd().endsWith(';') ? '' : ';';
    const tail = script.slice(at).trim() && !sql.trimEnd().endsWith(';') ? ';' : '';
    return { from: at, to: at, insert: `${lead}\n\n${sql}${tail}`, start: at + lead.length + 2 };
}
