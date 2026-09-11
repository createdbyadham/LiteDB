// What the server was told to connect to, and how much latitude it has.
//
// Everything arrives as environment variables because that is what MCP hosts
// can actually set: a `claude_desktop_config.json` entry has a command, args
// and an env map, and nothing else. No config file to find, no state to carry
// between runs.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { postgresConnectionId, sqliteConnectionId } from '../../src/lib/connectionId';
import type { SqlDialect } from '../../src/lib/schemaTypes';
import type { SafetyPolicy } from '../../src/lib/sqlPolicy';

/** Bundle identifier from src-tauri/tauri.conf.json. Keep the two in step. */
const APP_IDENTIFIER = 'com.adhamehab.litedb';

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
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

function parsePolicy(raw: string | undefined): SafetyPolicy {
    // Read-only by default, which is the opposite of the app's `guarded`
    // default and deliberately so: the app's first job is editing tables, and
    // there is a person in front of it. Here the caller is a model, the
    // session may be unattended, and the safe default costs one environment
    // variable to change.
    if (!raw) return 'read-only';
    const value = raw.trim().toLowerCase();
    if (value === 'yolo') {
        throw new ConfigError(
            'LITEDB_POLICY=yolo is not available over MCP. YOLO mode exists in the ' +
                'desktop app behind a confirmation and a visible banner, with someone ' +
                'at the keyboard; neither is true of a server. Use "unrestricted" if ' +
                'you want writes to need only one approval instead of two.',
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const databaseUrl = env.LITEDB_DATABASE_URL?.trim();
    const sqlitePath = env.LITEDB_SQLITE_PATH?.trim();

    if (databaseUrl && sqlitePath) {
        throw new ConfigError(
            'Set either LITEDB_DATABASE_URL or LITEDB_SQLITE_PATH, not both. ' +
                'One server, one database.',
        );
    }
    if (!databaseUrl && !sqlitePath) {
        throw new ConfigError(
            'No database configured. Set LITEDB_SQLITE_PATH to a .sqlite/.db file, ' +
                'or LITEDB_DATABASE_URL to a postgres:// connection string.',
        );
    }

    const shared = {
        policy: parsePolicy(env.LITEDB_POLICY),
        maxRows: parseMaxRows(env.LITEDB_MAX_ROWS),
        auditPath: env.LITEDB_AUDIT_PATH?.trim() || defaultAuditPath(env),
        embeddingModelId: env.LITEDB_EMBEDDING_MODEL?.trim() || 'minilm',
        modelCachePath: env.LITEDB_EMBEDDING_CACHE?.trim() || defaultModelCachePath(env),
    };

    if (databaseUrl) {
        return {
            ...shared,
            dialect: 'postgres',
            target: databaseUrl,
            connectionId: describePostgres(databaseUrl),
        };
    }

    return {
        ...shared,
        dialect: 'sqlite',
        target: sqlitePath as string,
        connectionId: sqliteConnectionId(sqlitePath),
    };
}
