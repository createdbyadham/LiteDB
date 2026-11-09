// Snippets and the Claude Desktop merge shape. Host-specific files stay out
// of this module so the copy buttons still work in `npm run dev`.
//
// The server an agent's app starts is this app: `LiteDB --mcp`, a bridge into
// the running window (src-tauri/src/mcp.rs). The npm package is the same
// tools for a machine without LiteDB, and what `npm run dev` shows.

export const MCP_PACKAGE = 'litedb-mcp';

/** How an MCP host starts a stdio server. */
export interface ServerEntry {
    command: string;
    args: string[];
}

export function isWindowsHost(): boolean {
    if (typeof navigator === 'undefined') return false;
    return navigator.userAgent.includes('Windows') || navigator.platform.startsWith('Win');
}

/** The npm package through npx, which needs Node 22.5+ where the host runs. */
export function npxServerEntry(): ServerEntry {
    if (isWindowsHost()) {
        return { command: 'cmd', args: ['/c', 'npx', '-y', MCP_PACKAGE] };
    }
    return { command: 'npx', args: ['-y', MCP_PACKAGE] };
}

/** This app as the server, as installed here. The npm package outside the app. */
export async function appServerEntry(): Promise<ServerEntry> {
    if (!('__TAURI_INTERNALS__' in globalThis)) return npxServerEntry();
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ServerEntry>('mcp_command');
}

export function claudeDesktopSnippet(entry: ServerEntry): string {
    return JSON.stringify({ mcpServers: { litedb: entry } }, null, 2) + '\n';
}

export function cursorSnippet(entry: ServerEntry): string {
    return claudeDesktopSnippet(entry);
}

export function vsCodeSnippet(entry: ServerEntry): string {
    const { command, args } = entry;
    return (
        JSON.stringify(
            {
                servers: {
                    litedb: { type: 'stdio', command, args },
                },
            },
            null,
            2,
        ) + '\n'
    );
}

export function openCodeSnippet(entry: ServerEntry): string {
    const { command, args } = entry;
    return (
        JSON.stringify(
            {
                mcp: {
                    litedb: {
                        type: 'local',
                        command: [command, ...args],
                        enabled: true,
                    },
                },
            },
            null,
            2,
        ) + '\n'
    );
}

/** Quoted for a shell when it has to be: an install path with a space in it. */
function shellWord(word: string): string {
    return /^[\w@%+=:,./\\-]+$/.test(word) ? word : `"${word.replace(/(["$`])/g, '\\$1')}"`;
}

export function claudeCodeCommand(entry: ServerEntry): string {
    const command = [entry.command, ...entry.args].map(shellWord).join(' ');
    return `claude mcp add litedb --scope user -- ${command}`;
}

/**
 * Insert or replace `mcpServers.litedb` without touching the rest of the file.
 * Invalid JSON is refused rather than overwritten, the user's Claude
 * preferences live in the same document.
 */
export function mergeLiteDbMcp(raw: string, entry: { command: string; args: string[] }): string {
    let parsed: Record<string, unknown> = {};
    const trimmed = raw.trim();
    if (trimmed) {
        const value: unknown = JSON.parse(trimmed);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('claude_desktop_config.json is not a JSON object.');
        }
        parsed = value as Record<string, unknown>;
    }
    const existing =
        parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
            ? (parsed.mcpServers as Record<string, unknown>)
            : {};
    parsed.mcpServers = { ...existing, litedb: entry };
    return `${JSON.stringify(parsed, null, 2)}\n`;
}
