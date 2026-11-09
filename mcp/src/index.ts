// litedb-mcp — a database an agent can drive, with LiteDB's guardrails in the
// path.
//
// The case for this existing alongside a plain Postgres MCP server is one
// sentence: a raw server hands a model a connection, and this one hands it a
// policy. Reads run on a connection the engine will not let write; writes are
// classified, measured and returned as a preview rather than executed; running
// one is a second, separately named tool call; and all of it lands in the same
// audit log the desktop app reads, so opening LiteDB shows you what the agent
// did.
//
// The tool names, descriptions and annotations here are part of the safety
// design, not documentation of it. `query` is annotated read-only because it
// genuinely never writes, and `execute_approved` is annotated destructive
// because it genuinely might — which is what makes an MCP host stop and ask.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, type ServerConfig } from './config';
import { LiveSession } from './session';
import { registerTools, SERVER_INSTRUCTIONS } from './tools/register';

const VERSION = '0.1.7';

/** stdout carries the protocol. Everything human-readable goes to stderr. */
function log(message: string): void {
    process.stderr.write(`${message}\n`);
}

function policyBlurb(config: ServerConfig): string {
    switch (config.policy) {
        case 'read-only':
            return (
                'This connection is read-only: reads run, and anything that would change ' +
                'the database is refused outright rather than offered for approval.'
            );
        case 'unrestricted':
            return (
                'This connection allows writes. Generated SQL is still held to the guarded ' +
                'floor, so a write is previewed and needs execute_approved before it runs.'
            );
        default:
            return (
                'This connection is guarded: reads run immediately, and anything that ' +
                'changes the database is previewed and needs execute_approved before it runs.'
            );
    }
}

async function main(): Promise<void> {
    const session = new LiveSession();

    try {
        const config = (await session.context()).config;
        log(`litedb-mcp ${VERSION}`);
        log(`  database: ${config.connectionId} (${config.source})`);
        log(`  policy:   ${config.policy}`);
        log(`  audit:    ${config.auditPath}`);
        log(`  writes:   ${config.approvalsDir ? 'approved in the LiteDB window' : 'approved by the MCP host'}`);
        log(`  ${policyBlurb(config)}`);
    } catch (error) {
        if (error instanceof ConfigError && !error.retryable) {
            log(`litedb-mcp: ${error.message}`);
            process.exit(1);
        }
        log(`litedb-mcp ${VERSION}`);
        log(`  waiting: ${error instanceof Error ? error.message : String(error)}`);
    }

    const server = new McpServer(
        { name: 'litedb', version: VERSION },
        {
            instructions: SERVER_INSTRUCTIONS,
        },
    );

    registerTools(server, session);

    session.client = () => server.server.getClientVersion()?.name ?? null;

    const transport = new StdioServerTransport();
    await server.connect(transport);

    const shutdown = async (): Promise<void> => {
        try {
            await session.close();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
    log(`litedb-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
