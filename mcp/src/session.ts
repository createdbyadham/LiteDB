// Live connection the tools consult on every call.
//
// Env-configured servers are a fixed target and could open once at startup.
// The handoff path cannot: the app may switch database or policy between
// tool calls, and "the agent follows, no restart" is the whole point of
// writing the file. Re-resolving here is what makes that true.
//
// Approvals are keyed to a connection id *and* the live target, so a token
// issued against shop.db cannot execute against the file you opened next,
// and a preview as user A cannot run as user B on the same host/database.
//
// Reconnects are serialised. MCP hosts overlap tool calls; two opens of the
// same fingerprint would leak a client and two opens of different ones would
// run SQL against two databases in one process.

import { installAudit } from './audit';
import { loadConfig } from './config';
import { openDatabase, type Database } from './db';
import type { ToolContext } from './tools/query';

export class LiveSession {
    private db: Database | null = null;
    private fingerprint = '';
    private chain: Promise<void> = Promise.resolve();

    async context(): Promise<ToolContext> {
        const run = this.chain.then(() => this.contextLocked(), () => this.contextLocked());
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async drop(): Promise<void> {
        if (!this.db) return;
        const db = this.db;
        this.db = null;
        this.fingerprint = '';
        try {
            await db.close();
        } catch {
            // Already gone.
        }
    }

    private async contextLocked(): Promise<ToolContext> {
        let config;
        try {
            config = loadConfig();
        } catch (error) {
            await this.drop();
            throw error;
        }

        const fingerprint = `${config.dialect}\0${config.target}\0${config.policy}`;
        let db = this.db;
        if (!db || this.fingerprint !== fingerprint) {
            const next = await openDatabase(config);
            const previous = db;
            this.db = next;
            this.fingerprint = fingerprint;
            db = next;
            if (previous) {
                try {
                    await previous.close();
                } catch {
                    // Replaced. A failure to close the old handle must not
                    // fail the new query.
                }
            }
        }

        installAudit({
            connection: config.connectionId,
            dialect: config.dialect,
            policy: config.policy,
            path: config.auditPath,
        });
        return { db, config };
    }

    async close(): Promise<void> {
        const run = this.chain.then(() => this.drop(), () => this.drop());
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        await run;
    }
}
