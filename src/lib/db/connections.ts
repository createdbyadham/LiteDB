// The databases open in this window, and which one is on screen.
//
// Several can be open at once, each with its own client. Switching between
// them does not reconnect. The active one is the one the safety layer, the
// status bar, Text to SQL and the MCP handoff all follow.

import { useSyncExternalStore } from 'react';
import { postgresConnectionId, sqliteConnectionId } from '@/lib/connectionId';
import { clearActiveConnection, setActiveConnection, setDefaultPolicy } from '@/lib/queryGate';
import type { HandoffPostgres } from '@/lib/mcpHandoff';
import { aiService, type DatabaseSchema, type TableSchema } from '@/lib/aiService';
import type { SqlDialect } from '@/lib/schemaTypes';
import type { TableInfo } from '@/lib/types';
import type { DbClient } from './client';
import { SqliteClient } from './sqliteClient';
import { PgClient, type VectorColumnInfo } from './pgClient';
import { dbClose, dbDataVersion, dbOpenPostgres, dbOpenSqlite, inTauri, type OpenInfo, type PgConnectConfig } from './native';
import { fileName, findSqliteConnection, saveConnection, touchConnection, type SavedConnection } from './savedConnections';

export interface OpenConnection {
    /** Runtime id in Rust. Also the key the safety policy is stored under. */
    id: string;
    profileId: string | null;
    name: string;
    color: string | null;
    production: boolean;
    dialect: SqlDialect;
    client: DbClient;
    info: OpenInfo;
    /** For the audit log and the status bar: `sqlite:file.db`, `postgres:host/db`. */
    label: string;
    /** The path, or user@host:port/db. */
    detail: string;
    tables: TableInfo[];
    /** Postgres: the schema shown in the sidebar, or 'all'. */
    schemaFilter: string;
    hasPgVector: boolean;
    vectorColumns: VectorColumnInfo[];
    /** Postgres: where an agent connects, through the tunnel if there is one. */
    handoff: HandoffPostgres | null;
    /** The editor left a transaction open on this connection. */
    inTransaction: boolean;
}

export interface ConnectMeta {
    profileId: string | null;
    name: string;
    color: string | null;
    production: boolean;
}

interface State {
    connections: OpenConnection[];
    activeId: string | null;
}

let state: State = { connections: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: State): void {
    state = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getConnectionsState(): State {
    return state;
}

export function useConnections(): State {
    return useSyncExternalStore(subscribe, getConnectionsState);
}

export function activeOpenConnection(): OpenConnection | null {
    return state.connections.find((c) => c.id === state.activeId) ?? null;
}

export function useActiveConnection(): OpenConnection | null {
    const current = useConnections();
    return current.connections.find((c) => c.id === current.activeId) ?? null;
}

export function getOpenConnection(id: string): OpenConnection | undefined {
    return state.connections.find((c) => c.id === id);
}

function patch(id: string, changes: Partial<OpenConnection>): void {
    emit({
        ...state,
        connections: state.connections.map((c) => (c.id === id ? { ...c, ...changes } : c)),
    });
}

/** The tables the sidebar, the schema view and Text to SQL show. */
export function visibleTables(conn: OpenConnection): TableInfo[] {
    if (conn.dialect !== 'postgres' || conn.schemaFilter === 'all') return conn.tables;
    return conn.tables.filter((t) => t.schema === conn.schemaFilter);
}

/** Schemas that have at least one table, default schema first. */
export function schemasWithTables(conn: OpenConnection): string[] {
    const seen: string[] = [];
    for (const t of conn.tables) if (t.schema && !seen.includes(t.schema)) seen.push(t.schema);
    return seen;
}

async function pushSchemaToAi(conn: OpenConnection): Promise<void> {
    try {
        const tables = visibleTables(conn);
        const schemas: TableSchema[] = [];
        for (const t of tables) {
            const columns = await conn.client.getColumns(t.name);
            schemas.push({
                name: t.name,
                columns: columns.map((c) => ({
                    name: c.name,
                    type: c.type,
                    isPrimaryKey: c.pk > 0,
                    isNotNull: c.notnull === 1,
                })),
            });
        }
        if (state.activeId !== conn.id) return;
        const schema: DatabaseSchema = { dialect: conn.dialect, tables: schemas };
        await aiService.setSchemaWithSamples(schema, async (sql) => {
            try {
                return (await conn.client.query(sql)).rows;
            } catch {
                return null;
            }
        });
    } catch {
        // Best effort: Text to SQL still works from table names alone.
    }
}

// --- external changes --------------------------------------------------------

let watchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * SQLite's data_version moves when another connection writes the file, an
 * agent through MCP, or the user's own program. The grid listens for this to
 * reload without being asked. Our own writes do not move it.
 */
function restartWatch(): void {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    const conn = activeOpenConnection();
    if (!conn || conn.dialect !== 'sqlite' || !inTauri()) return;
    let last: number | null = null;
    watchTimer = setInterval(() => {
        void dbDataVersion(conn.id)
            .then((version) => {
                if (version === null) return;
                if (last !== null && version !== last) {
                    window.dispatchEvent(new CustomEvent('dbExternalChange', { detail: { id: conn.id } }));
                }
                last = version;
            })
            .catch(() => undefined);
    }, 1500);
}

function applyActive(): void {
    const conn = activeOpenConnection();
    restartWatch();
    if (!conn) {
        clearActiveConnection();
        aiService.clearSchema();
        return;
    }
    setActiveConnection({
        id: conn.id,
        label: conn.label,
        dialect: conn.dialect,
        sqlitePath: conn.dialect === 'sqlite' ? conn.detail : undefined,
        postgres: conn.handoff ?? undefined,
        production: conn.production,
    });
    void pushSchemaToAi(conn);
}

export function activateConnection(id: string): void {
    if (!state.connections.some((c) => c.id === id) || state.activeId === id) return;
    emit({ ...state, activeId: id });
    applyActive();
}

function add(conn: OpenConnection): void {
    // Read-only by default when tagged production, or when the file or role
    // refuses writes anyway, so the status bar says what will happen.
    setDefaultPolicy(conn.id, conn.production || conn.info.readOnly ? 'read-only' : null);
    emit({ connections: [...state.connections, conn], activeId: conn.id });
    applyActive();
}

export async function openSqliteFile(
    path: string,
    options: { create?: boolean; profile?: SavedConnection } = {},
): Promise<OpenConnection> {
    const id = sqliteConnectionId(path);
    const existing = getOpenConnection(id);
    if (existing) {
        activateConnection(id);
        return existing;
    }
    const info = await dbOpenSqlite(id, path, options.create ?? false);
    const client = new SqliteClient(id, id, path);
    try {
        await client.refreshTables();
    } catch (error) {
        await dbClose(id).catch(() => undefined);
        throw error;
    }
    const profile =
        options.profile ??
        findSqliteConnection(path) ??
        (await saveConnection({ name: fileName(path), color: null, production: false, kind: 'sqlite', path }));
    touchConnection(profile.id);

    const conn: OpenConnection = {
        id,
        profileId: profile.id,
        name: profile.name,
        color: profile.color,
        production: profile.production,
        dialect: 'sqlite',
        client,
        info,
        label: `sqlite:${fileName(path)}`,
        detail: path,
        tables: client.tables,
        schemaFilter: 'all',
        hasPgVector: false,
        vectorColumns: [],
        handoff: null,
        inTransaction: false,
    };
    add(conn);
    return conn;
}

/** Open a connection under a throwaway id and close it again. */
export async function testPostgres(config: PgConnectConfig): Promise<OpenInfo> {
    const id = `test:${Date.now().toString(36)}`;
    const info = await dbOpenPostgres(id, config);
    await dbClose(id).catch(() => undefined);
    return info;
}

export async function openPostgres(config: PgConnectConfig, meta: ConnectMeta): Promise<OpenConnection> {
    // Which database, never the password: policies and audit history follow
    // the database whichever role connects. On Supabase the project ref is
    // the only part of the username that matters; the role itself does not.
    const id = postgresConnectionId(config.host, config.port, config.database, config.username);
    const existing = getOpenConnection(id);
    if (existing) {
        activateConnection(id);
        return existing;
    }
    const info = await dbOpenPostgres(id, config);
    const client = new PgClient(id, id);
    try {
        await client.init();
        await client.refreshTables();
        await client.refreshVectorSupport();
    } catch (error) {
        await dbClose(id).catch(() => undefined);
        throw error;
    }
    if (meta.profileId) touchConnection(meta.profileId);

    const sslMode = config.sslMode ?? 'disable';
    const tunneled = !!config.ssh?.host;
    const handoff: HandoffPostgres = {
        host: info.agentHost ?? config.host,
        port: info.agentPort ?? config.port,
        database: config.database,
        username: config.username,
        password: config.password,
        ssl: sslMode !== 'disable',
        sslMode: tunneled && sslMode === 'verify-full' ? 'verify-ca' : sslMode,
        ...(config.sslRootCert ? { sslRootCert: config.sslRootCert } : {}),
    };
    const hasDefault = client.tables.some((t) => t.schema === client.defaultSchema);
    const conn: OpenConnection = {
        id,
        profileId: meta.profileId,
        name: meta.name || `${config.database} on ${config.host}`,
        color: meta.color,
        production: meta.production,
        dialect: 'postgres',
        client,
        info,
        label: `postgres:${config.host}/${config.database}`,
        detail: `${config.username}@${config.host}:${config.port}/${config.database}${tunneled ? ` via ${config.ssh!.host}` : ''}`,
        tables: client.tables,
        schemaFilter: hasDefault ? client.defaultSchema : 'all',
        hasPgVector: client.hasPgVector,
        vectorColumns: client.vectorColumns,
        handoff,
        inTransaction: false,
    };
    add(conn);
    return conn;
}

export async function closeConnection(id: string): Promise<void> {
    const conn = getOpenConnection(id);
    if (!conn) return;
    const remaining = state.connections.filter((c) => c.id !== id);
    const activeId = state.activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : state.activeId;
    emit({ connections: remaining, activeId });
    applyActive();
    await conn.client.close().catch(() => undefined);
}

export async function refreshConnectionTables(id: string): Promise<void> {
    const conn = getOpenConnection(id);
    if (!conn) return;
    await conn.client.refreshTables();
    if (conn.client instanceof PgClient) await conn.client.refreshVectorSupport();
    const client = conn.client;
    patch(id, {
        tables: client.tables,
        hasPgVector: client instanceof PgClient ? client.hasPgVector : false,
        vectorColumns: client instanceof PgClient ? client.vectorColumns : [],
    });
    const updated = getOpenConnection(id);
    if (updated && state.activeId === id) void pushSchemaToAi(updated);
}

export function setSchemaFilter(id: string, schemaFilter: string): void {
    patch(id, { schemaFilter });
    const updated = getOpenConnection(id);
    if (updated && state.activeId === id) void pushSchemaToAi(updated);
}

export function setInTransaction(id: string, inTransaction: boolean): void {
    const conn = getOpenConnection(id);
    if (conn && conn.inTransaction !== inTransaction) patch(id, { inTransaction });
}

/** Name, colour and the production tag changed in the editor while open. */
export function updateOpenConnectionMeta(profileId: string, meta: { name: string; color: string | null; production: boolean }): void {
    for (const conn of state.connections) {
        if (conn.profileId !== profileId) continue;
        setDefaultPolicy(conn.id, meta.production || conn.info.readOnly ? 'read-only' : null);
        patch(conn.id, meta);
        if (state.activeId === conn.id) applyActive();
    }
}
