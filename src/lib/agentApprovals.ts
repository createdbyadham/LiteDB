// Agents' writes waiting for a yes in this window.
//
// litedb-mcp writes a request into <app data>/approvals and waits; this polls
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

let requests: ApprovalRequest[] = [];
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

function publish(next: ApprovalRequest[]): void {
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
            publish([]);
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
        next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        publish(next);
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

/** Write the answer the waiting server reads. */
export async function answerApproval(token: string, decision: ApprovalAnswer): Promise<void> {
    answered.add(token);
    publish(requests.filter((r) => r.token !== token));
    if (!inTauri()) return;
    const fs = await import('@tauri-apps/plugin-fs');
    await fs.writeTextFile(
        `${APPROVALS_DIR}/${decisionFileName(token)}`,
        serializeDecision({ token, decision, at: new Date().toISOString() }),
        { baseDir: fs.BaseDirectory.AppLocalData },
    );
}
