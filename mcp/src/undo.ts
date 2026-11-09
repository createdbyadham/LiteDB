// Undo files for the npm server: next to the audit log, where the desktop
// app's Undo button looks for them. What goes in them is undoCapture.ts.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import { serializeUndo, UNDO_FOLDER } from '../../src/lib/undoWrite';
import type { Database } from './catalog';
import { captureUndo, type PreparedUndo, type UndoWriter } from './undoCapture';

export type { PreparedUndo } from './undoCapture';

/** Write undo records into `undo/` beside the audit log at `auditPath`. */
export function fileUndoWriter(auditPath: string): UndoWriter {
    return async (record) => {
        const folder = join(dirname(auditPath), UNDO_FOLDER);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, `${record.id}.json`), serializeUndo(record), 'utf8');
        return `${UNDO_FOLDER}/${record.id}.json`;
    };
}

export function prepareUndo(
    db: Database,
    statement: StatementClassification,
    connectionId: string,
    auditPath: string,
): Promise<PreparedUndo | null> {
    return captureUndo(db, statement, connectionId, fileUndoWriter(auditPath));
}
