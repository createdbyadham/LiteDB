// The file that tells `litedb-mcp` which database the desktop app has open.
//
// The npm package has to work for someone who has never launched LiteDB — that
// is why the server takes `LITEDB_SQLITE_PATH` / `LITEDB_DATABASE_URL`. This
// file is the other direction: you already connected in the app, so the agent
// should follow that connection rather than asking you to paste the same
// details into `claude_desktop_config.json`.
//
// Written next to the audit log, in the app-data directory. The Postgres
// password is stored here in plaintext when that is what is connected. That is
// the same exposure as putting it in the MCP host's config, in a less
// screenshot-prone place; reading it back out of the OS keychain would need a
// native module and would cost the published package its "no native deps"
// property. Stated here because a safety feature that overclaims is worse than
// none.
//
// Cleared on disconnect *and* when the window closes, so quitting the app
// does not leave the last database (and its password) advertised to an agent.

import type { SqlDialect } from './schemaTypes';
import type { SafetyPolicy } from './sqlPolicy';

export const HANDOFF_VERSION = 1 as const;
export const HANDOFF_FILENAME = 'mcp-handoff.json';

export interface HandoffPostgres {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl: boolean;
}

export interface McpHandoff {
    version: typeof HANDOFF_VERSION;
    updatedAt: string;
    connectionId: string;
    label: string;
    dialect: SqlDialect;
    /** The policy the status bar is set to. YOLO is mapped down by the server. */
    policy: SafetyPolicy;
    /** Absolute path. Null when the editor is holding an in-memory database. */
    sqlitePath?: string | null;
    postgres?: HandoffPostgres;
}

export class HandoffError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HandoffError';
    }
}

/**
 * YOLO means a human is watching the LiteDB window. That is exactly what is
 * not true of an MCP session, so the server must not inherit it.
 */
export function mcpPolicyFromApp(policy: SafetyPolicy): Exclude<SafetyPolicy, 'yolo'> {
    return policy === 'yolo' ? 'guarded' : policy;
}

export function serializeHandoff(handoff: McpHandoff): string {
    return `${JSON.stringify(handoff, null, 2)}\n`;
}

function asString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new HandoffError(`Handoff field "${field}" is missing.`);
    }
    return value;
}

function asPolicy(value: unknown): SafetyPolicy {
    if (
        value === 'read-only' ||
        value === 'guarded' ||
        value === 'unrestricted' ||
        value === 'yolo'
    ) {
        return value;
    }
    throw new HandoffError(`Handoff policy is not recognised (got ${JSON.stringify(value)}).`);
}

function asPostgres(value: unknown): HandoffPostgres {
    if (!value || typeof value !== 'object') {
        throw new HandoffError('Handoff is missing Postgres connection details. Reconnect in LiteDB.');
    }
    const raw = value as Record<string, unknown>;
    const port = raw.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1) {
        throw new HandoffError('Handoff Postgres port is invalid. Reconnect in LiteDB.');
    }
    return {
        host: asString(raw.host, 'postgres.host'),
        port,
        database: asString(raw.database, 'postgres.database'),
        username: asString(raw.username, 'postgres.username'),
        password: typeof raw.password === 'string' ? raw.password : '',
        ssl: raw.ssl === true,
    };
}

export function parseHandoff(contents: string): McpHandoff {
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        throw new HandoffError(
            'The LiteDB handoff file is not valid JSON. Reconnect to the database in the app to rewrite it.',
        );
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new HandoffError('The LiteDB handoff file is empty. Reconnect in the app.');
    }
    const raw = parsed as Record<string, unknown>;
    const dialect = raw.dialect;
    if (dialect !== 'sqlite' && dialect !== 'postgres') {
        throw new HandoffError('The LiteDB handoff file has no dialect. Reconnect in the app.');
    }

    const handoff: McpHandoff = {
        version: HANDOFF_VERSION,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
        connectionId: asString(raw.connectionId, 'connectionId'),
        label: asString(raw.label, 'label'),
        dialect,
        policy: asPolicy(raw.policy),
    };

    if (dialect === 'sqlite') {
        if (raw.sqlitePath === null || raw.sqlitePath === undefined) {
            handoff.sqlitePath = null;
        } else if (typeof raw.sqlitePath === 'string' && raw.sqlitePath.length > 0) {
            handoff.sqlitePath = raw.sqlitePath;
        } else {
            throw new HandoffError('Handoff SQLite path is invalid. Reopen the file in LiteDB.');
        }
    } else {
        handoff.postgres = asPostgres(raw.postgres);
    }

    return handoff;
}

/** Build a postgres:// URL from a handoff. Password is included. */
export function postgresTarget(cfg: HandoffPostgres): string {
    const user = encodeURIComponent(cfg.username);
    const pass = encodeURIComponent(cfg.password);
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    const database = encodeURIComponent(cfg.database);
    // `sslmode=require` in node-pg now verifies the server cert (libpq 17
    // behaviour) and prints a SECURITY WARNING. The app checkbox is "Use SSL"
    // with no CA to trust — encrypt, don't verify — which is `no-verify`.
    // Without this, a self-signed or private-CA host that the desktop app
    // accepted would fail in the agent with a certificate error.
    const ssl = cfg.ssl ? '?sslmode=no-verify' : '';
    return `postgres://${user}:${pass}@${host}:${cfg.port}/${database}${ssl}`;
}

function inTauri(): boolean {
    return '__TAURI_INTERNALS__' in globalThis;
}

export interface HandoffConnection {
    id: string;
    label: string;
    dialect: SqlDialect;
    sqlitePath?: string | null;
    postgres?: HandoffPostgres;
}

/**
 * Write the current connection so a separately-launched MCP server can follow
 * it. Never throws: failing to advertise the connection must not fail Connect.
 */
export function writeActiveHandoff(
    connection: HandoffConnection,
    policy: SafetyPolicy,
): Promise<void> {
    if (sealed) return Promise.resolve();
    const payload: McpHandoff = {
        version: HANDOFF_VERSION,
        updatedAt: new Date().toISOString(),
        connectionId: connection.id,
        label: connection.label,
        dialect: connection.dialect,
        policy,
        sqlitePath: connection.dialect === 'sqlite' ? (connection.sqlitePath ?? null) : undefined,
        postgres: connection.dialect === 'postgres' ? connection.postgres : undefined,
    };

    return persist(serializeHandoff(payload));
}

/** Remove the handoff so a disconnected app is not still advertised. */
export function clearHandoff(): Promise<void> {
    return persist(null);
}

/**
 * Quit path. Further writes are dropped so a racing persist cannot put the
 * Postgres password back after the file is deleted.
 */
export function sealHandoff(): Promise<void> {
    sealed = true;
    return persist(null);
}

let persistChain: Promise<void> = Promise.resolve();
let sealed = false;

async function persistNow(contents: string | null): Promise<void> {
    if (!inTauri()) return;
    if (sealed && contents !== null) return;
    try {
        const { BaseDirectory, exists, remove, writeTextFile } = await import(
            '@tauri-apps/plugin-fs'
        );
        if (contents === null) {
            const present = await exists(HANDOFF_FILENAME, { baseDir: BaseDirectory.AppLocalData });
            if (present) {
                await remove(HANDOFF_FILENAME, { baseDir: BaseDirectory.AppLocalData });
            }
        } else {
            await writeTextFile(HANDOFF_FILENAME, contents, {
                baseDir: BaseDirectory.AppLocalData,
            });
        }
    } catch (error) {
        console.error('Failed to write MCP handoff:', error);
        return;
    }
    notifyHandoffChanged();
}

/**
 * Tell the Agents panel the file changed. `globalThis` instead of `window`
 * so this module still typechecks under the MCP Node tsconfig (no DOM lib).
 */
function notifyHandoffChanged(): void {
    const host = globalThis as {
        Event?: new (type: string) => object;
        dispatchEvent?: (event: object) => void;
    };
    if (typeof host.Event !== 'function' || typeof host.dispatchEvent !== 'function') return;
    host.dispatchEvent(new host.Event('mcpHandoffChanged'));
}

function persist(contents: string | null): Promise<void> {
    persistChain = persistChain.then(
        () => persistNow(contents),
        () => persistNow(contents),
    );
    return persistChain;
}
