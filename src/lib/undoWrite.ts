// Undo for an agent's write.
//
// Before an approved UPDATE or DELETE runs, litedb-mcp saves the rows it is
// about to touch, keyed by primary key (or SQLite's rowid), next to the audit
// log; for an UPDATE it also saves the values it is about to write. For a
// SQLite INSERT it notes the rowids the new rows get. The audit entry links to
// the file, and Undo in the Audit panel puts the rows back.
//
// Undo restores only what is still as the write left it. A deleted row whose
// key has been reused, or an updated row someone has changed again, is left
// alone and counted, so undo never overwrites newer work. Cascades and
// triggers are not undone: only the rows of the table the statement named.
//
// Free of Node, browser and Tauri imports: the server, the app and the
// self-test share it.

import type { SqlDialect } from './schemaTypes';
import { sqlLiteral } from './db/sqlLiteral';
import { quoteIdent } from './types';

export const UNDO_VERSION = 1;
/** Next to the audit log: `<audit folder>/undo/<id>.json`. */
export const UNDO_FOLDER = 'undo';
/** Above this, a write is not saved for undo: the file would be a database of its own. */
export const UNDO_MAX_ROWS = 5000;
/** Keys per check, and rows per restoring INSERT. */
const CHUNK = 200;

export type Encoded = null | number | string | boolean | { $blob: string } | { $bigint: string };

export interface UndoRecord {
    version: typeof UNDO_VERSION;
    id: string;
    kind: 'delete' | 'update' | 'insert';
    /** As the statement wrote it, so it can be used in SQL again. */
    table: string;
    dialect: SqlDialect;
    connectionId: string;
    /** The statement that ran. */
    sql: string;
    /** Key columns; `rowid` for a SQLite table without a primary key. */
    key: string[];
    /** The saved rows' columns, in order. */
    columns: string[];
    rows: Encoded[][];
    /** UPDATE: the columns it set, and per row the values it was about to write. */
    assigned?: string[];
    after?: Encoded[][];
    /** SQLite INSERT: the new rows' rowids are greater than `after` and at most `upTo`. */
    rowids?: { after: number; upTo: number };
    capturedAt: string;
    /** Set by the app once undone, so it cannot be undone twice. */
    undoneAt?: string;
}

// --- values -------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** A value as the file stores it, or undefined when it cannot be put back faithfully (arrays). */
export function encodeValue(value: unknown): Encoded | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (value instanceof Uint8Array) return { $blob: toBase64(value) };
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return undefined;
    if (typeof value === 'object') return JSON.stringify(value);
    return undefined;
}

export function decodeValue(value: Encoded): unknown {
    if (value === null || typeof value !== 'object') return value;
    if ('$blob' in value) return fromBase64(value.$blob);
    if ('$bigint' in value) return BigInt(value.$bigint);
    return null;
}

/** Equal as data: 12.5 and "12.50" are the same number, whichever driver read them. */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    const num = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? Number(v) : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const na = num(a);
    const nb = num(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
    if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b) || String(a) === String(b);
    return String(a) === String(b);
}

// --- file format ----------------------------------------------------------------

export function serializeUndo(record: UndoRecord): string {
    return `${JSON.stringify(record)}\n`;
}

export function parseUndo(text: string): UndoRecord | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== UNDO_VERSION || typeof r.id !== 'string' || typeof r.table !== 'string') return null;
    if (r.kind !== 'delete' && r.kind !== 'update' && r.kind !== 'insert') return null;
    if (r.dialect !== 'sqlite' && r.dialect !== 'postgres') return null;
    if (!Array.isArray(r.key) || !Array.isArray(r.columns) || !Array.isArray(r.rows)) return null;
    return raw as UndoRecord;
}

// --- planning -------------------------------------------------------------------

const ident = (name: string) => (name === 'rowid' ? 'rowid' : quoteIdent(name, 'column'));

/** Where the saved rows' keys are in `columns`. */
function keyIndexes(record: UndoRecord): number[] {
    return record.key.map((k) => record.columns.indexOf(k));
}

/** `k IN (…)`, or `(k1, k2) IN (VALUES (…), …)` for a composite key. */
function keyFilter(record: UndoRecord, keys: unknown[][]): string {
    const lit = (v: unknown) => sqlLiteral(v, record.dialect);
    if (record.key.length === 1) {
        return `${ident(record.key[0])} IN (${keys.map((k) => lit(k[0])).join(', ')})`;
    }
    const tuples = keys.map((k) => `(${k.map(lit).join(', ')})`).join(', ');
    return `(${record.key.map(ident).join(', ')}) IN (VALUES ${tuples})`;
}

/**
 * Reads that say what is there now: the saved rows' keys, and for an UPDATE
 * the columns it set. Their results go to `planUndo`.
 */
export function currentStateQueries(record: UndoRecord): string[] {
    if (record.kind === 'insert' || record.rows.length === 0) return [];
    const at = keyIndexes(record);
    if (at.some((i) => i < 0)) return [];
    const select = [...record.key, ...(record.kind === 'update' ? (record.assigned ?? []) : [])].map(ident).join(', ');
    const queries: string[] = [];
    for (let i = 0; i < record.rows.length; i += CHUNK) {
        const keys = record.rows.slice(i, i + CHUNK).map((row) => at.map((k) => decodeValue(row[k])));
        queries.push(`SELECT ${select} FROM ${record.table} WHERE ${keyFilter(record, keys)}`);
    }
    return queries;
}

export interface UndoPlan {
    statements: string[];
    /** Rows that will be put back (an estimate for INSERT). */
    restore: number;
    /** Rows left alone because they changed after the write. */
    skipped: number;
}

const keyText = (values: unknown[]) => JSON.stringify(values.map((v) => (v instanceof Uint8Array ? Array.from(v) : typeof v === 'bigint' ? v.toString() : v)));

/**
 * The writes that undo `record`, given what `currentStateQueries` found.
 * `current` holds their rows, all chunks together: key columns first, then
 * for an UPDATE the columns it set.
 */
export function planUndo(record: UndoRecord, current: unknown[][]): UndoPlan {
    const table = record.table;
    if (record.kind === 'insert') {
        const range = record.rowids;
        if (!range || range.upTo <= range.after) return { statements: [], restore: 0, skipped: 0 };
        return {
            statements: [`DELETE FROM ${table} WHERE rowid > ${range.after} AND rowid <= ${range.upTo}`],
            restore: range.upTo - range.after,
            skipped: 0,
        };
    }

    const at = keyIndexes(record);
    const width = record.key.length;
    const lit = (v: unknown) => sqlLiteral(v, record.dialect);
    const now = new Map(current.map((row) => [keyText(row.slice(0, width)), row.slice(width)]));

    if (record.kind === 'delete') {
        // Back in only where the key is free: a reused key is someone else's row now.
        const missing = record.rows.filter((row) => !now.has(keyText(at.map((k) => decodeValue(row[k])))));
        const statements: string[] = [];
        const columns = record.columns.map(ident).join(', ');
        for (let i = 0; i < missing.length; i += CHUNK) {
            const values = missing
                .slice(i, i + CHUNK)
                .map((row) => `(${row.map((v) => lit(decodeValue(v))).join(', ')})`)
                .join(', ');
            statements.push(`INSERT INTO ${table} (${columns}) VALUES ${values}`);
        }
        return { statements, restore: missing.length, skipped: record.rows.length - missing.length };
    }

    // UPDATE: back to the old value only where the row still holds what the write put there.
    const assigned = record.assigned ?? [];
    const before = assigned.map((column) => record.columns.indexOf(column));
    if (before.some((i) => i < 0)) return { statements: [], restore: 0, skipped: record.rows.length };
    const statements: string[] = [];
    let skipped = 0;
    record.rows.forEach((row, r) => {
        const key = at.map((k) => decodeValue(row[k]));
        const held = now.get(keyText(key));
        const wrote = (record.after?.[r] ?? []).map(decodeValue);
        if (!held || !wrote.every((value, i) => sameValue(held[i], value))) {
            skipped++;
            return;
        }
        const set = assigned.map((column, i) => `${ident(column)} = ${lit(decodeValue(row[before[i]]))}`).join(', ');
        const where = record.key.map((k, i) => `${ident(k)} = ${lit(key[i])}`).join(' AND ');
        statements.push(`UPDATE ${table} SET ${set} WHERE ${where}`);
    });
    return { statements, restore: statements.length, skipped };
}
