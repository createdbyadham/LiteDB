// Telling the model what is in the database.
//
// This is the half of an MCP database server that decides whether the SQL it
// writes has any chance of being right. The eval harness in `evals/` measured
// that directly: sample values for low-cardinality columns are worth several
// points of execution accuracy on their own, because "customers in Germany"
// against a column storing 'DE' is not something a model can guess.
//
// So `describe_table` returns more than column names — types, keys, foreign
// keys, indexes, and the enumerations a column actually holds — and it gets
// them through the same `schemaSamples` rules the desktop app uses, so the
// privacy and eligibility decisions are made in exactly one place.

import { attachSampleValues } from '../../../src/lib/schemaSamples';
import type { DatabaseSchema } from '../../../src/lib/schemaTypes';
import { record } from '../audit';
import type { Database } from '../db';
import { formatCount } from '../render';
import type { ToolContext, ToolResult } from './query';

/**
 * Cap on the rows a size probe will count.
 *
 * A bare COUNT(*) per table turns `list_tables` into a full scan of the whole
 * database, which is a bad trade for a number that only has to convey "small,
 * big, or enormous". Past the cap the answer is honestly reported as a floor.
 */
const ROW_COUNT_PROBE = 100_000;

/** Schema reads are logged like everything else the model is shown. */
async function logRead(sql: string, durationMs: number): Promise<void> {
    await record({
        statements: [
            {
                sql,
                kind: 'read',
                verb: 'SELECT',
                table: null,
                unbounded: false,
                predicate: null,
                reason: 'schema introspection',
            },
        ],
        decision: 'allowed',
        outcome: 'ok',
        durationMs,
    });
}

async function probeRowCount(
    db: Database,
    table: string,
): Promise<{ count: number; capped: boolean }> {
    const { rows } = await db.read(
        `SELECT COUNT(*) FROM (SELECT 1 FROM ${db.quote(table)} LIMIT ${ROW_COUNT_PROBE}) sub`,
    );
    const count = Number(rows[0]?.[0] ?? 0);
    return { count, capped: count >= ROW_COUNT_PROBE };
}

export async function listTables(ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const names = await ctx.db.tableNames();

    if (names.length === 0) {
        await logRead('list_tables', Date.now() - started);
        return { text: 'This database has no tables.' };
    }

    const lines: string[] = [];
    for (const name of names) {
        const columns = await ctx.db.columns(name);
        let size = 'unknown size';
        try {
            const { count, capped } = await probeRowCount(ctx.db, name);
            size = capped ? `${formatCount(ROW_COUNT_PROBE)}+ rows` : `${formatCount(count)} rows`;
        } catch {
            // A permission problem, or an object that will not take a LIMIT.
            // The table is still worth listing; only its size is unknown.
        }
        const keys = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
        lines.push(
            `  ${name} — ${columns.length} columns, ${size}` +
                (keys.length > 0 ? `, primary key: ${keys.join(', ')}` : ''),
        );
    }

    await logRead('list_tables', Date.now() - started);
    return {
        text: [
            `${names.length} table(s) in ${ctx.config.connectionId}:`,
            '',
            ...lines,
            '',
            'Call describe_table for columns, foreign keys, indexes and the values a ' +
                'column actually holds.',
        ].join('\n'),
    };
}

export async function describeTable(
    ctx: ToolContext,
    table: string,
    includeSampleValues: boolean,
): Promise<ToolResult> {
    const started = Date.now();
    const resolved = await ctx.db.resolveTable(table);
    const columns = await ctx.db.columns(resolved);
    const foreignKeys = await ctx.db.foreignKeys(resolved);
    const indexes = await ctx.db.indexes(resolved);

    const samples: Record<string, string[]> = {};
    if (includeSampleValues) {
        const schema: DatabaseSchema = {
            dialect: ctx.db.dialect,
            tables: [
                {
                    name: resolved,
                    columns: columns.map((c) => ({
                        name: c.name,
                        type: c.type,
                        isPrimaryKey: c.isPrimaryKey,
                        isNotNull: c.isNotNull,
                    })),
                },
            ],
        };
        // Sampled through the read connection, so this tool cannot see
        // anything a plain SELECT through this server could not.
        const enriched = await attachSampleValues(
            schema,
            async (sql) => (await ctx.db.read(sql)).rows,
        );
        for (const column of enriched.tables[0]?.columns ?? []) {
            if (column.sampleValues?.length) samples[column.name] = column.sampleValues;
        }
    }

    const fkByColumn = new Map(foreignKeys.map((fk) => [fk.column, fk]));
    const columnLines = columns.map((c) => {
        const flags: string[] = [];
        if (c.isPrimaryKey) flags.push('PRIMARY KEY');
        if (c.isNotNull) flags.push('NOT NULL');
        if (c.defaultValue !== null) flags.push(`DEFAULT ${c.defaultValue}`);
        const fk = fkByColumn.get(c.name);
        if (fk) flags.push(`-> ${fk.referencesTable}.${fk.referencesColumn}`);
        const sample = samples[c.name];
        if (sample) flags.push(`values: ${sample.join(', ')}`);
        return `  ${c.name} ${c.type}${flags.length ? `  [${flags.join('; ')}]` : ''}`;
    });

    const sections = [`Table: ${resolved}`, '', 'Columns:', ...columnLines];

    if (indexes.length > 0) {
        sections.push(
            '',
            'Indexes:',
            ...indexes.map(
                (i) => `  ${i.name}${i.unique ? ' (unique)' : ''} on ${i.columns.join(', ')}`,
            ),
        );
    }

    if (foreignKeys.length > 0) {
        sections.push(
            '',
            'Foreign keys:',
            ...foreignKeys.map(
                (fk) => `  ${fk.column} -> ${fk.referencesTable}.${fk.referencesColumn}`,
            ),
        );
    }

    await logRead(`describe_table(${resolved})`, Date.now() - started);
    return { text: sections.join('\n') };
}

/** The whole schema as one document, for the `litedb://schema` resource. */
export async function renderSchema(ctx: ToolContext): Promise<string> {
    const names = await ctx.db.tableNames();
    const parts: string[] = [
        `${ctx.db.dialect} database ${ctx.config.connectionId}`,
        `policy: ${ctx.config.policy}`,
        '',
    ];
    for (const name of names) {
        const described = await describeTable(ctx, name, false);
        parts.push(described.text, '');
    }
    return parts.join('\n');
}
