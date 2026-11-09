// Agents served from this window: what `LiteDB --mcp` reaches.
//
// The Rust side (src-tauri/src/mcp.rs) takes each bridge's connection and
// hands its lines here. Every connection becomes an MCP server with the tools
// the npm package registers (mcp/src/tools/register.ts), run against the
// connection on screen, with writes approved in this window's own dialog and
// recorded in its own audit log. Nothing to install, and no second copy of
// the rules to keep in step.

import { Channel, invoke } from '@tauri-apps/api/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    JSONRPCMessageSchema,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    type JSONRPCMessage,
    type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import { buildRequest, type AppAnswer } from '../../../mcp/src/approvalRequest';
import type { PendingApproval } from '../../../mcp/src/approvals';
import type { Database } from '../../../mcp/src/catalog';
import { DEFAULT_APPROVAL_WAIT_MS, type ToolConfig } from '../../../mcp/src/toolConfig';
import type { ToolContext } from '../../../mcp/src/tools/query';
import { registerTools, serverInstructions, type ToolSession } from '../../../mcp/src/tools/register';
import { captureUndo } from '../../../mcp/src/undoCapture';
import { approveInAppEnabled, askInWindow } from '@/lib/agentApprovals';
import { inTauri } from '@/lib/db/native';
import { mcpPolicyFromApp } from '@/lib/mcpHandoff';
import { activeConnection, policyFor } from '@/lib/queryGate';
import { serializeUndo, UNDO_FOLDER, type UndoRecord } from '@/lib/undoWrite';
import { AppPostgresDatabase, AppSqliteDatabase } from './appDatabase';

type McpEvent =
    | { kind: 'open'; session: number }
    | { kind: 'message'; session: number; message: string }
    | { kind: 'close'; session: number };

const NO_CONNECTION_MESSAGE =
    'No database is open in LiteDB. Open one in the app; the agent follows whatever is connected.';
const IN_MEMORY_MESSAGE =
    'LiteDB has an in-memory SQLite database open, which an agent cannot reach. Save it to a file and open that.';

/** Rows a tool shows at most, as the npm server's LITEDB_MAX_ROWS default. */
const MAX_ROWS = 200;
/** The model semantic_search embeds text with, as the npm server's default. */
const EMBEDDING_MODEL = 'minilm';

/** One agent's connection, as the SDK sees it. */
class BridgeTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly deliver: (line: string) => Promise<void>) {}

    async start(): Promise<void> {}

    /** In order: invokes race, and a response could overtake what came before it. */
    send(message: JSONRPCMessage): Promise<void> {
        const line = JSON.stringify(message);
        const sent = this.queue.then(() => this.deliver(line));
        this.queue = sent.catch(() => undefined);
        return sent;
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    receive(line: string): void {
        let message: JSONRPCMessage;
        try {
            message = JSONRPCMessageSchema.parse(JSON.parse(line));
        } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        this.onmessage?.(message);
    }
}

/** Undo files beside the audit log, where the Audit panel's Undo looks. */
async function writeUndoFile(record: UndoRecord): Promise<string> {
    const fs = await import('@tauri-apps/plugin-fs');
    const base = { baseDir: fs.BaseDirectory.AppLocalData };
    const folder = `audit/${UNDO_FOLDER}`;
    await fs.mkdir(folder, { ...base, recursive: true });
    await fs.writeTextFile(`${folder}/${record.id}.json`, serializeUndo(record), base);
    return `${UNDO_FOLDER}/${record.id}.json`;
}

/** Wait for the window's answer, but no longer than one call should take. */
function within(answer: Promise<AppAnswer>, ms: number): Promise<AppAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<AppAnswer>((resolve) => {
        timer = setTimeout(() => resolve('waiting'), ms);
    });
    return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

/**
 * The connection on screen, as every agent sees it. Shared by all of them,
 * and handed back once no tool call is using it, as the npm server does.
 */
class Target {
    private db: Database | null = null;
    private fingerprint = '';
    private chain: Promise<unknown> = Promise.resolve();
    private inFlight = 0;

    /** Follow the app: a switch of database or policy applies to the next call. */
    current(): Promise<{ db: Database; config: ToolConfig }> {
        const next = this.chain.then(
            () => this.resolve(),
            () => this.resolve(),
        );
        this.chain = next.catch(() => undefined);
        return next;
    }

    async use<T>(work: (db: Database, config: ToolConfig) => Promise<T>): Promise<T> {
        this.inFlight++;
        try {
            const { db, config } = await this.current();
            return await work(db, config);
        } finally {
            this.inFlight--;
            if (this.inFlight === 0) await this.db?.release().catch(() => undefined);
        }
    }

    private async resolve(): Promise<{ db: Database; config: ToolConfig }> {
        const active = activeConnection();
        if (!active) throw new Error(NO_CONNECTION_MESSAGE);
        if (active.dialect === 'sqlite' && !active.sqlitePath) throw new Error(IN_MEMORY_MESSAGE);

        const policy = mcpPolicyFromApp(policyFor(active.id));
        // A token is bound to this. For Postgres the role is part of it, so a
        // preview taken as one user cannot run as another.
        const target =
            active.dialect === 'sqlite'
                ? (active.sqlitePath as string)
                : `${active.postgres?.username ?? ''}@${active.id}`;
        const fingerprint = [active.dialect, active.id, target, policy].join('\0');
        if (!this.db || this.fingerprint !== fingerprint) {
            const writable = policy !== 'read-only';
            const next =
                active.dialect === 'sqlite'
                    ? new AppSqliteDatabase(target, writable)
                    : new AppPostgresDatabase(active.id, writable);
            const previous = this.db;
            this.db = next;
            this.fingerprint = fingerprint;
            await previous?.close().catch(() => undefined);
        }
        return {
            db: this.db,
            config: {
                dialect: active.dialect,
                target,
                connectionId: active.id,
                policy,
                maxRows: MAX_ROWS,
                embeddingModelId: EMBEDDING_MODEL,
            },
        };
    }
}

const target = new Target();

/** One agent's view: the shared target, stamped with that agent's name. */
class AppToolSession implements ToolSession {
    constructor(private readonly client: () => string | null) {}

    run<T>(work: (ctx: ToolContext) => Promise<T>): Promise<T> {
        return target.use((db, config) => work(this.context_(db, config)));
    }

    async context(): Promise<ToolContext> {
        const { db, config } = await target.current();
        return this.context_(db, config);
    }

    private context_(db: Database, config: ToolConfig): ToolContext {
        const client = this.client();
        return {
            db,
            config,
            client,
            // Off in Settings → Agents, the agent's own app is the only thing that asks.
            approve: approveInAppEnabled()
                ? (approval: PendingApproval) =>
                      within(
                          askInWindow(approval.token, () => buildRequest({ db, config, client }, approval)),
                          DEFAULT_APPROVAL_WAIT_MS,
                      )
                : undefined,
            undo: (statement) => captureUndo(db, statement, config.connectionId, writeUndoFile),
        };
    }
}

function createServer(version: string): McpServer {
    const server = new McpServer(
        { name: 'litedb', version },
        { instructions: serverInstructions('app') },
    );
    registerTools(server, new AppToolSession(() => server.server.getClientVersion()?.name ?? null));
    return server;
}

/**
 * What the server says about itself, for `LiteDB --mcp` to repeat while the
 * app is closed: the handshake and the lists, asked of a server that is
 * never connected to anything.
 */
async function describe(version: string): Promise<string> {
    const server = createServer(version);
    const waiting = new Map<number, (result: Record<string, unknown> | undefined) => void>();
    const transport = new BridgeTransport(async (line) => {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (typeof message.id === 'number') waiting.get(message.id)?.(message.result);
    });
    await server.connect(transport);
    let next = 0;
    const ask = (method: string, params: object = {}) =>
        new Promise<Record<string, unknown> | undefined>((resolve) => {
            next += 1;
            waiting.set(next, resolve);
            transport.receive(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }));
        });
    try {
        const init = await ask('initialize', {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'litedb-describe', version },
        });
        transport.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        const tools = await ask('tools/list');
        const resources = await ask('resources/list');
        return JSON.stringify({
            protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
            latestProtocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: init?.capabilities,
            serverInfo: init?.serverInfo,
            instructions: init?.instructions,
            tools: tools?.tools ?? [],
            resources: resources?.resources ?? [],
        });
    } finally {
        await server.close();
    }
}

const served = new Map<number, { server: McpServer; transport: BridgeTransport }>();
/** Held so the channel is not collected while Rust still sends on it. */
let channel: Channel<McpEvent> | null = null;
let starting: Promise<void> | null = null;

function handle(event: McpEvent, version: string): void {
    switch (event.kind) {
        case 'open': {
            const session = event.session;
            const server = createServer(version);
            const transport = new BridgeTransport((message) => invoke('mcp_send', { session, message }));
            served.set(session, { server, transport });
            server.connect(transport).catch((error: unknown) => {
                console.error('An agent could not be served:', error);
                served.delete(session);
                void invoke('mcp_close', { session }).catch(() => undefined);
            });
            break;
        }
        case 'message':
            served.get(event.session)?.transport.receive(event.message);
            break;
        case 'close': {
            const gone = served.get(event.session);
            served.delete(event.session);
            void gone?.server.close().catch(() => undefined);
            break;
        }
    }
}

/** Start taking agents. Once per window; a reload starts over, and Rust drops the old sessions. */
export function startMcpHost(): Promise<void> {
    if (!inTauri()) return Promise.resolve();
    starting ??= (async () => {
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = await getVersion();
        const description = await describe(version).catch((error: unknown) => {
            console.error('Could not describe the agent tools:', error);
            return '{}';
        });
        const next = new Channel<McpEvent>();
        next.onmessage = (event) => handle(event, version);
        await invoke('mcp_listen', { description, onEvent: next });
        channel = next;
    })().catch((error: unknown) => {
        starting = null;
        console.error('Agents cannot connect to this window:', error);
    });
    return starting;
}

/** For the Agents panel: whether this window is taking agents, and how many are connected. */
export function mcpHostStatus(): { listening: boolean; agents: number } {
    return { listening: channel !== null, agents: served.size };
}
