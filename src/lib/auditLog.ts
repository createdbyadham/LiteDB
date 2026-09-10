// Append-only record of every statement the gate let through.
//
// The point of an audit log in a database client is to answer "what did the
// model actually run against my data, and did I say yes to it?" — after the
// fact, when something looks wrong and memory is not evidence. So entries are
// written when the statement runs, never rewritten, and the module exposes no
// way to edit or delete one.
//
// Two honest limits, stated because a safety feature that overclaims is worse
// than none:
//
//   * Append-only is a property of this API, not of the file. The file sits in
//     the user's own app-data directory and the user can edit it. This is a
//     record for its owner, not tamper-evident storage for a third party.
//   * Entries hold the SQL verbatim, which means literal values — the email in
//     a WHERE clause, the value in a SET. That is the whole point (a redacted
//     log cannot tell you what ran) and it is why the file never leaves the
//     machine and is never attached to a diagnostics bundle.
//
// The Tauri filesystem plugin is imported dynamically so this module stays
// importable outside the desktop shell: in `npm run dev` in a plain browser,
// and in the eval harness, which asserts against the serialisation.

import type { SqlDialect } from './schemaTypes';
import type { StatementKind } from './sqlClassifier';
import type { Provenance, SafetyPolicy } from './sqlPolicy';

/** What the gate concluded, and what the user did about it. */
export type AuditDecision =
    /** Policy allowed it outright; no prompt was shown. */
    | 'allowed'
    /** The user was shown the impact and approved. */
    | 'approved'
    /** Policy refused it. It never ran. */
    | 'blocked'
    /** The user was asked and said no. It never ran. */
    | 'declined';

export type AuditOutcome = 'ok' | 'error' | 'not-run';

export interface AuditEntry {
    id: string;
    /** ISO 8601, UTC. */
    at: string;
    provenance: Provenance;
    /** Human-readable connection label, e.g. "sqlite:shop.db". */
    connection: string;
    dialect: SqlDialect;
    sql: string;
    kind: StatementKind;
    verb: string;
    table: string | null;
    /** The policy in force when the decision was made, after the AI floor. */
    policy: SafetyPolicy;
    decision: AuditDecision;
    outcome: AuditOutcome;
    error: string | null;
    /** What the impact preview predicted, for comparison against reality. */
    estimatedRows: number | null;
    /**
     * What the engine reported actually changed.
     *
     * Kept alongside the prediction rather than replacing it: the two
     * disagreeing is the interesting case, and a log holding only the estimate
     * cannot tell you the approval dialog was wrong.
     */
    actualRows: number | null;
    durationMs: number | null;
    /** Model that produced the SQL. Null for user-authored statements. */
    model: string | null;
    /** The natural-language request. Null for user-authored statements. */
    prompt: string | null;
}

const LOG_DIR = 'audit';
const LOG_PATH = 'audit/sql-audit.jsonl';

export function newAuditId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One entry, one line. Newlines inside the SQL are escaped by JSON.stringify,
 * so a line is always a whole record and a truncated write can only ever cost
 * the last one.
 */
export function serializeEntry(entry: AuditEntry): string {
    return `${JSON.stringify(entry)}\n`;
}

/**
 * Parse a log back into entries, skipping lines that do not parse.
 *
 * Tolerating damage matters more than rejecting it: a half-written final line
 * after a crash must not make the preceding history unreadable.
 */
export function parseLog(contents: string): AuditEntry[] {
    const entries: AuditEntry[] = [];
    for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && 'sql' in parsed && 'at' in parsed) {
                entries.push(parsed as AuditEntry);
            }
        } catch {
            // Damaged line; keep the rest.
        }
    }
    return entries;
}

/** True inside the Tauri shell, where a real file is available. */
function inTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Fallback sink for `npm run dev` in a browser, where there is no filesystem.
 * Bounded, because localStorage is not a log store — it is a way to keep the
 * feature visibly working outside the shell.
 */
const MEMORY_LIMIT = 500;
const MEMORY_KEY = 'sqlAuditLog';

function appendToLocalStorage(entry: AuditEntry): void {
    try {
        const existing = parseLog(localStorage.getItem(MEMORY_KEY) ?? '');
        existing.push(entry);
        const kept = existing.slice(-MEMORY_LIMIT);
        localStorage.setItem(MEMORY_KEY, kept.map(serializeEntry).join(''));
    } catch {
        // A full or unavailable localStorage must not fail the query.
    }
}

// Appends are chained rather than issued concurrently: two overlapping
// appends to the same file can interleave mid-line and corrupt both records.
let writeChain: Promise<void> = Promise.resolve();

/**
 * Record an entry. Never throws.
 *
 * A failure to log is reported to the console and swallowed. The alternative —
 * failing the user's query because the log was unwritable — trades a small
 * loss of record-keeping for a large loss of function, which is the wrong way
 * round.
 */
export function recordAudit(entry: AuditEntry): Promise<void> {
    writeChain = writeChain.then(async () => {
        try {
            if (!inTauri()) {
                appendToLocalStorage(entry);
                return;
            }
            const { BaseDirectory, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
            await mkdir(LOG_DIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
            await writeTextFile(LOG_PATH, serializeEntry(entry), {
                baseDir: BaseDirectory.AppLocalData,
                append: true,
            });
        } catch (error) {
            console.error('Failed to write audit entry:', error);
        }
    });
    return writeChain;
}

/**
 * Read the most recent entries, newest first.
 *
 * Reads the whole file and keeps the tail. At roughly 300 bytes a line that is
 * a megabyte for every 3,000 statements, which is not worth streaming for;
 * revisit if that stops being true.
 */
export async function readAudit(limit = 200): Promise<AuditEntry[]> {
    try {
        let contents = '';
        if (inTauri()) {
            const { BaseDirectory, exists, readTextFile } = await import('@tauri-apps/plugin-fs');
            const present = await exists(LOG_PATH, { baseDir: BaseDirectory.AppLocalData });
            if (!present) return [];
            contents = await readTextFile(LOG_PATH, { baseDir: BaseDirectory.AppLocalData });
        } else {
            contents = localStorage.getItem(MEMORY_KEY) ?? '';
        }
        return parseLog(contents).slice(-limit).reverse();
    } catch (error) {
        console.error('Failed to read audit log:', error);
        return [];
    }
}

/** Where the log lives, for the settings dialog to show the user. */
export function auditLogLocation(): string {
    return inTauri() ? `<app data>/${LOG_PATH}` : 'browser localStorage (development only)';
}
