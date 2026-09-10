// The single place a statement passes through on its way to the database.
//
// Splitting the safety layer across the call sites that execute SQL is how it
// stops being a safety layer: one new call site added later, and the guarantee
// silently narrows. So this module owns three things that used to be nowhere —
// which connection is active, what policy it runs under, and what got recorded
// — and every execution path is expected to consult it.
//
// It deliberately does not own the approval *interaction*. Deciding what
// should happen is logic and belongs here; asking the user is UI and belongs
// in React. `evaluateScript` returns a decision, the dialog collects an answer,
// and the caller reports back through `recordDecision`.

import {
    newAuditId,
    recordAudit,
    type AuditDecision,
    type AuditEntry,
    type AuditOutcome,
} from './auditLog';
import type { SqlDialect } from './schemaTypes';
import type { StatementClassification } from './sqlClassifier';
import { DEFAULT_POLICY, type Provenance, type SafetyPolicy } from './sqlPolicy';

const POLICY_STORAGE_KEY = 'sqlSafetyPolicies';

export interface ActiveConnection {
    /** Stable identity used as the policy key. */
    id: string;
    /** What the user sees in the status bar and the audit log. */
    label: string;
    dialect: SqlDialect;
}

/** Identity for a loaded SQLite file. In-memory databases share one key. */
export function sqliteConnectionId(filePath?: string | null): string {
    return filePath ? `sqlite:${filePath}` : 'sqlite:in-memory';
}

/** Identity for a Postgres connection. Excludes credentials by construction. */
export function postgresConnectionId(
    host: string,
    port: number | string,
    database: string,
): string {
    return `postgres:${host}:${port}/${database}`;
}

function readPolicies(): Record<string, SafetyPolicy> {
    try {
        const raw = localStorage.getItem(POLICY_STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, SafetyPolicy>) : {};
    } catch {
        return {};
    }
}

/**
 * The policy for a connection, defaulting to `guarded` for one never seen
 * before.
 *
 * A deliberate deviation from the "read-only by default" line in the original
 * plan. Read-only by default would make the table editor — the app's primary
 * function — appear broken on first launch, and a safety default users switch
 * off within a minute protects nobody. `guarded` keeps reads instant, makes
 * every mutation an explicit act, and leaves read-only as a real mode one
 * click away for the case it is meant for: pointing the app at production.
 */
export function policyFor(connectionId: string): SafetyPolicy {
    return readPolicies()[connectionId] ?? DEFAULT_POLICY;
}

export function setPolicyFor(connectionId: string, policy: SafetyPolicy): void {
    try {
        const policies = readPolicies();
        policies[connectionId] = policy;
        localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(policies));
    } catch (error) {
        console.error('Failed to persist safety policy:', error);
    }
    window.dispatchEvent(
        new CustomEvent('sqlPolicyChanged', { detail: { connectionId, policy } }),
    );
}

// Which connection the services should consult. A desktop client holds one at
// a time, so this is module state rather than a parameter threaded through
// every method signature.
let active: ActiveConnection | null = null;

export function setActiveConnection(connection: ActiveConnection): void {
    active = connection;
    window.dispatchEvent(
        new CustomEvent('sqlPolicyChanged', { detail: { connectionId: connection.id } }),
    );
}

export function clearActiveConnection(): void {
    active = null;
    window.dispatchEvent(new CustomEvent('sqlPolicyChanged', { detail: { connectionId: null } }));
}

export function activeConnection(): ActiveConnection | null {
    return active;
}

export function activePolicy(): SafetyPolicy {
    return active ? policyFor(active.id) : DEFAULT_POLICY;
}

/**
 * Whether the active connection refuses mutations.
 *
 * Called by the services themselves, so read-only covers the table editor's
 * inline edits and row deletions as well as the SQL editor. A read-only mode
 * that only guarded the query box would be a claim the app does not honour.
 */
export function isReadOnly(): boolean {
    return activePolicy() === 'read-only';
}

/** Error thrown when a service is asked to mutate a read-only connection. */
export class ReadOnlyConnectionError extends Error {
    constructor(operation: string) {
        super(`This connection is in read-only mode, so ${operation} was not performed.`);
        this.name = 'ReadOnlyConnectionError';
    }
}

/** Throw unless the active connection permits writes. */
export function assertWritable(operation: string): void {
    if (isReadOnly()) throw new ReadOnlyConnectionError(operation);
}

export interface DecisionRecord {
    statements: StatementClassification[];
    decision: AuditDecision;
    outcome: AuditOutcome;
    provenance: Provenance;
    policy: SafetyPolicy;
    error?: string | null;
    estimatedRows?: number | null;
    durationMs?: number | null;
    model?: string | null;
    prompt?: string | null;
}

/**
 * Write one audit entry per statement.
 *
 * Per statement rather than per script, because a script is not what anyone
 * searches the log for later — "when did something delete from orders" is a
 * question about a statement.
 */
export async function recordDecision(record: DecisionRecord): Promise<void> {
    const connection = active;
    const at = new Date().toISOString();

    for (const statement of record.statements) {
        const entry: AuditEntry = {
            id: newAuditId(),
            at,
            provenance: record.provenance,
            connection: connection?.label ?? 'unknown',
            dialect: connection?.dialect ?? 'sqlite',
            sql: statement.sql,
            kind: statement.kind,
            verb: statement.verb,
            table: statement.table,
            policy: record.policy,
            decision: record.decision,
            outcome: record.outcome,
            error: record.error ?? null,
            estimatedRows: record.estimatedRows ?? null,
            durationMs: record.durationMs ?? null,
            model: record.model ?? null,
            prompt: record.prompt ?? null,
        };
        await recordAudit(entry);
    }
}

/**
 * Statements worth auditing.
 *
 * Reads are logged only when a model wrote them. A user's SELECT is their own
 * business and logging every one buries the entries that matter; a model's
 * SELECT is a record of what the model was allowed to see, which is exactly
 * the thing worth being able to review.
 */
export function auditableStatements(
    statements: StatementClassification[],
    provenance: Provenance,
): StatementClassification[] {
    if (provenance === 'ai') return statements;
    return statements.filter((s) => s.kind !== 'read');
}
