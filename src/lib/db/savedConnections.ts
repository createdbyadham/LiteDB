// Connections you can reopen in one click, as many as you like.
//
// The split is the one recentConnections.ts made, kept: everything except
// secrets goes in localStorage, and secrets never do. Host, database, username
// and file paths are addressing information. Passwords and SSH passphrases go
// to the OS keychain, and only when the user ticks the box for that
// connection — a tool that memorises production credentials on its own has
// made a decision that was not its to make.

import { invoke } from '@tauri-apps/api/core';
import type { SslMode } from './pgUrl';

const STORAGE_KEY = 'savedConnections';
const LEGACY_KEY = 'recentPgConnections';
const KEYCHAIN_SERVICE = 'LiteDB';
const CHANGED_EVENT = 'savedConnectionsChanged';

export const CONNECTION_COLORS: { value: string; label: string; swatch: string }[] = [
    { value: 'red', label: 'Red', swatch: '#e5484d' },
    { value: 'orange', label: 'Orange', swatch: '#f76b15' },
    { value: 'amber', label: 'Amber', swatch: '#f5a524' },
    { value: 'green', label: 'Green', swatch: '#30a46c' },
    { value: 'teal', label: 'Teal', swatch: '#12a594' },
    { value: 'blue', label: 'Blue', swatch: '#0090ff' },
    { value: 'violet', label: 'Violet', swatch: '#8e4ec6' },
    { value: 'pink', label: 'Pink', swatch: '#d6409f' },
];

export function colorSwatch(color: string | null | undefined): string | null {
    return CONNECTION_COLORS.find((c) => c.value === color)?.swatch ?? null;
}

export interface SavedSsh {
    host: string;
    port: number;
    username: string;
    auth: 'password' | 'key' | 'agent';
    privateKeyPath?: string;
}

export interface SavedConnection {
    id: string;
    name: string;
    color: string | null;
    /** Opens read-only by default, with a red title bar while it is on screen. */
    production: boolean;
    kind: 'sqlite' | 'postgres';
    /** SQLite: the file. */
    path?: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    sslMode?: SslMode;
    sslRootCert?: string;
    ssh?: SavedSsh | null;
    /** A database password is in the keychain. */
    hasPassword?: boolean;
    /** An SSH password or key passphrase is in the keychain. */
    hasSshSecret?: boolean;
    createdAt: string;
    lastUsedAt: string | null;
}

export interface ConnectionSecrets {
    /** Undefined leaves the stored one alone; '' or null removes it. */
    password?: string | null;
    sshSecret?: string | null;
}

function passwordAccount(id: string): string {
    return `pg-password-${id}`;
}

function sshAccount(id: string): string {
    return `ssh-secret-${id}`;
}

function newId(): string {
    const random = globalThis.crypto?.randomUUID?.();
    return random ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function read(): SavedConnection[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') as SavedConnection[]) : [];
    } catch {
        return [];
    }
}

function write(entries: SavedConnection[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (error) {
        console.error('Failed to save connections:', error);
    }
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

/**
 * The three remembered Postgres connections from before become saved
 * connections. Their ids are kept, so passwords already in the keychain under
 * `pg-password-<id>` carry over without being read or rewritten.
 */
function migrateLegacy(): void {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(LEGACY_KEY);
    } catch {
        return;
    }
    if (!raw) return;
    try {
        const legacy: unknown = JSON.parse(raw);
        if (Array.isArray(legacy)) {
            const current = read();
            for (const entry of legacy) {
                if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
                if (current.some((c) => c.id === entry.id)) continue;
                current.push({
                    id: entry.id,
                    name: `${entry.database} on ${entry.host}`,
                    color: null,
                    production: false,
                    kind: 'postgres',
                    host: String(entry.host ?? 'localhost'),
                    port: Number(entry.port ?? 5432),
                    database: String(entry.database ?? ''),
                    username: String(entry.username ?? ''),
                    sslMode: entry.ssl ? 'require' : 'disable',
                    ssh: null,
                    hasPassword: entry.hasSavedPassword === true,
                    hasSshSecret: false,
                    createdAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : new Date().toISOString(),
                    lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : null,
                });
            }
            write(current);
        }
        localStorage.removeItem(LEGACY_KEY);
    } catch (error) {
        console.error('Failed to migrate recent connections:', error);
    }
}

let migrated = false;

/** Most recently used first, then by name. */
export function listSavedConnections(): SavedConnection[] {
    if (!migrated) {
        migrated = true;
        migrateLegacy();
    }
    return read().sort((a, b) => {
        const byUse = (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
        return byUse !== 0 ? byUse : a.name.localeCompare(b.name);
    });
}

export function getSavedConnection(id: string): SavedConnection | undefined {
    return read().find((c) => c.id === id);
}

export function findSqliteConnection(path: string): SavedConnection | undefined {
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return read().find((c) => c.kind === 'sqlite' && c.path?.replace(/\\/g, '/').toLowerCase() === normalized);
}

export function onSavedConnectionsChanged(listener: () => void): () => void {
    window.addEventListener(CHANGED_EVENT, listener);
    return () => window.removeEventListener(CHANGED_EVENT, listener);
}

async function setSecret(account: string, secret: string | null | undefined): Promise<boolean | undefined> {
    if (secret === undefined) return undefined;
    try {
        if (secret) {
            await invoke('store_secret', { service: KEYCHAIN_SERVICE, account, secret });
            return true;
        }
        await invoke('delete_secret', { service: KEYCHAIN_SERVICE, account });
        return false;
    } catch (error) {
        // Failing to store a secret must not lose the connection itself.
        console.error('Keychain write failed:', error);
        return false;
    }
}

async function getSecret(account: string): Promise<string | null> {
    try {
        return (await invoke<string | null>('get_secret', { service: KEYCHAIN_SERVICE, account })) ?? null;
    } catch (error) {
        console.error('Keychain read failed:', error);
        return null;
    }
}

export type SavedConnectionInput = Omit<SavedConnection, 'id' | 'createdAt' | 'lastUsedAt' | 'hasPassword' | 'hasSshSecret'> & {
    id?: string;
};

/** Create or update. Secrets are written to the keychain as asked. */
export async function saveConnection(input: SavedConnectionInput, secrets: ConnectionSecrets = {}): Promise<SavedConnection> {
    const entries = read();
    const existing = input.id ? entries.find((c) => c.id === input.id) : undefined;
    const id = existing?.id ?? input.id ?? newId();
    const storedPassword = await setSecret(passwordAccount(id), secrets.password);
    const storedSsh = await setSecret(sshAccount(id), secrets.sshSecret);
    const entry: SavedConnection = {
        ...existing,
        ...input,
        id,
        hasPassword: storedPassword ?? existing?.hasPassword ?? false,
        hasSshSecret: input.ssh ? (storedSsh ?? existing?.hasSshSecret ?? false) : false,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        lastUsedAt: existing?.lastUsedAt ?? null,
    };
    write([...entries.filter((c) => c.id !== id), entry]);
    return entry;
}

export function touchConnection(id: string): void {
    const entries = read();
    const entry = entries.find((c) => c.id === id);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    write(entries);
}

export async function deleteConnection(id: string): Promise<void> {
    write(read().filter((c) => c.id !== id));
    await setSecret(passwordAccount(id), null);
    await setSecret(sshAccount(id), null);
}

/** Fetched when connecting, so it is only in memory between click and connect. */
export function loadPassword(id: string): Promise<string | null> {
    return getSecret(passwordAccount(id));
}

export function loadSshSecret(id: string): Promise<string | null> {
    return getSecret(sshAccount(id));
}

export function describeSaved(entry: SavedConnection): string {
    if (entry.kind === 'sqlite') return entry.path ?? '';
    const user = entry.username ? `${entry.username}@` : '';
    const via = entry.ssh?.host ? ` via ${entry.ssh.host}` : '';
    return `${user}${entry.host}:${entry.port}/${entry.database}${via}`;
}

export function fileName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}
