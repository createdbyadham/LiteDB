// Agents' writes waiting for a yes in this window.
//
// Two ways in. An agent this window serves itself (`LiteDB --mcp`, see
// src/lib/mcp/host.ts) asks in-process, through askInWindow. The npm server,
// litedb-mcp, writes a request into <app data>/approvals and waits; this polls
// the folder, hands the requests to the approval card, and writes the answer
// back. The protocol, and what it does not protect against, is in
// agentApproval.ts.
//
// Polled like the agent activity in agentActivity.ts, and for the same reason,
// but it keeps polling while the window is hidden: an agent is waiting on it.

import {
    APPROVALS_DIR,
    decisionFileName,
    parseRequest,
    requestToken,
    serializeDecision,
    type ApprovalAnswer,
    type ApprovalRequest,
} from './agentApproval';

const POLL_MS = 700;
const SETTING_KEY = 'litedb-approve-agent-writes';

/** On unless turned off in Settings → Agents. Read when the handoff is written. */
export function approveInAppEnabled(): boolean {
    try {
        return localStorage.getItem(SETTING_KEY) !== 'off';
    } catch {
        return true;
    }
}

export function setApproveInApp(on: boolean): void {
    try {
        localStorage.setItem(SETTING_KEY, on ? 'on' : 'off');
    } catch {
        // Private mode: the switch lasts for this session only.
    }
    window.dispatchEvent(new CustomEvent('agentApprovalSettingChanged'));
}

/** What the approval card shows, oldest first. */
let requests: ApprovalRequest[] = [];
/** Requests found in the approvals folder. */
let fromFiles: ApprovalRequest[] = [];

interface InWindow {
    /** Null while the request is still being built. */
    request: ApprovalRequest | null;
    resolve: (answer: ApprovalAnswer) => void;
    answer: Promise<ApprovalAnswer>;
}
/** Requests from agents this window serves, by token. */
const inWindow = new Map<string, InWindow>();
/** Answers given here that the agent has not come back for yet. */
const decided = new Map<string, { answer: ApprovalAnswer; expiresAt: number }>();

const listeners = new Set<() => void>();
/** Answered here; hidden at once instead of when the server cleans up. */
const answered = new Set<string>();
/** Requests the window has already called attention to. */
const announced = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;

function inTauri(): boolean {
    return '__TAURI_INTERNALS__' in globalThis;
}

function publish(): void {
    const now = Date.now();
    // The token is gone after its expiry, so the request can only mislead.
    for (const [token, entry] of inWindow) {
        if (entry.request && Date.parse(entry.request.expiresAt) <= now) inWindow.delete(token);
    }
    for (const [token, entry] of decided) {
        if (entry.expiresAt <= now) decided.delete(token);
    }
    const local = [...inWindow.values()].flatMap((entry) => (entry.request ? [entry.request] : []));
    const next = [...fromFiles, ...local].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const same = next.length === requests.length && next.every((r, i) => r.token === requests[i].token);
    if (same) return;
    requests = next;
    if (next.some((r) => !announced.has(r.token))) {
        next.forEach((r) => announced.add(r.token));
        void callAttention();
    }
    listeners.forEach((fn) => fn());
}

/** Flash the taskbar entry or bounce the dock icon: an agent is waiting on this window. */
async function callAttention(): Promise<void> {
    try {
        const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
        await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
    } catch {
        // Not permitted, or not supported on this platform: the card still shows.
    }
}

async function poll(): Promise<void> {
    // Checked on every tick, not once: in the browser preview the bridge
    // arrives after the app has mounted.
    if (polling || !inTauri()) return;
    polling = true;
    try {
        const fs = await import('@tauri-apps/plugin-fs');
        const base = { baseDir: fs.BaseDirectory.AppLocalData };
        if (!(await fs.exists(APPROVALS_DIR, base))) {
            fromFiles = [];
            publish();
            return;
        }
        const entries = await fs.readDir(APPROVALS_DIR, base);
        const names = new Set(entries.map((e) => e.name));
        const next: ApprovalRequest[] = [];
        for (const { name } of entries) {
            const token = requestToken(name);
            if (!token || answered.has(token)) continue;
            const request =
                requests.find((r) => r.token === token) ??
                parseRequest(await fs.readTextFile(`${APPROVALS_DIR}/${name}`, base).catch(() => ''));
            if (!request) continue;
            if (Date.parse(request.expiresAt) <= Date.now()) {
                // The token is gone, so the request can only mislead. Clear it, and
                // any answer nobody came back for.
                await fs.remove(`${APPROVALS_DIR}/${name}`, base).catch(() => undefined);
                await fs.remove(`${APPROVALS_DIR}/${decisionFileName(token)}`, base).catch(() => undefined);
                continue;
            }
            if (names.has(decisionFileName(token))) continue;
            next.push(request);
        }
        fromFiles = next;
        publish();
    } catch (error) {
        console.error('Checking for agent approvals failed:', error);
    } finally {
        polling = false;
    }
}

/** Requests waiting, oldest first. */
export function pendingApprovals(): ApprovalRequest[] {
    return requests;
}

export function onApprovalsChange(fn: () => void): () => void {
    listeners.add(fn);
    if (!timer) {
        void poll();
        timer = setInterval(() => void poll(), POLL_MS);
    }
    return () => {
        listeners.delete(fn);
        if (!listeners.size && timer) {
            clearInterval(timer);
            timer = undefined;
        }
    };
}

/**
 * Put a write from an agent this window serves in front of the person, and
 * resolve with their answer. Asking again for the same token waits on the
 * request already showing, or gets the answer given while the agent was away;
 * `build` runs once.
 */
export function askInWindow(token: string, build: () => Promise<ApprovalRequest>): Promise<ApprovalAnswer> {
    const given = decided.get(token);
    if (given) {
        decided.delete(token);
        return Promise.resolve(given.answer);
    }
    const existing = inWindow.get(token);
    if (existing) return existing.answer;

    let resolve!: (answer: ApprovalAnswer) => void;
    let reject!: (error: unknown) => void;
    const answer = new Promise<ApprovalAnswer>((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    const entry: InWindow = { request: null, resolve, answer };
    inWindow.set(token, entry);
    build().then(
        (request) => {
            entry.request = request;
            publish();
        },
        (error: unknown) => {
            inWindow.delete(token);
            reject(error);
        },
    );
    return answer;
}

/** Answer a request: in-process for this window's own agents, else the file the server reads. */
export async function answerApproval(token: string, decision: ApprovalAnswer): Promise<void> {
    const local = inWindow.get(token);
    if (local) {
        inWindow.delete(token);
        const expiresAt = local.request ? Date.parse(local.request.expiresAt) : Date.now();
        decided.set(token, { answer: decision, expiresAt });
        publish();
        local.resolve(decision);
        return;
    }
    answered.add(token);
    fromFiles = fromFiles.filter((r) => r.token !== token);
    publish();
    if (!inTauri()) return;
    const fs = await import('@tauri-apps/plugin-fs');
    await fs.writeTextFile(
        `${APPROVALS_DIR}/${decisionFileName(token)}`,
        serializeDecision({ token, decision, at: new Date().toISOString() }),
        { baseDir: fs.BaseDirectory.AppLocalData },
    );
}
