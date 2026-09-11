// Semantic search over pgvector, with the embedding computed on this machine.
//
// The reason this is a tool worth exposing rather than something the model
// could write itself: a similarity query needs a query *vector*, and a model
// producing SQL has no way to produce one. Asking it to would mean sending the
// search text to an embedding API. Here the text is embedded locally by
// transformers.js — the same MiniLM/BGE models the desktop app loads — so
// "find rows about billing errors" never leaves the machine, which is the
// whole premise of a local-first database client.
//
// Everything the model supplies that ends up in an identifier position is
// resolved against the live catalogue first: a table name must match a real
// table, a column name a real vector column of it. The part it cannot supply —
// the vector — is numbers this file generated.

import { record } from '../audit';
import { literal, type Database } from '../db';
import { pluralRows, renderTable } from '../render';
import type { ToolContext, ToolResult } from './query';

export type DistanceMetric = '<=>' | '<->' | '<#>';

export const METRIC_LABEL: Record<DistanceMetric, string> = {
    '<=>': 'cosine distance',
    '<->': 'L2 (Euclidean) distance',
    '<#>': 'negative inner product',
};

export interface VectorColumn {
    table: string;
    column: string;
    dimensions: number;
}

/**
 * pgvector columns and their declared width.
 *
 * `format_type` is the only place the dimension is recorded — information_schema
 * reports the type as USER-DEFINED and nothing else — so it is parsed back out
 * of `vector(384)`.
 */
export async function findVectorColumns(db: Database): Promise<VectorColumn[]> {
    if (!(await db.hasPgVector())) return [];
    const { rows } = await db.read(
        `SELECT c.table_name,
                c.column_name,
                COALESCE(
                    (regexp_match(format_type(a.atttypid, a.atttypmod), 'vector\\((\\d+)\\)'))[1]::int,
                    0
                ) AS dimensions
         FROM information_schema.columns c
         JOIN pg_class t ON t.relname = c.table_name
         JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = c.table_schema
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = c.column_name
         WHERE c.table_schema = 'public' AND c.udt_name = 'vector'
         ORDER BY c.table_name, c.column_name`,
    );
    return rows.map((r) => ({
        table: String(r[0]),
        column: String(r[1]),
        dimensions: Number(r[2]) || 0,
    }));
}

export async function listVectorColumns(ctx: ToolContext): Promise<ToolResult> {
    if (ctx.db.dialect !== 'postgres') {
        return {
            text:
                'Semantic search needs PostgreSQL with the pgvector extension. This ' +
                'server is connected to SQLite.',
            isError: true,
        };
    }
    if (!(await ctx.db.hasPgVector())) {
        return {
            text:
                'The pgvector extension is not installed in this database. Install it ' +
                'with: CREATE EXTENSION vector;',
            isError: true,
        };
    }

    const columns = await findVectorColumns(ctx.db);
    if (columns.length === 0) {
        return { text: 'pgvector is installed, but no table has a vector column.' };
    }

    return {
        text: [
            `${columns.length} vector column(s):`,
            '',
            ...columns.map((c) => `  ${c.table}.${c.column} — ${c.dimensions} dimensions`),
            '',
            'semantic_search takes either a text query (embedded locally) or the id of ' +
                'an existing row to find neighbours of.',
        ].join('\n'),
    };
}

/**
 * Embed text with a local model.
 *
 * The import is dynamic for two reasons: `@xenova/transformers` is an optional
 * dependency, and loading it costs a noticeable fraction of a second even
 * before a model is fetched. A server whose user never runs a text search
 * should never pay for it.
 */
async function embed(
    text: string,
    modelId: string,
    cacheDir: string,
): Promise<{ vector: number[]; dims: number }> {
    let module: typeof import('../../../src/lib/localEmbeddings');
    try {
        module = await import('../../../src/lib/localEmbeddings');
    } catch {
        throw new Error(
            "Text search needs the '@xenova/transformers' package. Run: npm install " +
                '@xenova/transformers — or search by row_id instead, which needs no model.',
        );
    }
    const { configureEmbeddingCache, localEmbeddings } = module;
    configureEmbeddingCache(cacheDir);

    const ready = await localEmbeddings.initialize(modelId);
    if (!ready || !localEmbeddings.currentModel) {
        throw new Error(
            `Could not load the embedding model "${modelId}": ` +
                `${localEmbeddings.error ?? 'unknown error'}`,
        );
    }
    const vector = await localEmbeddings.embed(text);
    return { vector, dims: localEmbeddings.currentModel.dimensions };
}

/** `[0.1,0.2,...]`, with every element checked to be a finite number. */
function vectorLiteral(vector: number[]): string {
    for (const value of vector) {
        if (!Number.isFinite(value)) throw new Error('The embedding contained a non-finite value.');
    }
    return `'[${vector.join(',')}]'`;
}

function expressions(
    metric: DistanceMetric,
    distance: string,
): { order: string; similarity: string } {
    switch (metric) {
        case '<->':
            // L2 is unbounded above, so it is mapped rather than subtracted.
            return { order: distance, similarity: `1.0 / (1.0 + ${distance})` };
        case '<#>':
            // pgvector returns the *negative* inner product, so negating it
            // gives a score where higher is more similar.
            return { order: distance, similarity: `-(${distance})` };
        case '<=>':
        default:
            return { order: distance, similarity: `1.0 - (${distance})` };
    }
}

export interface SemanticSearchArgs {
    table: string;
    column: string;
    text?: string;
    rowId?: string;
    limit: number;
    metric: DistanceMetric;
}

export async function semanticSearch(
    ctx: ToolContext,
    args: SemanticSearchArgs,
): Promise<ToolResult> {
    if (ctx.db.dialect !== 'postgres') {
        return {
            text:
                'Semantic search needs PostgreSQL with pgvector. This server is ' +
                'connected to SQLite.',
            isError: true,
        };
    }
    if (!args.text && !args.rowId) {
        return {
            text: 'Give either `text` to search for, or `row_id` to find neighbours of.',
            isError: true,
        };
    }
    if (args.text && args.rowId) {
        return { text: 'Give `text` or `row_id`, not both.', isError: true };
    }

    const table = await ctx.db.resolveTable(args.table);
    const vectorColumns = await findVectorColumns(ctx.db);
    const target = vectorColumns.find(
        (c) => c.table === table && c.column.toLowerCase() === args.column.toLowerCase(),
    );
    if (!target) {
        const available = vectorColumns.filter((c) => c.table === table).map((c) => c.column);
        return {
            text:
                `"${args.column}" is not a vector column on ${table}. ` +
                (available.length
                    ? `Vector columns here: ${available.join(', ')}.`
                    : 'This table has no vector columns.'),
            isError: true,
        };
    }

    // Resolved against the catalogue, never interpolated from the caller.
    const quotedTable = ctx.db.quote(table);
    const quotedVector = ctx.db.quote(target.column);
    const limit = Math.max(1, Math.min(args.limit, ctx.config.maxRows));

    let sql: string;
    let describedQuery: string;

    if (args.text) {
        const { vector, dims } = await embed(
            args.text,
            ctx.config.embeddingModelId,
            ctx.config.modelCachePath,
        );
        if (dims !== target.dimensions) {
            return {
                text:
                    `Dimension mismatch: ${table}.${target.column} holds ${target.dimensions}-` +
                    `dimensional vectors and the "${ctx.config.embeddingModelId}" model ` +
                    `produces ${dims}. Set LITEDB_EMBEDDING_MODEL to one with matching ` +
                    'dimensions (minilm=384, bge-base=768, bge-large=1024), or search by ' +
                    'row_id, which needs no model.',
                isError: true,
            };
        }

        const distance = `${quotedVector} ${args.metric} ${vectorLiteral(vector)}::vector`;
        const { order, similarity } = expressions(args.metric, distance);
        sql =
            `SELECT *, ${distance} AS distance, ${similarity} AS similarity\n` +
            `FROM ${quotedTable}\n` +
            `WHERE ${quotedVector} IS NOT NULL\n` +
            `ORDER BY ${order}\nLIMIT ${limit}`;
        describedQuery = `text "${args.text}" embedded with ${ctx.config.embeddingModelId}`;
    } else {
        const columns = await ctx.db.columns(table);
        const primaryKey = columns.find((c) => c.isPrimaryKey);
        if (!primaryKey) {
            return {
                text:
                    `${table} has no primary key, so there is no id to search from. Use ` +
                    '`text` instead.',
                isError: true,
            };
        }
        const quotedKey = ctx.db.quote(primaryKey.name);
        const id = literal(String(args.rowId));
        const distance = `t.${quotedVector} ${args.metric} source.${quotedVector}`;
        const { order, similarity } = expressions(args.metric, distance);
        sql =
            `SELECT t.*, ${distance} AS distance, ${similarity} AS similarity\n` +
            `FROM ${quotedTable} t\n` +
            `CROSS JOIN (SELECT ${quotedVector} FROM ${quotedTable} ` +
            `WHERE ${quotedKey} = ${id}) source\n` +
            `WHERE t.${quotedKey} <> ${id} AND t.${quotedVector} IS NOT NULL\n` +
            `ORDER BY ${order}\nLIMIT ${limit}`;
        describedQuery = `neighbours of ${primaryKey.name}=${args.rowId}`;
    }

    const started = Date.now();
    // Through `read`, so the engine itself refuses to let a search write.
    const result = await ctx.db.read(sql);
    const durationMs = Date.now() - started;

    await record({
        statements: [
            {
                sql,
                kind: 'read',
                verb: 'SELECT',
                table,
                unbounded: false,
                predicate: null,
                reason: 'semantic search',
            },
        ],
        decision: 'allowed',
        outcome: 'ok',
        durationMs,
        actualRows: result.rows.length,
    });

    if (result.rows.length === 0) {
        return {
            text:
                `No matches for ${describedQuery}. Check that ${table}.${target.column} ` +
                'has non-null vectors' +
                (args.rowId ? ', and that a row with that id exists.' : '.'),
        };
    }

    return {
        text: [
            `${pluralRows(result.rows.length)} for ${describedQuery}, ` +
                `ranked by ${METRIC_LABEL[args.metric]}.`,
            '',
            renderTable(result.columns, result.rows, { maxRows: ctx.config.maxRows }),
            '',
            'Higher `similarity` is closer. Vector columns are summarised as their ' +
                'length rather than printed.',
        ].join('\n'),
    };
}
