// The Tauri commands that reach the database (src-tauri/src/db).
//
// Everything that talks to SQLite or Postgres goes through `dbRun`. Results
// arrive as rows of arrays — objects keyed by column name lost one of two
// columns that shared a name, which every join on `id` does.

import { invoke } from '@tauri-apps/api/core';
import type { SslMode } from './pgUrl';
import { OmittedBlob } from './blob';

export interface RunOptions {
    /** Rows kept per result set. Beyond this the result is marked truncated. */
    maxRows?: number;
    /** Lets `dbCancel` stop this run. */
    queryId?: string;
    /** One transaction around every statement, rolled back on the first error. */
    transaction?: boolean;
    /** Keep going after a failed statement (ignored inside a transaction). */
    continueOnError?: boolean;
    /** Ask the server to stop once `maxRows` is reached (single statements). */
    stopAtLimit?: boolean;
    /** Blobs whole rather than as a size. */
    fullBlobs?: boolean;
    /** Postgres: run on the editor's own session, where BEGIN outlives the run. */
    session?: boolean;
    /** Change nothing whatever the SQL says. For agents' reads; see src-tauri/src/db. */
    readOnly?: boolean;
}

export interface StatementResult {
    /** Index into the statements that were sent. */
    statement: number;
    columns: string[];
    columnTypes: string[];
    rows: unknown[][];
    /** Whether the statement produces a result set, even an empty one. */
    returnsRows: boolean;
    rowsAffected: number;
    truncated: boolean;
    elapsedMs: number;
}

export interface RunError {
    statement: number;
    message: string;
    code: string | null;
    cancelled: boolean;
    /** 1-based character offset in the statement (Postgres). */
    position: number | null;
}

export interface RunResponse {
    results: StatementResult[];
    errors: RunError[];
    rolledBack: boolean;
    /** A transaction the user opened is still open on this connection. */
    inTransaction: boolean;
    elapsedMs: number;
}

export interface OpenInfo {
    id: string;
    engine: 'sqlite' | 'postgres';
    serverVersion: string;
    readOnly: boolean;
    /** Where an agent should connect: the SSH tunnel's local end when there is one. */
    agentHost: string | null;
    agentPort: number | null;
    notices: string[];
}

export interface SshSettings {
    host: string;
    port: number;
    username: string;
    auth: 'password' | 'key' | 'agent';
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
}

export interface PgConnectConfig {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    sslMode?: SslMode;
    sslRootCert?: string;
    ssh?: SshSettings | null;
}

export { OmittedBlob };

/** Raised when a single query fails. Carries what the engine said. */
export class QueryError extends Error {
    readonly code: string | null;
    readonly position: number | null;
    readonly cancelled: boolean;
    constructor(error: RunError) {
        super(error.message);
        this.name = 'QueryError';
        this.code = error.code;
        this.position = error.position;
        this.cancelled = error.cancelled;
    }
}

function decodeBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function isBlobEnvelope(value: unknown): value is { $blob: string | null; size: number } {
    return (
        typeof value === 'object' &&
        value !== null &&
        '$blob' in value &&
        'size' in value &&
        Object.keys(value).length === 2
    );
}

/** Blobs travel as `{ $blob, size }`; the rest of the app expects bytes. */
export function decodeCell(value: unknown): unknown {
    if (!isBlobEnvelope(value)) return value;
    return value.$blob === null ? new OmittedBlob(value.size) : decodeBase64(value.$blob);
}

function decodeResponse(response: RunResponse): RunResponse {
    for (const result of response.results) {
        for (const row of result.rows) {
            for (let i = 0; i < row.length; i++) {
                const cell = row[i];
                if (cell !== null && typeof cell === 'object') row[i] = decodeCell(cell);
            }
        }
    }
    return response;
}

export function inTauri(): boolean {
    return '__TAURI_INTERNALS__' in globalThis;
}

/** `readOnly` opens a connection that cannot write at all, for agents' reads. */
export async function dbOpenSqlite(id: string, path: string, create = false, readOnly = false): Promise<OpenInfo> {
    return invoke<OpenInfo>('db_open_sqlite', { id, path, create, readOnly });
}

export async function dbOpenPostgres(id: string, config: PgConnectConfig): Promise<OpenInfo> {
    return invoke<OpenInfo>('db_open_postgres', { id, config });
}

export async function dbClose(id: string): Promise<void> {
    await invoke('db_close', { id });
}

export async function dbRun(
    id: string,
    statements: string[],
    options: RunOptions = {},
): Promise<RunResponse> {
    const response = await invoke<RunResponse>('db_run', { id, statements, options });
    return decodeResponse(response);
}

export async function dbCancel(queryId: string): Promise<boolean> {
    return invoke<boolean>('db_cancel', { queryId });
}

export async function dbDataVersion(id: string): Promise<number | null> {
    return invoke<number | null>('db_data_version', { id });
}

let queryCounter = 0;
export function newQueryId(): string {
    queryCounter += 1;
    return `q${Date.now().toString(36)}${queryCounter}`;
}
