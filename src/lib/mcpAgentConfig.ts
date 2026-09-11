// Snippets and the Claude Desktop merge shape. Host-specific files stay out
// of this module so the copy buttons still work in `npm run dev`.

export const MCP_PACKAGE = 'litedb-mcp';

export function isWindowsHost(): boolean {
    if (typeof navigator === 'undefined') return false;
    return navigator.userAgent.includes('Windows') || navigator.platform.startsWith('Win');
}

/** What Claude Desktop / Cursor / most stdio hosts expect. */
export function stdioServerEntry(): { command: string; args: string[] } {
    if (isWindowsHost()) {
        return { command: 'cmd', args: ['/c', 'npx', '-y', MCP_PACKAGE] };
    }
    return { command: 'npx', args: ['-y', MCP_PACKAGE] };
}

export function claudeDesktopSnippet(): string {
    return JSON.stringify({ mcpServers: { litedb: stdioServerEntry() } }, null, 2) + '\n';
}

export function cursorSnippet(): string {
    return claudeDesktopSnippet();
}

export function vsCodeSnippet(): string {
    const { command, args } = stdioServerEntry();
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

export function openCodeSnippet(): string {
    const { command, args } = stdioServerEntry();
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

export function claudeCodeCommand(): string {
    return `claude mcp add litedb --scope user -- npx -y ${MCP_PACKAGE}`;
}

/**
 * Insert or replace `mcpServers.litedb` without touching the rest of the file.
 * Invalid JSON is refused rather than overwritten — the user's Claude
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
