// Every script run from the editor, newest first, so last week's query is a
// search away rather than gone. Kept on this machine only, like the audit log.

const STORAGE_KEY = 'queryHistory';
const MAX_ENTRIES = 1000;
const CHANGED = 'queryHistoryChanged';

export interface HistoryEntry {
    id: string;
    connectionId: string;
    connectionName: string;
    sql: string;
    at: string;
    durationMs: number;
    ok: boolean;
    /** Rows returned by the last result set, or rows changed. */
    rows: number | null;
    error?: string;
}

function read(): HistoryEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
    } catch {
        return [];
    }
}

export function listHistory(): HistoryEntry[] {
    return read();
}

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): void {
    const entries = read();
    // Running the same text again moves it to the top instead of duplicating it.
    const deduped = entries.filter((e) => !(e.connectionId === entry.connectionId && e.sql === entry.sql));
    deduped.unshift({ ...entry, id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() });
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(deduped.slice(0, MAX_ENTRIES)));
    } catch (error) {
        console.error('Failed to save query history:', error);
    }
    window.dispatchEvent(new CustomEvent(CHANGED));
}

export function clearHistory(connectionId?: string): void {
    const kept = connectionId ? read().filter((e) => e.connectionId !== connectionId) : [];
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
        // Nothing to do.
    }
    window.dispatchEvent(new CustomEvent(CHANGED));
}

export function onHistoryChanged(listener: () => void): () => void {
    window.addEventListener(CHANGED, listener);
    return () => window.removeEventListener(CHANGED, listener);
}
