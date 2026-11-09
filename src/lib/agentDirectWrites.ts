// Which connections let agents make small changes without asking.
//
// Off for every connection until someone turns it on in Settings → Agents,
// and never in effect on a connection tagged production. What it allows is
// decided in mcp/src/directWrites.ts; this only remembers the switch and its
// row limit, per connection, like the safety mode in queryGate.ts.

import type { DirectWrites } from '../../mcp/src/directWrites';

export type { DirectWrites };

const STORAGE_KEY = 'agentDirectWrites';
export const DIRECT_WRITES_CHANGED = 'agentDirectWritesChanged';
export const DEFAULT_DIRECT_LIMIT = 100;
/** Past this, a "small change" is not small, and the preview is worth its call. */
export const MAX_DIRECT_LIMIT = 10_000;

function read(): Record<string, DirectWrites> {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, DirectWrites>) : {};
    } catch {
        return {};
    }
}

/** A row limit the switch can hold: a whole number from 1 to MAX_DIRECT_LIMIT. */
export function clampDirectLimit(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_DIRECT_LIMIT;
    return Math.min(MAX_DIRECT_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * What agents may do without asking on this connection, or null when every
 * write waits for approval. A connection tagged production is always null.
 */
export function directWritesFor(connectionId: string, production = false): DirectWrites | null {
    if (production) return null;
    const entry = read()[connectionId];
    if (!entry || typeof entry.maxRows !== 'number') return null;
    return { maxRows: clampDirectLimit(entry.maxRows) };
}

/** Turn it on with a row limit, or off with null. */
export function setDirectWrites(connectionId: string, value: DirectWrites | null): void {
    try {
        const all = read();
        if (value) all[connectionId] = { maxRows: clampDirectLimit(value.maxRows) };
        else delete all[connectionId];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (error) {
        console.error('Failed to save the agent write setting:', error);
    }
    window.dispatchEvent(new CustomEvent(DIRECT_WRITES_CHANGED, { detail: { connectionId } }));
}
