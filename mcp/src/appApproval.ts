// Asking the LiteDB window before an agent's write runs, from the npm server.
//
// The protocol and its limits are in src/lib/agentApproval.ts, and the request
// itself is built in approvalRequest.ts. This is the file transport: write the
// request where the app watches, then wait for the decision file it writes
// back.
//
// One call waits at most `approvalWaitMs`. If the person has not answered by
// then, execute_approved says so and leaves both the token and the request in
// place, and the agent calls again. That keeps every call under the request
// timeout MCP clients enforce, without a long-running call the host may cut.

import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    decisionFileName,
    parseDecision,
    requestFileName,
    serializeRequest,
    type ApprovalAnswer,
} from '../../src/lib/agentApproval';
import { buildRequest, type AppAnswer, type RequestContext } from './approvalRequest';
import type { PendingApproval } from './approvals';
import { DEFAULT_APPROVAL_WAIT_MS } from './toolConfig';

export type { AppAnswer } from './approvalRequest';

const POLL_MS = 200;

interface AskContext extends RequestContext {
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
