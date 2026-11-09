// Agents' writes that may run in one call.
//
// Off unless the person at LiteDB turns it on for a connection (Settings →
// Agents), and never on a connection tagged production. With it on, a write
// whose size the preview can pin down — an INSERT of listed rows, an UPDATE
// or DELETE with a WHERE clause — runs as soon as `query` sees it, when it
// changes no more rows than the limit set there. Everything else still stops
// for approval: schema and permission changes, a write with no WHERE clause,
// DROP and TRUNCATE, an upsert, and anything whose row count cannot be
// measured.
//
// The limit is enforced twice. The preview counts the rows before anything
// runs, and the write itself runs in a transaction that is rolled back if it
// changes more (`writeAll`'s `maxChanges`). A count that was wrong, or rows
// that changed in between, cannot take a write past the limit.

import type { ImpactEstimate } from '../../src/lib/impactPreview';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import type { GateDecision } from '../../src/lib/sqlPolicy';
import { tokenize } from '../../src/lib/sqlTokenizer';

export interface DirectWrites {
    /** Rows one call may change without asking. */
    maxRows: number;
}

export type DirectVerdict = { run: true; rows: number } | { run: false; why: string };

/** The writes whose size can be known before they run. */
const COUNTABLE = new Set(['INSERT', 'UPDATE', 'DELETE']);

/**
 * Rows an `INSERT ... VALUES` adds: one per top-level tuple, and one for
 * `DEFAULT VALUES`. Null for an INSERT fed by a SELECT, whose size is not
 * written in the statement.
 */
export function insertedRows(sql: string): number | null {
    const tokens = tokenize(sql);
    const top = tokens.filter((t) => t.depth === 0);
    if (top.some((t) => t.kind === 'word' && t.value === 'SELECT')) return null;
    const at = top.findIndex((t) => t.kind === 'word' && t.value === 'VALUES');
    if (at === -1) return null;
    if (top[at - 1]?.kind === 'word' && top[at - 1].value === 'DEFAULT') return 1;
    let rows = 0;
    for (const token of top.slice(at + 1)) {
        if (token.kind === 'punct' && token.value === '(') rows += 1;
        else if (token.kind === 'punct' && (token.value === ')' || token.value === ',')) continue;
        else break;
    }
    return rows > 0 ? rows : null;
}

/**
 * An upsert or REPLACE can change rows it does not list: REPLACE deletes every
 * row it conflicts with, and ON CONFLICT DO UPDATE rewrites existing ones.
 */
function overwrites(sql: string): boolean {
    const top = tokenize(sql).filter((t) => t.depth === 0 && t.kind === 'word');
    if (top.some((t) => t.value === 'REPLACE')) return true;
    const conflict = top.findIndex((t, i) => t.value === 'ON' && top[i + 1]?.value === 'CONFLICT');
    return conflict !== -1 && top.slice(conflict).some((t, i, rest) => t.value === 'DO' && rest[i + 1]?.value === 'UPDATE');
}

function askingReason(statement: StatementClassification): string {
    if (statement.kind !== 'write') return statement.reason;
    return statement.verb === 'WITH' ? 'a write inside WITH always asks' : `${statement.verb} always asks`;
}

/** Whether a write the policy would hold for approval may run now instead, and why not. */
export function directVerdict(
    decision: GateDecision,
    estimates: ImpactEstimate[],
    limit: DirectWrites,
): DirectVerdict {
    let rows = 0;
    for (const statement of decision.statements) {
        if (statement.kind === 'read') continue;
        if (statement.kind !== 'write' || !COUNTABLE.has(statement.verb)) {
            return { run: false, why: askingReason(statement) };
        }
        if (overwrites(statement.sql)) {
            return { run: false, why: 'an upsert can change rows it does not list' };
        }
        const counted =
            statement.verb === 'INSERT'
                ? insertedRows(statement.sql)
                : (estimates.find((e) => e.statement === statement)?.exactRows ?? null);
        if (counted === null) {
            return { run: false, why: 'how many rows it changes could not be counted first' };
        }
        rows += counted;
    }
    if (rows > limit.maxRows) {
        return {
            run: false,
            why: `it changes ${rows} rows, more than the ${limit.maxRows} this connection allows without asking`,
        };
    }
    return { run: true, rows };
}
