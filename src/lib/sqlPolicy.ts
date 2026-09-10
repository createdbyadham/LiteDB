// Decides whether a script runs, needs approval, or is refused.
//
// The product insight this file encodes: **provenance is part of the risk**. A
// DELETE the user typed and a DELETE a language model wrote are the same SQL
// and not the same event. The user's DELETE expresses an intention the user
// already had. The model's DELETE expresses an intention the model inferred
// from a sentence, using a schema summary, at temperature 0, with a measured
// error rate this repo publishes — 86.4% execution accuracy for a 7B local
// model on read-only SELECTs, which is the *easy* case.
//
// So `unrestricted` is a promise the user makes about their own typing. It
// does not extend to generated SQL, which is floored at `guarded` no matter
// what the connection is set to. That floor is the reason to run a model
// through LiteDB rather than pointing it at a raw connection string.
//
// `yolo` is the deliberate exception, and the only policy that waives the
// floor. It is a separate mode rather than the removal of the floor from
// `unrestricted` precisely so that "my writes run free" and "the model's
// writes run free" stay separate decisions — the first is a reasonable
// everyday setting, the second is not.
//
// Kept free of browser, Tauri and network imports: the eval harness and the
// desktop app must apply identical rules, and persistence lives in
// queryGate.ts.

import {
    classifyScript,
    effectiveKind,
    KIND_SEVERITY,
    type StatementClassification,
    type StatementKind,
} from './sqlClassifier';

export type SafetyPolicy =
    /** Reads only. Anything that changes state is refused outright. */
    | 'read-only'
    /** Reads run; everything else needs explicit approval. The default. */
    | 'guarded'
    /** Your statements run unattended. Generated SQL still asks. */
    | 'unrestricted'
    /**
     * Nothing asks, nothing is refused, and the model executes its own SQL
     * the moment it writes it — no review, no row count, no undo.
     *
     * This exists because the alternative to an escape hatch is people
     * working around the tool, and because on a scratch database the prompts
     * are pure friction. It is opt-in per connection behind a confirmation,
     * flagged in the status bar for as long as it is on, and every statement
     * is still written to the audit log. That log is the only safeguard left
     * in this mode, which is exactly why it stays.
     */
    | 'yolo';

export type Provenance =
    /** The user typed or pasted it. */
    | 'user'
    /** A language model wrote it. */
    | 'ai';

export const DEFAULT_POLICY: SafetyPolicy = 'guarded';

/**
 * The most permissive policy generated SQL may run under, regardless of the
 * connection's setting. Raising a connection to `unrestricted` speeds up your
 * own work; it does not hand that latitude to the model.
 */
export const AI_POLICY_FLOOR: SafetyPolicy = 'guarded';

const POLICY_RANK: Record<SafetyPolicy, number> = {
    'read-only': 0,
    guarded: 1,
    unrestricted: 2,
    yolo: 3,
};

/** The stricter of two policies. */
export function strictest(a: SafetyPolicy, b: SafetyPolicy): SafetyPolicy {
    return POLICY_RANK[a] <= POLICY_RANK[b] ? a : b;
}

export type GateAction =
    /** Run it. */
    | 'allow'
    /** Run it only after the user approves the impact preview. */
    | 'confirm'
    /** Refuse. The policy forbids it; approval is not offered. */
    | 'block';

export interface GateDecision {
    action: GateAction;
    /** Risk level the script was gated at. Never 'unknown' — see effectiveKind. */
    kind: Exclude<StatementKind, 'unknown'>;
    /** The statement that set `kind`, for the dialog headline. */
    worst: StatementClassification | null;
    /** Every statement in the script, in order, for the dialog's list. */
    statements: StatementClassification[];
    /** Plain-language justification, shown to the user verbatim. */
    reason: string;
    /**
     * Whether approval requires typing the target's name rather than clicking
     * a button. Reserved for statements that destroy data without a predicate
     * bounding them — the class where a mis-click is unrecoverable.
     */
    requireTypedConfirmation: boolean;
    /** The policy actually applied, after the AI floor. */
    appliedPolicy: SafetyPolicy;
}

const KIND_LABEL: Record<Exclude<StatementKind, 'unknown'>, string> = {
    read: 'read',
    session: 'session change',
    ddl: 'schema change',
    write: 'write',
    destructive: 'destructive statement',
};

/**
 * Evaluate a script against a policy.
 *
 * Pure and synchronous. It decides *what should happen*; running the impact
 * preview and collecting the user's answer belong to the caller.
 */
export function evaluateScript(
    script: string,
    connectionPolicy: SafetyPolicy,
    provenance: Provenance,
): GateDecision {
    const { statements, kind, worst } = classifyScript(script);
    // YOLO opts out of the floor. Every other policy applies it to generated
    // SQL: raising a connection to `unrestricted` speeds up your own work
    // without handing that latitude to the model.
    const appliedPolicy =
        provenance === 'ai' && connectionPolicy !== 'yolo'
            ? strictest(connectionPolicy, AI_POLICY_FLOOR)
            : connectionPolicy;

    const shared = { kind, worst, statements, appliedPolicy };
    const authored = provenance === 'ai' ? 'Generated SQL' : 'This script';

    if (statements.length === 0) {
        return {
            ...shared,
            action: 'block',
            reason: 'No executable statement found.',
            requireTypedConfirmation: false,
        };
    }

    // Deliberately below the empty-statement check and above everything
    // else: YOLO waives every rule about what a statement may do, but there
    // still has to be a statement.
    if (appliedPolicy === 'yolo') {
        return {
            ...shared,
            action: 'allow',
            reason: 'YOLO mode: every statement runs unreviewed.',
            requireTypedConfirmation: false,
        };
    }

    if (kind === 'read') {
        return {
            ...shared,
            action: 'allow',
            reason: 'Reads only.',
            requireTypedConfirmation: false,
        };
    }

    if (appliedPolicy === 'read-only') {
        const floored = provenance === 'ai' && connectionPolicy !== 'read-only';
        return {
            ...shared,
            action: 'block',
            reason:
                `${authored} contains a ${KIND_LABEL[kind]} and this connection is read-only. ` +
                (floored
                    ? 'Generated SQL is never run unattended.'
                    : 'Switch the connection out of read-only mode to run it.'),
            requireTypedConfirmation: false,
        };
    }

    if (appliedPolicy === 'unrestricted') {
        // Only reachable for user-authored SQL: the AI floor is `guarded`.
        return {
            ...shared,
            action: 'allow',
            reason: 'This connection runs without approval prompts.',
            requireTypedConfirmation: false,
        };
    }

    // guarded
    const unbounded = statements.filter((s) => s.unbounded);
    const destructive = KIND_SEVERITY[kind] >= KIND_SEVERITY.destructive;

    return {
        ...shared,
        action: 'confirm',
        reason: worst
            ? `${authored} contains a ${KIND_LABEL[kind]}: ${worst.reason}.`
            : `${authored} changes the database.`,
        // Typed confirmation is reserved for the unbounded case. A bounded
        // DELETE shows a row count, which is a better safeguard than friction;
        // an unbounded one has no count to show short of the whole table.
        requireTypedConfirmation: destructive && unbounded.length > 0,
    };
}

/**
 * Whether a statement's impact can be counted exactly.
 *
 * Only bounded row changes can: the predicate that limits the write is the
 * same predicate that counts what it will hit. Anything without one falls back
 * to the planner's estimate.
 */
export function canPreviewExactly(statement: StatementClassification): boolean {
    return (
        statement.table !== null &&
        statement.predicate !== null &&
        (statement.verb === 'UPDATE' || statement.verb === 'DELETE') &&
        effectiveKind(statement.kind) === 'write'
    );
}
