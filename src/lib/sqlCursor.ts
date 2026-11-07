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
