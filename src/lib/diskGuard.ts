/** A SQLite file as the Rust side reports it (`src-tauri/src/sqlite_file.rs`). */

export type DiskSnapshot = {
    /** Opaque modified-time token (µs). Null when the file cannot be stat'd. */
    mtime: number | null;
    walSize: number;
    /**
     * Writes are sitting in the WAL. The poll only stats; a program that
     * merely has the file open shows up when a save cannot take SQLite's lock.
     */
    inUse: boolean;
};

export type SaveBlock = 'ok' | 'changed' | 'in-use' | 'missing';

/** What the status bar shows. `save-failed` is a write error, not a conflict. */
export type DiskAlert = Exclude<SaveBlock, 'ok'> | 'save-failed';

/**
 * sql.js writes a whole-file image. A non-empty WAL, or SQLite elsewhere with
 * the file open, means that image would be replayed over or read stale. A
 * modified time we did not produce means someone else wrote; so does one we
 * never managed to record — "unknown" is not "unchanged".
 *
 * The Rust save repeats this under a file handle; this copy decides what the
 * poll does between saves.
 */
export function saveWouldClobber(current: DiskSnapshot, last: DiskSnapshot | null): SaveBlock {
    if (current.mtime == null) return 'missing';
    if (current.inUse || current.walSize > 0) return 'in-use';
    if (last?.mtime == null) return 'changed';
    if (current.mtime !== last.mtime) return 'changed';
    return 'ok';
}
