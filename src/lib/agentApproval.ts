// Approving an agent's write in the LiteDB window.
//
// The MCP server and the app are separate processes. While the app is open,
// `execute_approved` does not run on the agent's say-so: it writes a request
// into the app's data folder and waits. The app shows the statement, the exact
// row count and the rows it would change, and writes a decision back. Nothing
// runs until the person at the keyboard clicks Approve.
//
// This module is the shared half: the two file formats, and the queries that
// sample the rows a write touches. Free of Node, browser and Tauri imports, so
// the MCP server, the app and the self-tests run the same code.
//
// The honest limit: the folder is in the user's profile. An agent that can run
// shell commands as that user could write a decision file itself, or skip
// LiteDB and open the database directly. This stops an agent working through
// LiteDB's tools, including hosts that run them without asking; it is not a
// sandbox.

import type { SqlDialect } from './schemaTypes';
import type { StatementClassification } from './sqlClassifier';
import type { SafetyPolicy } from './sqlPolicy';
import { tokenize, type SqlToken } from './sqlTokenizer';

/** Under the app's local data folder, next to the handoff file. */
export const APPROVALS_DIR = 'approvals';
export const REQUEST_VERSION = 1;
/** Rows shown per statement: enough to recognise, few enough to read. */
export const DIFF_ROWS = 20;
const CELL_CHARS = 120;

export const requestFileName = (token: string): string => `${token}.json`;
export const decisionFileName = (token: string): string => `${token}.decision.json`;

/** The token a request file belongs to, or null for anything else in the folder. */
export function requestToken(fileName: string): string | null {
    if (!fileName.endsWith('.json') || fileName.endsWith('.decision.json')) return null;
    return fileName.slice(0, -'.json'.length) || null;
}

export type DiffMode = 'delete' | 'update' | 'insert' | 'truncate';

/** A sample of the rows a statement touches, as display text. */
export interface ApprovalDiff {
    mode: DiffMode;
    columns: string[];
    rows: string[][];
    /** UPDATE: each assigned column and its new value per row, aligned with `rows`. */
    changes?: { column: string; values: string[] }[];
    /** More rows match than are shown. */
    truncated: boolean;
    /** Why no rows could be shown. */
    error?: string;
}

export interface ApprovalStatement {
    sql: string;
    kind: string;
    verb: string;
    table: string | null;
    unbounded: boolean;
    reason: string;
    /** Exact rows affected, when they could be counted. */
    affectedRows: number | null;
    /** The planner's guess, when no exact count was possible. */
    estimatedRows: number | null;
    /** Rows in the table, for "12 of 4,210". */
    tableRows: number | null;
    /** `tableRows` is a lower bound from a bounded probe. */
    tableRowsCapped: boolean;
    diff: ApprovalDiff | null;
}

export interface ApprovalRequest {
    version: typeof REQUEST_VERSION;
    token: string;
    createdAt: string;
    /** When the token expires; the card goes with it. */
    expiresAt: string;
    /** The host's name for itself, e.g. claude-code. */
    client: string | null;
    connection: string;
    connectionId: string;
    dialect: SqlDialect;
    policy: SafetyPolicy;
    reason: string;
    destructive: boolean;
    /** Destroys data with no predicate: Approve waits for `confirmPhrase` to be typed. */
    requireTypedConfirmation: boolean;
    confirmPhrase: string;
    statements: ApprovalStatement[];
}

export type ApprovalAnswer = 'approved' | 'declined';

export interface ApprovalDecision {
    token: string;
    decision: ApprovalAnswer;
    at: string;
}

// --- file formats -------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === 'string';
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const POLICIES = new Set(['read-only', 'guarded', 'unrestricted', 'yolo']);

function parseDiff(value: unknown): ApprovalDiff | null {
    if (!value || typeof value !== 'object') return null;
    const d = value as Record<string, unknown>;
    if (d.mode !== 'delete' && d.mode !== 'update' && d.mode !== 'insert' && d.mode !== 'truncate') return null;
    const columns = Array.isArray(d.columns) ? d.columns.filter(isString) : [];
    const rows = Array.isArray(d.rows)
        ? d.rows.filter(Array.isArray).map((r) => (r as unknown[]).map((c) => (isString(c) ? c : String(c))))
        : [];
    const changes = Array.isArray(d.changes)
        ? d.changes
              .filter((c): c is { column: string; values: unknown[] } => !!c && isString(c.column) && Array.isArray(c.values))
              .map((c) => ({ column: c.column, values: c.values.map((v) => (isString(v) ? v : String(v))) }))
        : undefined;
    return {
        mode: d.mode,
        columns,
        rows,
        ...(changes ? { changes } : {}),
        truncated: d.truncated === true,
        ...(isString(d.error) ? { error: d.error } : {}),
    };
}

/** A request file, or null when it is not one this version understands. */
export function parseRequest(text: string): ApprovalRequest | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== REQUEST_VERSION) return null;
    if (!isString(r.token) || !isString(r.createdAt) || !isString(r.expiresAt)) return null;
    if (!isString(r.connection) || !isString(r.connectionId)) return null;
    if (r.dialect !== 'sqlite' && r.dialect !== 'postgres') return null;
    if (!Array.isArray(r.statements) || r.statements.length === 0) return null;
    const statements: ApprovalStatement[] = [];
    for (const value of r.statements) {
        if (!value || typeof value !== 'object') return null;
        const s = value as Record<string, unknown>;
        if (!isString(s.sql)) return null;
        statements.push({
            sql: s.sql,
            kind: isString(s.kind) ? s.kind : 'write',
            verb: isString(s.verb) ? s.verb : '',
            table: isString(s.table) ? s.table : null,
            unbounded: s.unbounded === true,
            reason: isString(s.reason) ? s.reason : '',
            affectedRows: numberOrNull(s.affectedRows),
            estimatedRows: numberOrNull(s.estimatedRows),
            tableRows: numberOrNull(s.tableRows),
            tableRowsCapped: s.tableRowsCapped === true,
            diff: parseDiff(s.diff),
        });
    }
    return {
        version: REQUEST_VERSION,
        token: r.token,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        client: isString(r.client) ? r.client : null,
        connection: r.connection,
        connectionId: r.connectionId,
        dialect: r.dialect,
        policy: (isString(r.policy) && POLICIES.has(r.policy) ? r.policy : 'guarded') as SafetyPolicy,
        reason: isString(r.reason) ? r.reason : '',
        destructive: r.destructive === true,
        requireTypedConfirmation: r.requireTypedConfirmation === true,
        confirmPhrase: isString(r.confirmPhrase) && r.confirmPhrase ? r.confirmPhrase : 'RUN',
        statements,
    };
}

export function serializeRequest(request: ApprovalRequest): string {
    return `${JSON.stringify(request, null, 2)}\n`;
}

/** A decision file for `token`, or null when it is malformed or for another token. */
export function parseDecision(text: string, token: string): ApprovalDecision | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    if (d.token !== token) return null;
    if (d.decision !== 'approved' && d.decision !== 'declined') return null;
    return { token, decision: d.decision, at: isString(d.at) ? d.at : new Date().toISOString() };
}

export function serializeDecision(decision: ApprovalDecision): string {
    return `${JSON.stringify(decision)}\n`;
}

// --- sampling the rows a write touches ------------------------------------------

/** A read that shows what a write would do, and how to read its result. */
export interface DiffQuery {
    mode: DiffMode;
    sql: string;
    /** UPDATE: the assigned columns; their new values come last in the result, in this order. */
    assigned?: string[];
    /** INSERT: the statement's own column list, when it names one. */
    insertColumns?: string[];
}

const isWord = (t: SqlToken | undefined, ...values: string[]): boolean =>
    !!t && t.kind === 'word' && t.depth === 0 && values.includes(t.value);
const isPunct = (t: SqlToken | undefined, value: string): boolean => !!t && t.kind === 'punct' && t.value === value;

/** Token ranges [from, to) between top-level commas in tokens[from, to). */
function splitOnCommas(tokens: SqlToken[], from: number, to: number, depth: number): [number, number][] {
    const parts: [number, number][] = [];
    let start = from;
    for (let i = from; i < to; i++) {
        if (tokens[i].depth === depth && isPunct(tokens[i], ',')) {
            parts.push([start, i]);
            start = i + 1;
        }
    }
    if (start < to) parts.push([start, to]);
    return parts;
}

/**
 * `UPDATE t [AS] a SET x = e, … WHERE p` becomes
 * `SELECT *, (e) AS __litedb_new_0, … FROM t [AS] a WHERE p`: every row it
 * would change, with each new value computed beside the old one.
 */
function updateQuery(statement: StatementClassification, take: number): DiffQuery | null {
    const { sql } = statement;
    const tokens = tokenize(sql);
    const setAt = tokens.findIndex((t) => isWord(t, 'SET'));
    if (setAt < 2) return null;
    let start = 1;
    if (isWord(tokens[start], 'OR')) start += 2; // SQLite: UPDATE OR REPLACE
    if (isWord(tokens[start], 'ONLY')) start += 1; // Postgres
    if (start >= setAt) return null;
    const target = sql.slice(tokens[start].start, tokens[setAt - 1].end);

    let end = tokens.length;
    for (let i = setAt + 1; i < tokens.length; i++) {
        if (isWord(tokens[i], 'FROM', 'WHERE', 'RETURNING', 'ORDER', 'LIMIT')) {
            end = i;
            break;
        }
    }
    // UPDATE … FROM joins another table, which the sample would have to repeat.
    if (isWord(tokens[end], 'FROM')) return null;

    const assigned: string[] = [];
    const values: string[] = [];
    for (const [from, to] of splitOnCommas(tokens, setAt + 1, end, 0)) {
        const name = tokens[from];
        // `x = e` only; a tuple, `(a, b) = (…)`, or `t.x = e` is left unsampled.
        if (!name || (name.kind !== 'word' && name.kind !== 'ident') || !isPunct(tokens[from + 1], '=') || from + 2 >= to) {
            return null;
        }
        assigned.push(name.kind === 'ident' ? name.value : sql.slice(name.start, name.end));
        values.push(sql.slice(tokens[from + 2].start, tokens[to - 1].end));
    }
    if (assigned.length === 0) return null;
    const computed = values.map((value, i) => `(${value}) AS __litedb_new_${i}`).join(', ');
    const where = statement.predicate ? ` WHERE ${statement.predicate}` : '';
    return { mode: 'update', sql: `SELECT *, ${computed} FROM ${target}${where} LIMIT ${take}`, assigned };
}

/** `INSERT INTO t (a, b) VALUES …` or `… SELECT …`: the rows it would add, from its source. */
function insertQuery(statement: StatementClassification, take: number): DiffQuery | null {
    const { sql } = statement;
    const tokens = tokenize(sql);
    const intoAt = tokens.findIndex((t) => isWord(t, 'INTO'));
    if (intoAt < 0) return null;
    let sourceAt = -1;
    let insertColumns: string[] | undefined;
    for (let i = intoAt + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.depth !== 0) continue;
        if (isWord(t, 'VALUES', 'SELECT', 'WITH')) {
            sourceAt = i;
            break;
        }
        if (isWord(t, 'DEFAULT')) return null; // DEFAULT VALUES: nothing to show
        if (isPunct(t, '(') && !insertColumns) {
            insertColumns = [];
            for (let j = i + 1; j < tokens.length && tokens[j].depth > 0; j++) {
                const c = tokens[j];
                if (c.depth === 1 && (c.kind === 'word' || c.kind === 'ident')) {
                    insertColumns.push(c.kind === 'ident' ? c.value : sql.slice(c.start, c.end));
                }
            }
        }
    }
    if (sourceAt < 0) return null;
    let end = tokens.length;
    for (let i = sourceAt + 1; i < tokens.length; i++) {
        if (isWord(tokens[i], 'RETURNING') || (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'CONFLICT'))) {
            end = i;
            break;
        }
    }
    const source = sql.slice(tokens[sourceAt].start, tokens[end - 1].end);
    return {
        mode: 'insert',
        sql: `SELECT * FROM (${source}) AS __litedb_source LIMIT ${take}`,
        ...(insertColumns && insertColumns.length ? { insertColumns } : {}),
    };
}

/**
 * A read that samples what `statement` would change, or null when it cannot
 * be shown that way (DDL, a write inside a CTE, UPDATE … FROM).
 *
 * It asks for one row more than is shown, so the card can say there are more.
 */
export function buildDiffQuery(statement: StatementClassification, limit = DIFF_ROWS): DiffQuery | null {
    const { table, verb, predicate } = statement;
    if (!table) return null;
    const take = limit + 1;
    switch (verb) {
        case 'DELETE':
            return { mode: 'delete', sql: `SELECT * FROM ${table}${predicate ? ` WHERE ${predicate}` : ''} LIMIT ${take}` };
        case 'TRUNCATE':
            return { mode: 'truncate', sql: `SELECT * FROM ${table} LIMIT ${take}` };
        case 'UPDATE':
            return updateQuery(statement, take);
        case 'INSERT':
        case 'REPLACE':
            return insertQuery(statement, take);
        default:
            return null;
    }
}

/** A cell as the card shows it. */
export function formatCell(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Uint8Array) return `[${value.length.toLocaleString('en-US')} bytes]`;
    let text: string;
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    } else text = String(value);
    return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS - 1)}…` : text;
}

/** The sample query's result, shaped for the card. */
export function shapeDiff(query: DiffQuery, result: { columns: string[]; rows: unknown[][] }, limit = DIFF_ROWS): ApprovalDiff {
    const truncated = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    if (query.mode === 'update' && query.assigned) {
        const base = result.columns.length - query.assigned.length;
        return {
            mode: 'update',
            columns: result.columns.slice(0, base),
            rows: rows.map((row) => row.slice(0, base).map(formatCell)),
            changes: query.assigned.map((column, i) => ({ column, values: rows.map((row) => formatCell(row[base + i])) })),
            truncated,
        };
    }
    const columns =
        query.insertColumns && query.insertColumns.length === result.columns.length ? query.insertColumns : result.columns;
    return { mode: query.mode, columns, rows: rows.map((row) => row.map(formatCell)), truncated };
}

/** Index of `column` in `columns`: exact first, then ignoring case (SQLite, and Postgres folding). */
export function columnIndex(columns: string[], column: string): number {
    const exact = columns.indexOf(column);
    if (exact >= 0) return exact;
    const lower = column.toLowerCase();
    return columns.findIndex((c) => c.toLowerCase() === lower);
}
