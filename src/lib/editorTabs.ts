// The SQL editor's tabs, kept per connection and across restarts, so a query
// you were writing is still there when you come back to the database.

import type { Provenance } from './sqlPolicy';

export interface EditorTab {
    id: string;
    title: string;
    sql: string;
    /** Who wrote what is in the box. Sticky: editing generated SQL keeps it 'ai'. */
    provenance: Provenance;
    /** The request generated SQL came from, for the audit log. */
    aiPrompt: string | null;
    /** Renamed by the user; otherwise the title follows the SQL. */
    named?: boolean;
}

export interface EditorTabsState {
    tabs: EditorTab[];
    activeId: string;
}

const PREFIX = 'editorTabs:';

function newTabId(): string {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newTab(index: number, sql = ''): EditorTab {
    return { id: newTabId(), title: `Query ${index}`, sql, provenance: 'user', aiPrompt: null };
}

export function loadTabs(connectionId: string): EditorTabsState {
    try {
        const raw = localStorage.getItem(PREFIX + connectionId);
        if (raw) {
            const parsed = JSON.parse(raw) as EditorTabsState;
            if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
                const activeId = parsed.tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : parsed.tabs[0].id;
                return { tabs: parsed.tabs, activeId };
            }
        }
    } catch {
        // Fall through to a fresh tab.
    }
    const first = newTab(1);
    return { tabs: [first], activeId: first.id };
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced: the editor calls this on every keystroke. */
export function saveTabs(connectionId: string, state: EditorTabsState): void {
    clearTimeout(timers.get(connectionId));
    timers.set(
        connectionId,
        setTimeout(() => {
            try {
                localStorage.setItem(PREFIX + connectionId, JSON.stringify(state));
            } catch (error) {
                console.error('Failed to save editor tabs:', error);
            }
        }, 400),
    );
}

/** A title from the SQL's first meaningful line, for tabs nobody named. */
export function titleFromSql(sql: string, fallback: string): string {
    const line = sql
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('--'));
    if (!line) return fallback;
    return line.length > 28 ? `${line.slice(0, 28)}…` : line;
}
