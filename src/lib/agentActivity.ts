// What agents are doing to the open database, as it happens.
//
// `litedb-mcp` runs as its own process and appends every statement it runs
// (or is refused, or is waiting on approval for) to the same audit log the
// app writes. Watching that file is the only channel between the two, and it
// is enough: the log already says who, what and which table.
//
// The file is polled rather than watched. A native watcher needs a Rust
// feature flag and a rebuild for what is, at most, a check every second and a
// half while the window is visible, and the poll costs one stat call when
// nothing changed.

import { parseLog, type AuditEntry } from './auditLog';
import { isOwnAuditEntry } from './queryGate';

const LOG_PATH = 'audit/sql-audit.jsonl';
const POLL_MS = 1500;

type Listener = (entries: AuditEntry[]) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
/** Entries already seen. Null until the first read, so history is never replayed. */
let seen: number | null = null;
let lastSize = -1;
let polling = false;

function inTauri(): boolean {
    return '__TAURI_INTERNALS__' in globalThis;
}

/**
 * Hand new entries to listeners, keeping only the ones an agent wrote.
 *
 * Exported so the poller and a test can share the path: in a browser there
 * is no file, but the rest of the pipeline is the same.
 */
export function reportAgentEntries(entries: AuditEntry[]): void {
    const fromAgents = entries.filter((e) => e.provenance === 'ai' && !isOwnAuditEntry(e.id));
    if (fromAgents.length) listeners.forEach((fn) => fn(fromAgents));
}

async function poll(): Promise<void> {
    if (polling || document.visibilityState === 'hidden') return;
    polling = true;
    try {
        const fs = await import('@tauri-apps/plugin-fs');
        const options = { baseDir: fs.BaseDirectory.AppLocalData };
        const info = await fs.stat(LOG_PATH, options).catch(() => null);
        if (!info) {
            // No log yet: everything that appears from now on is new.
            seen ??= 0;
            return;
        }
        if (info.size === lastSize) return;
        lastSize = info.size;
        const entries = parseLog(await fs.readTextFile(LOG_PATH, options));
        if (seen === null || entries.length < seen) {
            seen = entries.length;
            return;
        }
        const fresh = entries.slice(seen);
        seen = entries.length;
        reportAgentEntries(fresh);
    } catch (error) {
        console.error('Watching the audit log for agent activity failed:', error);
    } finally {
        polling = false;
    }
}

/** Call `fn` with each batch of statements an agent sends. Returns an unsubscribe. */
export function onAgentActivity(fn: Listener): () => void {
    listeners.add(fn);
    if (!timer && inTauri()) {
        void poll();
        timer = setInterval(() => void poll(), POLL_MS);
    }
    return () => {
        listeners.delete(fn);
        if (!listeners.size && timer) {
            clearInterval(timer);
            timer = undefined;
            seen = null;
            lastSize = -1;
        }
    };
}
