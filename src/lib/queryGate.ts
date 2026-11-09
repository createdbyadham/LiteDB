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
import { approveInAppEnabled } from './agentApprovals';
import { DIRECT_WRITES_CHANGED, directWritesFor } from './agentDirectWrites';
import { clearHandoff, writeActiveHandoff, type HandoffPostgres } from './mcpHandoff';
import type { SqlDialect } from './schemaTypes';
import type { StatementClassification } from './sqlClassifier';
import { DEFAULT_POLICY, type Provenance, type SafetyPolicy } from './sqlPolicy';

const POLICY_STORAGE_KEY = 'sqlSafetyPolicies';
const YOLO_ACK_KEY = 'sqlYoloAcknowledged';

export interface ActiveConnection {
    /** Stable identity used as the policy key. */
    id: string;
    /** What the user sees in the status bar and the audit log. */
    label: string;
    dialect: SqlDialect;
    /** Absolute path of the open file. Null for an in-memory database. */
    sqlitePath?: string | null;
    /** Addressing plus password, so the MCP server can follow this connection. */
    postgres?: HandoffPostgres;
    /** Tagged production: read-only unless someone chooses otherwise. */
    production?: boolean;
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
    return readPolicies()[connectionId] ?? defaultPolicies.get(connectionId) ?? DEFAULT_POLICY;
}

// What a connection starts in when nobody has chosen a mode for it. A
// connection tagged production starts read-only: pointing the app at
// production is the case read-only exists for, and the tag says it is that.
const defaultPolicies = new Map<string, SafetyPolicy>();

export function setDefaultPolicy(connectionId: string, policy: SafetyPolicy | null): void {
    if (policy) defaultPolicies.set(connectionId, policy);
    else defaultPolicies.delete(connectionId);
}

/** Forget a chosen mode, so the connection falls back to its default. */
export function clearPolicyFor(connectionId: string): void {
    try {
        const policies = readPolicies();
        if (!(connectionId in policies)) return;
        delete policies[connectionId];
        localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(policies));
    } catch (error) {
        console.error('Failed to clear safety policy:', error);
    }
    window.dispatchEvent(new CustomEvent('sqlPolicyChanged', { detail: { connectionId } }));
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
    if (active && active.id === connectionId) advertise(active, policy);
}

/** Tell a separately started litedb-mcp what is open, and what it may do there. */
function advertise(connection: ActiveConnection, policy: SafetyPolicy): void {
    void writeActiveHandoff(connection, policy, {
        approveInApp: approveInAppEnabled(),
        directWrites: directWritesFor(connection.id, connection.production),
    });
}

// The connection on screen: what the status bar shows, what the editor runs
// against, and what the MCP server follows. Other connections can be open
// behind it; their clients pass their own id to `assertWritable`.
let active: ActiveConnection | null = null;

export function setActiveConnection(connection: ActiveConnection): void {
    active = connection;
    window.dispatchEvent(
        new CustomEvent('sqlPolicyChanged', { detail: { connectionId: connection.id } }),
    );
    advertise(connection, policyFor(connection.id));
}

// Changing what agents may do in Settings takes effect for the agent's next
// call: the server re-reads the handoff every time.
if (typeof window !== 'undefined') {
    const readvertise = () => {
        if (active) advertise(active, policyFor(active.id));
    };
    window.addEventListener('agentApprovalSettingChanged', readvertise);
    window.addEventListener(DIRECT_WRITES_CHANGED, readvertise);
}

export function clearActiveConnection(): void {
    active = null;
    window.dispatchEvent(new CustomEvent('sqlPolicyChanged', { detail: { connectionId: null } }));
    void clearHandoff();
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
export function isReadOnly(connectionId?: string): boolean {
    const policy = connectionId ? policyFor(connectionId) : activePolicy();
    return policy === 'read-only';
}

/**
 * Whether the active connection runs generated SQL the instant it is written.
 *
 * Read by the editor to decide whether to execute a model's query itself
 * rather than putting it in the box for review.
 */
export function isYolo(): boolean {
    return activePolicy() === 'yolo';
}

function readYoloAcks(): string[] {
    try {
        const raw = localStorage.getItem(YOLO_ACK_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Whether this connection has already been warned about YOLO mode.
 *
 * Tracked separately from the policy itself so that switching away from YOLO
 * and back does not re-prompt. The warning exists to stop someone landing in
 * the mode from a mis-click in a dropdown, not to nag them about a choice
 * they have already made for this database.
 */
export function hasAcknowledgedYolo(connectionId: string): boolean {
    return readYoloAcks().includes(connectionId);
}

export function acknowledgeYolo(connectionId: string): void {
    try {
        const acks = readYoloAcks();
        if (acks.includes(connectionId)) return;
        acks.push(connectionId);
        localStorage.setItem(YOLO_ACK_KEY, JSON.stringify(acks));
    } catch (error) {
        console.error('Failed to persist YOLO acknowledgement:', error);
    }
}

/** Error thrown when a service is asked to mutate a read-only connection. */
export class ReadOnlyConnectionError extends Error {
    constructor(operation: string) {
        super(`This connection is in read-only mode, so ${operation} was not performed.`);
        this.name = 'ReadOnlyConnectionError';
    }
}

/** Throw unless the active connection permits writes. */
/**
 * Throw unless the connection permits writes. Clients pass their own policy
 * id, so a connection open behind the active one is held to its own mode.
 */
export function assertWritable(operation: string, connectionId?: string): void {
    if (isReadOnly(connectionId)) throw new ReadOnlyConnectionError(operation);
}

export interface DecisionRecord {
    statements: StatementClassification[];
    decision: AuditDecision;
    outcome: AuditOutcome;
    provenance: Provenance;
    policy: SafetyPolicy;
    error?: string | null;
    estimatedRows?: number | null;
    actualRows?: number | null;
    durationMs?: number | null;
    model?: string | null;
    prompt?: string | null;
    /** The connection it ran on, when that is not the active one. */
    connection?: { label: string; dialect: SqlDialect };
}

// Ids of the entries this window wrote. The MCP server appends to the same
// file, and this is how the app tells an agent's statements from its own when
// it watches the log (see agentActivity.ts). Bounded: only recent ones matter.
const ownEntries = new Set<string>();

function rememberOwn(id: string): void {
    ownEntries.add(id);
    if (ownEntries.size > 500) {
        const oldest = ownEntries.values().next();
        if (!oldest.done) ownEntries.delete(oldest.value);
    }
}

/** Whether this window wrote the audit entry with this id. */
export function isOwnAuditEntry(id: string): boolean {
    return ownEntries.has(id);
}

/**
 * Write one audit entry per statement.
 *
 * Per statement rather than per script, because a script is not what anyone
 * searches the log for later — "when did something delete from orders" is a
 * question about a statement.
 */
export async function recordDecision(record: DecisionRecord): Promise<void> {
    const connection = record.connection ?? active;
    const at = new Date().toISOString();

    for (const statement of record.statements) {
        const id = newAuditId();
        rememberOwn(id);
        const entry: AuditEntry = {
            id,
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
            actualRows: record.actualRows ?? null,
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
    policy?: SafetyPolicy,
): StatementClassification[] {
    // In YOLO nothing else is watching — no approval, no row count, no
    // refusal — so the log stops being a convenience and becomes the only
    // record that anything happened. It gets everything.
    if (provenance === 'ai' || policy === 'yolo') return statements;
    return statements.filter((s) => s.kind !== 'read');
}
