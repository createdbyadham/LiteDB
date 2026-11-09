// Saving what an approved write is about to change, so Undo can put it back.
//
// The file format and the restore plan are in src/lib/undoWrite.ts. This runs
// in the server, between the approval and the write: it reads the rows the
// statement will touch, keyed by primary key (or SQLite's rowid), and writes
// them next to the audit log once the statement has run.
//
// Only a single statement is saved. In a script the statements depend on each
// other, and a snapshot taken before the first is wrong for the second.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildDiffQuery } from '../../src/lib/agentApproval';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import { tokenize } from '../../src/lib/sqlTokenizer';
import {
    encodeValue,
    serializeUndo,
    UNDO_FOLDER,
    UNDO_MAX_ROWS,
    UNDO_VERSION,
    type Encoded,
    type UndoRecord,
} from '../../src/lib/undoWrite';
import type { Database } from './db';

export interface PreparedUndo {
    /** Write the file once the statement has run. Returns the audit entry's link, or null. */
    save(): Promise<string | null>;
}

function encodeRows(rows: unknown[][]): Encoded[][] | null {
    const out: Encoded[][] = [];
    for (const row of rows) {
        const encoded: Encoded[] = [];
        for (const value of row) {
            const e = encodeValue(value);
            if (e === undefined) return null; // an array column: not put back faithfully
            encoded.push(e);
        }
        out.push(encoded);
    }
    return out;
}

/** An upsert or REPLACE overwrites rows a snapshot of the new ones cannot restore. */
function overwrites(sql: string): boolean {
    const tokens = tokenize(sql);
    return tokens.some(
        (t, i) =>
            t.depth === 0 &&
            t.kind === 'word' &&
            (t.value === 'REPLACE' || (t.value === 'ON' && tokens[i + 1]?.value === 'CONFLICT')),
    );
}

/**
 * Read what `statement` will change and return how to save it, or null when
 * it cannot be undone: a table with no key, too many rows, an upsert, or a
 * Postgres INSERT (whose new rows cannot be told apart afterwards).
 */
export async function prepareUndo(
    db: Database,
    statement: StatementClassification,
    connectionId: string,
    auditPath: string,
): Promise<PreparedUndo | null> {
    const table = statement.table;
    if (!table || statement.kind === 'read') return null;
    const base = {
        version: UNDO_VERSION,
        id: randomUUID(),
        table,
        dialect: db.dialect,
        connectionId,
        sql: statement.sql,
        capturedAt: new Date().toISOString(),
    } as const;
    const write = async (record: UndoRecord): Promise<string> => {
        const folder = join(dirname(auditPath), UNDO_FOLDER);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, `${record.id}.json`), serializeUndo(record), 'utf8');
        return `${UNDO_FOLDER}/${record.id}.json`;
    };

    if (statement.verb === 'INSERT') {
        if (db.dialect !== 'sqlite' || overwrites(statement.sql)) return null;
        // New rows get rowids above the current largest. Fails, and so opts
        // out, for a WITHOUT ROWID table.
        const largest = async () => Number((await db.read(`SELECT max(rowid) FROM ${table}`)).rows[0]?.[0] ?? 0);
        const after = await largest();
        return {
            save: async () => {
                const upTo = await largest();
                if (upTo <= after) return null;
                return write({ ...base, kind: 'insert', key: ['rowid'], columns: [], rows: [], rowids: { after, upTo } });
            },
        };
    }

    if (statement.verb !== 'UPDATE' && statement.verb !== 'DELETE') return null;
    if (overwrites(statement.sql)) return null;
    const query = buildDiffQuery(statement, UNDO_MAX_ROWS);
    if (!query) return null;

    let key = (await db.columns(table)).filter((c) => c.isPrimaryKey).map((c) => c.name);
    let sql = query.sql;
    if (key.length === 0) {
        // Postgres has no stable row address to find the row again by.
        if (db.dialect !== 'sqlite') return null;
        key = ['rowid'];
        sql = sql.replace(/^SELECT \*/, 'SELECT rowid, *');
    }

    const result = await db.read(sql);
    if (result.rows.length > UNDO_MAX_ROWS || result.rows.length === 0) return null;
    const assignedCount = query.assigned?.length ?? 0;
    const width = result.columns.length - assignedCount;
    const rows = encodeRows(result.rows.map((row) => row.slice(0, width)));
    const after = assignedCount ? encodeRows(result.rows.map((row) => row.slice(width))) : [];
    if (!rows || !after) return null;
    const record: UndoRecord = {
        ...base,
        kind: statement.verb === 'DELETE' ? 'delete' : 'update',
        key,
        columns: result.columns.slice(0, width),
        rows,
        ...(assignedCount ? { assigned: query.assigned, after } : {}),
    };
    return { save: () => write(record) };
}
