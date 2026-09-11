// Holds a write between being previewed and being run.
//
// In the desktop app, approving a write is one uninterrupted act: the dialog
// opens, the user reads the row count, the user clicks. Over MCP that act
// splits in two — `query` returns a preview and stops, and a later
// `execute_approved` runs it — with an unknown amount of time, and an
// arbitrary amount of model reasoning, in between. This module is the gap.
//
// Three properties the gap has to have, all of them because the thing holding
// the token is the same model whose SQL is being gated:
//
//   * The SQL is stored here, not echoed back and re-submitted.
//     `execute_approved` takes a token and nothing else, so there is no
//     argument through which a different statement could arrive. What runs is
//     byte-for-byte what was previewed — not a paraphrase of it, and not a
//     second statement appended to it.
//   * One use. A token is removed when claimed, so an approval for one DELETE
//     cannot become an approval for that DELETE three times.
//   * A deadline. An approval is about a database in a particular state, and
//     the row count that justified it goes stale. After TTL_MS the token is
//     gone and the preview has to be taken again.

import { randomUUID } from 'node:crypto';
import type { ImpactEstimate } from '../../src/lib/impactPreview';
import type { GateDecision } from '../../src/lib/sqlPolicy';

/**
 * How long a preview stands.
 *
 * Five minutes is long enough for a model to think, ask the user, and come
 * back, and short enough that the row count it reported is probably still
 * true. It is not a security boundary — it is an expiry on a claim about the
 * data.
 */
export const TTL_MS = 5 * 60 * 1000;

/** Cap on outstanding approvals, so a chatty client cannot grow the process. */
const MAX_PENDING = 32;

export interface PendingApproval {
    token: string;
    /** Exactly what was previewed, and exactly what will run. */
    sql: string;
    decision: GateDecision;
    estimates: ImpactEstimate[];
    createdAt: number;
}

const pending = new Map<string, PendingApproval>();

function sweep(now: number): void {
    for (const [token, approval] of pending) {
        if (now - approval.createdAt > TTL_MS) pending.delete(token);
    }
}

export function create(
    sql: string,
    decision: GateDecision,
    estimates: ImpactEstimate[],
    now = Date.now(),
): PendingApproval {
    sweep(now);
    // Oldest first, so a flood of proposals evicts stale ones rather than
    // being refused. Nothing is lost that a second `query` cannot recreate.
    while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
    }

    const approval: PendingApproval = {
        token: randomUUID(),
        sql,
        decision,
        estimates,
        createdAt: now,
    };
    pending.set(approval.token, approval);
    return approval;
}

export class UnknownApprovalError extends Error {
    constructor() {
        super(
            'No pending approval with that token. It was already used, it expired ' +
                `after ${TTL_MS / 60000} minutes, or it was never issued. Call query ` +
                'again to take a fresh preview.',
        );
        this.name = 'UnknownApprovalError';
    }
}

/** Take an approval out of the store. Succeeds at most once per token. */
export function claim(token: string, now = Date.now()): PendingApproval {
    sweep(now);
    const approval = pending.get(token);
    if (!approval) throw new UnknownApprovalError();
    pending.delete(token);
    return approval;
}

/** Outstanding approvals. Exists for the self-test and for diagnostics. */
export function size(): number {
    return pending.size;
}

/** Drop everything. Used between self-test cases. */
export function reset(): void {
    pending.clear();
}
