// Asking the LiteDB window before an agent's write runs.
//
// The protocol and its limits are in src/lib/agentApproval.ts. This is the
// server's half: write the request, with the row count and a sample of the
// rows it changes, then wait for the decision file the window writes back.
//
// One call waits at most `approvalWaitMs`. If the person has not answered by
// then, execute_approved says so and leaves both the token and the request in
// place, and the agent calls again. That keeps every call under the request
// timeout MCP clients enforce, without a long-running call the host may cut.

import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    buildDiffQuery,
    decisionFileName,
    parseDecision,
    REQUEST_VERSION,
    requestFileName,
    serializeRequest,
    shapeDiff,
    type ApprovalAnswer,
    type ApprovalDiff,
    type ApprovalRequest,
} from '../../src/lib/agentApproval';
import type { StatementClassification } from '../../src/lib/sqlClassifier';
import { TTL_MS, type PendingApproval } from './approvals';
import { currentClient } from './audit';
import { DEFAULT_APPROVAL_WAIT_MS } from './config';
import type { Database } from './db';

const POLL_MS = 200;

export type AppAnswer = ApprovalAnswer | 'waiting';

interface AskContext {
    db: Database;
    config: { connectionId: string; approvalsDir?: string | null; approvalWaitMs?: number };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function present(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** The rows a statement would change, read-only. A failure is shown, not thrown. */
async function sampleRows(db: Database, statement: StatementClassification): Promise<ApprovalDiff | null> {
    const query = buildDiffQuery(statement);
    if (!query) return null;
    try {
        return shapeDiff(query, await db.read(query.sql));
    } catch (error) {
        return {
            mode: query.mode,
            columns: [],
            rows: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function buildRequest(ctx: AskContext, approval: PendingApproval): Promise<ApprovalRequest> {
    const { decision, estimates } = approval;
    const statements = [];
    for (const statement of decision.statements) {
        const estimate = estimates.find((e) => e.statement === statement);
        statements.push({
            sql: statement.sql,
            kind: statement.kind,
            verb: statement.verb,
            table: statement.table,
            unbounded: statement.unbounded,
            reason: statement.reason,
            affectedRows: estimate?.exactRows ?? null,
            estimatedRows: estimate?.estimatedRows ?? null,
            tableRows: estimate?.tableRows ?? null,
            tableRowsCapped: estimate?.tableRowsCapped ?? false,
            diff: statement.kind === 'read' ? null : await sampleRows(ctx.db, statement),
        });
    }
    return {
        version: REQUEST_VERSION,
        token: approval.token,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(approval.createdAt + TTL_MS).toISOString(),
        client: currentClient(),
        connection: ctx.config.connectionId,
        connectionId: ctx.config.connectionId,
        dialect: ctx.db.dialect,
        policy: decision.appliedPolicy,
        reason: decision.reason,
        destructive: decision.kind === 'destructive',
        requireTypedConfirmation: decision.requireTypedConfirmation,
        confirmPhrase: decision.worst?.table ?? decision.worst?.verb ?? 'RUN',
        statements,
    };
}

async function readAnswer(path: string, token: string): Promise<ApprovalAnswer | null> {
    try {
        return parseDecision(await readFile(path, 'utf8'), token)?.decision ?? null;
    } catch {
        return null;
    }
}

/**
 * Put `approval` in front of the person at the LiteDB window and wait for
 * their answer, up to the configured wait. A repeat call for the same token
 * keeps waiting on the request already on screen.
 */
export async function askApp(ctx: AskContext, approval: PendingApproval): Promise<AppAnswer> {
    const dir = ctx.config.approvalsDir;
    if (!dir) return 'approved';
    const requestPath = join(dir, requestFileName(approval.token));
    const decisionPath = join(dir, decisionFileName(approval.token));

    await mkdir(dir, { recursive: true });
    if (!(await present(requestPath))) {
        const request = await buildRequest(ctx, approval);
        // Written whole, then renamed: the window never reads half a request.
        const partial = `${requestPath}.partial`;
        await writeFile(partial, serializeRequest(request), 'utf8');
        await rename(partial, requestPath);
    }

    const deadline = Date.now() + (ctx.config.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS);
    for (;;) {
        const answer = await readAnswer(decisionPath, approval.token);
        if (answer) {
            await rm(requestPath, { force: true });
            await rm(decisionPath, { force: true });
            return answer;
        }
        const left = deadline - Date.now();
        if (left <= 0) return 'waiting';
        await sleep(Math.min(POLL_MS, left));
    }
}
