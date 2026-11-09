// The tools and the schema resource, registered on an MCP server.
//
// Shared by both hosts: the npm server (index.ts), which speaks stdio, and
// the desktop app, which serves the same tools to `LiteDB --mcp` over its own
// connection. Keep this file free of Node imports: everything host-specific
// arrives through the session.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { auditLogLocation, readAudit } from '../../../src/lib/auditLog';
import { pluralRows } from '../render';
import { executeApprovedInput, runApproved, runQuery, type ToolContext, type ToolResult } from './query';
import { describeTable, listTables, renderSchema } from './schema';
import { listVectorColumns, semanticSearch, type DistanceMetric } from './vector';

/** What a host provides: a context per call, built from whatever it follows. */
export interface ToolSession {
    run<T>(work: (ctx: ToolContext) => Promise<T>): Promise<T>;
    context(): Promise<ToolContext>;
}

/** Shape an MCP host expects back from a tool. */
function toContent(result: ToolResult) {
    return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError ?? false,
    };
}

/** Turn a thrown error into a tool result rather than a protocol error. */
async function guard(work: () => Promise<ToolResult>) {
    try {
        return toContent(await work());
    } catch (error) {
        return toContent({
            text: error instanceof Error ? error.message : String(error),
            isError: true,
        });
    }
}

/** Where the database comes from, as the model should understand it. */
const SOURCE = {
    npm:
        'Talks to the database currently open in the LiteDB desktop app, or to ' +
        'LITEDB_SQLITE_PATH / LITEDB_DATABASE_URL if those are set. Switch ' +
        'database or policy in the app and the next tool call follows — no restart. ' +
        'Quitting the app clears the handoff.',
    app:
        'Talks to the database currently open in the LiteDB window. Switch ' +
        'database or policy in the app and the next tool call follows — no restart.',
};

/** The server's instructions to the model, for the host serving the tools. */
export function serverInstructions(host: 'npm' | 'app'): string {
    return [
        SOURCE[host],
        'If the app is in YOLO, this server maps that down to guarded. ' +
            'SQLite is the file on disk, not unsaved editor state — save first.',
        'Start with list_tables and describe_table — describe_table reports the ' +
            'values a low-cardinality column actually holds, which is usually the ' +
            'difference between a query that runs and one that is right.',
        'Writes are previewed; running them is a separate execute_approved call.',
    ].join(' ');
}

export const SERVER_INSTRUCTIONS = serverInstructions('npm');

export function registerTools(server: McpServer, session: ToolSession): void {
    // ------------------------------------------------------------- schema ---

    server.registerTool(
        'list_tables',
        {
            title: 'List tables',
            description:
                'Every table in the database, with its column count, approximate row ' +
                'count and primary key. The place to start.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => guard(() => session.run((ctx) => listTables(ctx))),
    );

    server.registerTool(
        'describe_table',
        {
            title: 'Describe a table',
            description:
                'Columns and types for one table, with primary keys, NOT NULL, defaults, ' +
                'foreign keys, indexes, and — for low-cardinality text columns — the ' +
                'distinct values they actually contain. Read this before writing SQL ' +
                'against a table you have not seen.',
            inputSchema: {
                table: z.string().describe('Table name. Case-insensitive.'),
                include_sample_values: z
                    .boolean()
                    .optional()
                    .describe(
                        'Include a few distinct values for enumerated columns (default ' +
                            'true). These are real values from the table.',
                    ),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ table, include_sample_values }) =>
            guard(() =>
                session.run((ctx) => describeTable(ctx, table, include_sample_values ?? true)),
            ),
    );

    // -------------------------------------------------------------- query ---

    server.registerTool(
        'query',
        {
            title: 'Run SQL',
            description:
                'Run SQL against the database. A read executes and returns rows. ' +
                'Anything that would change the database does NOT execute: it comes back ' +
                'classified, with the number of rows it would affect and the query plan, ' +
                'plus a single-use token for execute_approved. A statement the policy ' +
                'forbids is refused and says why.',
            inputSchema: {
                sql: z.string().describe('One or more SQL statements, separated by semicolons.'),
            },
            // True, and load-bearing: this tool cannot modify anything. The
            // write half is execute_approved, annotated accordingly.
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ sql }) => guard(() => session.run((ctx) => runQuery(ctx, sql))),
    );

    server.registerTool(
        'execute_approved',
        {
            title: 'Execute an approved statement',
            description:
                'Second step, after query. Runs the statements a previous `query` call ' +
                'previewed. Takes only the token — the SQL is held server-side, so what ' +
                'runs is exactly what was previewed. Single-use, and expires five minutes ' +
                'after the preview. Confirm the row count with the person you are working ' +
                'for before calling this. While LiteDB is open, the request appears in its ' +
                'window and nothing runs until they approve it there: a call can come back ' +
                'WAITING, and then you call again with the same token once they have answered.',
            inputSchema: executeApprovedInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        async ({ token }) =>
            guard(() => session.run((ctx) => runApproved(ctx, token))),
    );

    // ------------------------------------------------------------ vectors ---

    server.registerTool(
        'list_vector_columns',
        {
            title: 'List pgvector columns',
            description:
                'Vector columns in the database and their dimensions. PostgreSQL with ' +
                'the pgvector extension only.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => guard(() => session.run((ctx) => listVectorColumns(ctx))),
    );

    server.registerTool(
        'semantic_search',
        {
            title: 'Semantic search',
            description:
                'Nearest-neighbour search over a pgvector column. Give `text` to search ' +
                'by meaning — it is embedded by a model running on this machine, so the ' +
                'text never leaves it — or `row_id` to find rows similar to an existing ' +
                'one. The first text search downloads the embedding model (~23 MB for the ' +
                'default) and may take a minute.',
            inputSchema: {
                table: z.string().describe('Table holding the vector column.'),
                column: z.string().describe('The vector column to search.'),
                text: z
                    .string()
                    .optional()
                    .describe('Text to search for. Embedded locally. Not with row_id.'),
                row_id: z
                    .string()
                    .optional()
                    .describe('Primary key of a row to find neighbours of.'),
                limit: z.number().int().min(1).max(100).optional().describe('Default 10.'),
                metric: z
                    .enum(['<=>', '<->', '<#>'])
                    .optional()
                    .describe('Distance operator: cosine (default), L2, or inner product.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ table, column, text, row_id, limit, metric }) =>
            guard(() =>
                session.run((ctx) =>
                    semanticSearch(ctx, {
                        table,
                        column,
                        text,
                        rowId: row_id,
                        limit: limit ?? 10,
                        metric: (metric as DistanceMetric) ?? '<=>',
                    }),
                ),
            ),
    );

    // -------------------------------------------------------------- audit ---

    server.registerTool(
        'audit_log',
        {
            title: 'Read the audit log',
            description:
                'The most recent statements recorded against this database, newest first ' +
                '— from this server and from the LiteDB desktop app, which share the ' +
                'file. Shows what was proposed, what was approved, and what ran.',
            inputSchema: {
                limit: z.number().int().min(1).max(200).optional().describe('Default 20.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ limit }) =>
            guard(async () => {
                await session.context();
                const entries = await readAudit(limit ?? 20);
                if (entries.length === 0) {
                    return { text: `Nothing logged yet. The log lives at ${auditLogLocation()}.` };
                }
                const lines = entries.map((e) => {
                    let rows = '';
                    if (e.actualRows !== null) rows = ` · ${pluralRows(e.actualRows)}`;
                    else if (e.estimatedRows !== null)
                        rows = ` · ~${pluralRows(e.estimatedRows)} predicted`;
                    return (
                        `${e.at} · ${e.provenance} · ${e.decision}/${e.outcome}${rows}` +
                        `\n    ${e.sql}` +
                        (e.error ? `\n    error: ${e.error}` : '')
                    );
                });
                return { text: [`${entries.length} entry/entries:`, '', ...lines].join('\n') };
            }),
    );

    // ----------------------------------------------------------- resource ---

    server.registerResource(
        'schema',
        'litedb://schema',
        {
            title: 'Database schema',
            description:
                'Every table and column in the database, as one document. Cheaper than ' +
                'calling describe_table for each table when you need the whole picture.',
            mimeType: 'text/plain',
        },
        async (uri) => {
            try {
                const text = await session.run((ctx) => renderSchema(ctx));
                return {
                    contents: [{ uri: uri.href, mimeType: 'text/plain', text }],
                };
            } catch (error) {
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: 'text/plain',
                            text: error instanceof Error ? error.message : String(error),
                        },
                    ],
                };
            }
        },
    );
}
