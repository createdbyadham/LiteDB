// What the tools need to know about the connection they serve.
//
// The npm server reads it from the environment or the handoff file (config.ts,
// which adds what only that server needs); the desktop app builds it from the
// connection it has open. Kept free of Node so the app can serve the same
// tools.

import type { SqlDialect } from '../../src/lib/schemaTypes';
import type { SafetyPolicy } from '../../src/lib/sqlPolicy';
import type { DirectWrites } from './directWrites';

export interface ToolConfig {
    dialect: SqlDialect;
    /**
     * The live target: a SQLite path, or whatever names the Postgres login.
     * Approvals are bound to it, so a token issued as one role cannot run as
     * another on the same database.
     */
    target: string;
    /** Stable identity, shared with the desktop app. Never holds credentials. */
    connectionId: string;
    policy: SafetyPolicy;
    /** Hard cap on rows returned by one tool call. */
    maxRows: number;
    /** Which local embedding model semantic_search uses for text queries. */
    embeddingModelId: string;
    /**
     * Directory the embedding model is downloaded to and reused from. Unset in
     * the app, where the webview's own cache keeps it.
     */
    modelCachePath?: string;
    /**
     * Writes small enough to run without asking (directWrites.ts). Null or
     * absent: every write waits for approval.
     */
    directWrites?: DirectWrites | null;
}

/**
 * How long execute_approved waits on the window before answering "still
 * waiting". Under the 60-second request timeout most MCP clients use, so the
 * call comes back on its own instead of being cut off.
 */
export const DEFAULT_APPROVAL_WAIT_MS = 50_000;
