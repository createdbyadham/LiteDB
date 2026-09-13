// What the server was told to connect to, and how much latitude it has.
//
// Two sources, in this order:
//
//   1. `LITEDB_DATABASE_URL` / `LITEDB_SQLITE_PATH`. The distributable shape:
//      `npx -y litedb-mcp` on a CI box, against a file, no LiteDB installed.
//      An MCP host can set environment variables and nothing else, so this is
//      what the published package has to honour.
//   2. The handoff file the desktop app writes when you connect. Same app-data
//      directory as the audit log. No env, no restart: switch database in the
//      app and the next tool call follows. Deleted when the app quits, so this
//      is the open connection, not the last one.
//
// Neither → an error that explains both, rather than a guess.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { postgresConnectionId, sqliteConnectionId } from '../../src/lib/connectionId';
import {
    HANDOFF_FILENAME,
    HandoffError,
    mcpPolicyFromApp,
    parseHandoff,
    postgresTarget,
} from '../../src/lib/mcpHandoff';
import type { SqlDialect } from '../../src/lib/schemaTypes';
import type { SafetyPolicy } from '../../src/lib/sqlPolicy';

/** Bundle identifier from src-tauri/tauri.conf.json. Keep the two in step. */
const APP_IDENTIFIER = 'com.adhamehab.litedb';

export class ConfigError extends Error {
    /**
     * Retryable errors clear themselves without restarting the server: open a
     * database in LiteDB, save an in-memory file, rewrite a damaged handoff.
     * Env conflicts do not — the process has to be relaunched with different
     * variables — so those fail startup.
     */
    readonly retryable: boolean;

    constructor(message: string, retryable = false) {
        super(message);
        this.name = 'ConfigError';
        this.retryable = retryable;
    }
}

export interface ServerConfig {
    dialect: SqlDialect;
    /** Postgres connection string, or an absolute path to a SQLite file. */
    target: string;
    /** Stable identity, shared with the desktop app. Never holds credentials. */
    connectionId: string;
    policy: SafetyPolicy;
    /** Hard cap on rows returned by one tool call. */
    maxRows: number;
    /** Where audit entries are appended. */
    auditPath: string;
    /** Which local embedding model semantic_search uses for text queries. */
    embeddingModelId: string;
    /** Directory the embedding model is downloaded to and reused from. */
    modelCachePath: string;
    /** Where the target came from. Controls the read-only refusal copy. */
    source: 'env' | 'handoff';
}

/** The desktop app's data directory, mirroring Tauri v2's `AppLocalData`. */
function appDataDir(env: NodeJS.ProcessEnv): string {
    const home = homedir();
    let base: string;
    if (process.platform === 'win32') {
        base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    } else if (process.platform === 'darwin') {
        base = join(home, 'Library', 'Application Support');
    } else {
        base = env.XDG_DATA_HOME || join(home, '.local', 'share');
    }
    return join(base, APP_IDENTIFIER);
}

/**
 * Where the desktop app keeps its audit log.
 *
 * The point of defaulting to the same file rather than a private one is that
 * the log then answers the question it exists for — "what has touched this
 * database?" — across both ways of reaching it. A statement an agent ran over
 * MCP shows up in the app's audit view next to the ones you ran yourself.
 */
export function defaultAuditPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(appDataDir(env), 'audit', 'sql-audit.jsonl');
}

/**
 * Where downloaded embedding models are kept.
 *
 * transformers.js would otherwise cache inside its own `node_modules`
 * directory, which a globally installed package has no business writing to and
 * which `npm update` would throw away. The app's data directory survives both.
 */
export function defaultModelCachePath(env: NodeJS.ProcessEnv = process.env): string {
    return join(appDataDir(env), 'models');
}

/**
 * Where the desktop app writes the currently-open connection.
 * Removed when the window closes, so this is "open now", not "last opened".
 */
export function defaultHandoffPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(appDataDir(env), HANDOFF_FILENAME);
}

export const NO_DATABASE_MESSAGE =
    'No database configured. Open a database in the LiteDB app — the agent ' +
    'follows whatever is connected — or set LITEDB_SQLITE_PATH to a .sqlite/.db ' +
    'file, or LITEDB_DATABASE_URL to a postgres:// connection string.';

export const IN_MEMORY_MESSAGE =
    'LiteDB has an in-memory SQLite database open. MCP talks to the file on ' +
    'disk, not the editor\'s copy — save the database to a file and reopen it.';

/**
 * Policies this server will run under.
 *
 * `yolo` is absent on purpose, and not for tidiness. In the desktop app it is
 * a mode you enter through a confirmation dialog, with a banner in the status
 * bar for as long as it is on and a human watching the window. Over MCP there
 * is no banner and nobody is necessarily watching, so the mode would be an
 * unattended agent with unlimited write access and a log nobody reads. The
 * escape hatch that makes sense at a keyboard does not survive the move to a
 * server, so it does not come along.
 */
const ALLOWED_POLICIES: SafetyPolicy[] = ['read-only', 'guarded', 'unrestricted'];

function parsePolicy(raw: string | undefined): SafetyPolicy | null {
    if (!raw) return null;
    const value = raw.trim().toLowerCase();
    if (value === 'yolo') {
        throw new ConfigError(
            'LITEDB_POLICY=yolo is not available over MCP. YOLO mode exists in the ' +
                'desktop app behind a confirmation and a visible banner, with someone ' +
                'at the keyboard; neither is true of a server. Use "unrestricted" if ' +
                'you want writes to need only one approval instead of two. If LiteDB ' +
                'is in YOLO, the handoff maps that down to guarded on its own — do ' +
                'not set the variable.',
        );
    }
    if (!ALLOWED_POLICIES.includes(value as SafetyPolicy)) {
        throw new ConfigError(
            `LITEDB_POLICY must be one of ${ALLOWED_POLICIES.join(', ')} (got "${raw}").`,
        );
    }
    return value as SafetyPolicy;
}

function parseMaxRows(raw: string | undefined): number {
    if (!raw) return 200;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new ConfigError(`LITEDB_MAX_ROWS must be a positive integer (got "${raw}").`);
    }
    return value;
}

/** Host, port and database from a Postgres URL, for the connection identity. */
function describePostgres(url: string): string {
    try {
        const parsed = new URL(url);
        return postgresConnectionId(
            parsed.hostname || 'localhost',
            parsed.port || 5432,
            decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres',
        );
    } catch {
        // A connection string pg accepts but URL does not (a bare keyword/value
        // DSN, say). Identity degrades; the connection still works.
        return 'postgres:unparsed';
    }
}

function readHandoffFile(path: string) {
    let contents: string;
    try {
        contents = readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ConfigError(
            `Could not read the LiteDB handoff file at ${path}: ` +
                (error instanceof Error ? error.message : String(error)) +
                '. Reconnect in the app to rewrite it.',
            true,
        );
    }
    try {
        return parseHandoff(contents);
    } catch (error) {
        const message = error instanceof HandoffError ? error.message : String(error);
        throw new ConfigError(message, true);
    }
}

function fromEnv(
    dialect: SqlDialect,
    target: string,
    connectionId: string,
    shared: Omit<ServerConfig, 'dialect' | 'target' | 'connectionId' | 'source' | 'policy'> & {
        policy: SafetyPolicy | null;
    },
): ServerConfig {
    return {
        dialect,
        target,
        connectionId,
        policy: shared.policy ?? 'read-only',
        maxRows: shared.maxRows,
        auditPath: shared.auditPath,
        embeddingModelId: shared.embeddingModelId,
        modelCachePath: shared.modelCachePath,
        source: 'env',
    };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const databaseUrl = env.LITEDB_DATABASE_URL?.trim();
    const sqlitePath = env.LITEDB_SQLITE_PATH?.trim();
    const envPolicy = parsePolicy(env.LITEDB_POLICY);

    if (databaseUrl && sqlitePath) {
        throw new ConfigError(
            'Set either LITEDB_DATABASE_URL or LITEDB_SQLITE_PATH, not both. ' +
                'One server, one database.',
        );
    }

    const shared = {
        policy: envPolicy,
        maxRows: parseMaxRows(env.LITEDB_MAX_ROWS),
        auditPath: env.LITEDB_AUDIT_PATH?.trim() || defaultAuditPath(env),
        embeddingModelId: env.LITEDB_EMBEDDING_MODEL?.trim() || 'minilm',
        modelCachePath: env.LITEDB_EMBEDDING_CACHE?.trim() || defaultModelCachePath(env),
    };

    if (databaseUrl) {
        return fromEnv('postgres', databaseUrl, describePostgres(databaseUrl), shared);
    }
    if (sqlitePath) {
        return fromEnv('sqlite', sqlitePath, sqliteConnectionId(sqlitePath), shared);
    }

    const handoffPath = env.LITEDB_HANDOFF_PATH?.trim() || defaultHandoffPath(env);
    const handoff = readHandoffFile(handoffPath);
    if (!handoff) {
        throw new ConfigError(NO_DATABASE_MESSAGE, true);
    }

    if (handoff.dialect === 'sqlite') {
        if (!handoff.sqlitePath) {
            throw new ConfigError(IN_MEMORY_MESSAGE, true);
        }
        return {
            dialect: 'sqlite',
            target: handoff.sqlitePath,
            connectionId: handoff.connectionId,
            policy: envPolicy ?? mcpPolicyFromApp(handoff.policy),
            maxRows: shared.maxRows,
            auditPath: shared.auditPath,
            embeddingModelId: shared.embeddingModelId,
            modelCachePath: shared.modelCachePath,
            source: 'handoff',
        };
    }

    if (!handoff.postgres) {
        throw new ConfigError(
            'LiteDB has Postgres open but the handoff file has no connection details. ' +
                'Reconnect from the app.',
            true,
        );
    }

    return {
        dialect: 'postgres',
        target: postgresTarget(handoff.postgres),
        connectionId: handoff.connectionId,
        policy: envPolicy ?? mcpPolicyFromApp(handoff.policy),
        maxRows: shared.maxRows,
        auditPath: shared.auditPath,
        embeddingModelId: shared.embeddingModelId,
        modelCachePath: shared.modelCachePath,
        source: 'handoff',
    };
}
