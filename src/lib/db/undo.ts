// Undo in the Audit panel: read the saved rows, check what is still as the
// write left it, and put back what can be put back. The file format and the
// plan are in src/lib/undoWrite.ts.

import { currentStateQueries, parseUndo, planUndo, serializeUndo, type UndoPlan, type UndoRecord } from '@/lib/undoWrite';
import { auditGridWrite } from './audit';
import type { OpenConnection } from './connections';

/** Undo links are relative to the audit log's folder. */
const AUDIT_DIR = 'audit';

function inTauri(): boolean {
    return '__TAURI_INTERNALS__' in globalThis;
}

export async function loadUndo(link: string): Promise<UndoRecord | null> {
    if (!inTauri()) return null;
    const fs = await import('@tauri-apps/plugin-fs');
    try {
        return parseUndo(await fs.readTextFile(`${AUDIT_DIR}/${link}`, { baseDir: fs.BaseDirectory.AppLocalData }));
    } catch {
        return null;
    }
}

/** What undoing would do, against the database as it is now. */
export async function planUndoFor(conn: OpenConnection, record: UndoRecord): Promise<UndoPlan> {
    const current: unknown[][] = [];
    for (const sql of currentStateQueries(record)) {
        current.push(...(await conn.client.query(sql)).rows);
    }
    return planUndo(record, current);
}

/**
 * Run the plan in one transaction, through the connection's safety mode, log
 * it, and mark the file so the same write cannot be undone twice.
 */
export async function runUndo(
    conn: OpenConnection,
    link: string,
    record: UndoRecord,
    plan: UndoPlan,
    entryId: string,
): Promise<void> {
    const response = await conn.client.execute(plan.statements, { transaction: true });
    if (response.errors.length > 0) throw new Error(response.errors[0].message);
    auditGridWrite(conn, [`${plan.statements[0]} /* undo of ${entryId}: ${plan.restore} rows */`], {
        ok: true,
        rows: plan.restore,
    });
    const fs = await import('@tauri-apps/plugin-fs');
    await fs.writeTextFile(`${AUDIT_DIR}/${link}`, serializeUndo({ ...record, undoneAt: new Date().toISOString() }), {
        baseDir: fs.BaseDirectory.AppLocalData,
    });
}
