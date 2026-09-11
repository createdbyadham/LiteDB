// Remembers the last few Postgres connections so they can be reopened with one
// click instead of five fields.
//
// The split matters: **everything except the password goes in localStorage,
// and the password never does.** Host, port, database and username are
// addressing information — the same things that already sit in the audit log's
// connection label. The password is a credential, so it goes to the OS keychain
// through the same Tauri commands the AI provider keys already use, keyed by
// the connection id.
//
// Saving the password is opt-in per connection. A tool that silently memorises
// the credentials to a production database has made a decision that was not
// its to make, and "I clicked connect" is not consent to that.

import { invoke } from '@tauri-apps/api/core';
import type { PgConfig } from './pgService';
import { postgresConnectionId } from './connectionId';

const STORAGE_KEY = 'recentPgConnections';
const KEYCHAIN_SERVICE = 'LiteDB';

/**
 * Three. Enough to cover "the one I use, the one I used yesterday, and the
 * other one", short enough to stay a glance rather than a list to read.
 */
export const MAX_RECENT = 3;

export interface RecentConnection {
    /** Stable identity, shared with the safety layer's per-connection policy. */
    id: string;
    host: string;
    port: number;
    database: string;
    username: string;
    ssl: boolean;
    /** ISO 8601, UTC. Used only for ordering. */
    lastUsedAt: string;
    /** Whether a password for this connection is in the OS keychain. */
    hasSavedPassword: boolean;
}

function keychainAccount(id: string): string {
    return `pg-password-${id}`;
}

function read(): RecentConnection[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (entry): entry is RecentConnection =>
                typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as RecentConnection).id === 'string' &&
                typeof (entry as RecentConnection).host === 'string',
        );
    } catch {
        return [];
    }
}

function write(entries: RecentConnection[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (error) {
        console.error('Failed to persist recent connections:', error);
    }
}

/** Most recently used first, capped at MAX_RECENT. */
export function listRecentConnections(): RecentConnection[] {
    return read()
        .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1))
        .slice(0, MAX_RECENT);
}

/**
 * Record a successful connection.
 *
 * Called only after the connection actually succeeded — offering to reopen
 * something that never worked is worse than not offering at all.
 */
export async function rememberConnection(config: PgConfig, savePassword: boolean): Promise<void> {
    const id = postgresConnectionId(config.host, config.port, config.database);

    let stored = false;
    if (savePassword && config.password) {
        try {
            await invoke('store_secret', {
                service: KEYCHAIN_SERVICE,
                account: keychainAccount(id),
                secret: config.password,
            });
            stored = true;
        } catch (error) {
            // Failing to save a password must not lose the connection entry —
            // the user simply types it next time.
            console.error('Failed to save connection password:', error);
        }
    } else if (!savePassword) {
        // Unticking the box on a connection that had one saved has to remove
        // it, or the setting would be a lie the second time round.
        await forgetPassword(id);
    }

    const entry: RecentConnection = {
        id,
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        ssl: config.ssl ?? false,
        lastUsedAt: new Date().toISOString(),
        hasSavedPassword: stored,
    };

    const others = read().filter((existing) => existing.id !== id);
    const kept = [entry, ...others].slice(0, MAX_RECENT);

    // Anything falling off the end takes its stored password with it, so the
    // keychain does not accumulate secrets for connections the app has
    // forgotten how to reach.
    for (const dropped of others.slice(MAX_RECENT - 1)) {
        if (dropped.hasSavedPassword) await forgetPassword(dropped.id);
    }

    write(kept);
}

/** The saved password for a connection, or null if there is none. */
export async function loadPassword(id: string): Promise<string | null> {
    try {
        return await invoke<string | null>('get_secret', {
            service: KEYCHAIN_SERVICE,
            account: keychainAccount(id),
        });
    } catch (error) {
        console.error('Failed to read saved password:', error);
        return null;
    }
}

async function forgetPassword(id: string): Promise<void> {
    try {
        await invoke('delete_secret', {
            service: KEYCHAIN_SERVICE,
            account: keychainAccount(id),
        });
    } catch {
        // Already absent, or no keychain. Nothing to undo.
    }
}

/** Remove a connection from the list and delete any password it saved. */
export async function forgetConnection(id: string): Promise<void> {
    write(read().filter((entry) => entry.id !== id));
    await forgetPassword(id);
}

/** "postgres@localhost:5432/shop" — what the user sees in the list. */
export function describeConnection(entry: RecentConnection): string {
    return `${entry.username}@${entry.host}:${entry.port}/${entry.database}`;
}
