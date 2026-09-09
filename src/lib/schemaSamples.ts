// Sample-value collection for the Text-to-SQL schema context.
//
// Column names and types alone cannot resolve an enumerated column. Asked for
// "customers in Germany" against `country TEXT`, a model can only guess
// 'Germany' — while the table actually stores 'DE'. Showing a few distinct
// values turns that guess into a lookup.
//
// This sends real cell values to the configured model, so collection is
// deliberately narrow: short values, from low-cardinality columns, never from
// columns whose name suggests a secret or personal data. A column that looks
// like free text or identifiers is skipped entirely rather than truncated.
//
// Kept free of browser, Tauri and network imports: the desktop app and the
// eval harness both depend on it, and must apply identical rules.

import type { ColumnSchema, DatabaseSchema, SqlDialect } from './schemaTypes';

export const SAMPLE_LIMITS = {
    /** Above this many distinct values a column is not an enumeration. */
    maxDistinct: 20,
    /** How many values actually reach the prompt. */
    maxSamples: 12,
    /** Longer than this and the column is treated as free text. */
    maxValueLength: 40,
} as const;

/** Types whose values are worth showing. Numeric and temporal columns are not. */
const TEXTUAL_TYPE = /char|text|string|enum|clob/i;

/**
 * Columns never sampled regardless of cardinality. A two-row table of API keys
 * is low-cardinality and must still never reach a cloud provider.
 */
const SENSITIVE_NAME =
    /pass|pwd|secret|token|key|hash|salt|ssn|social|credit|card|cvv|iban|email|phone|mobile|address|dob|birth/i;

/**
 * Prose columns. Their values are unbounded in practice, so a handful of short
 * ones is misleading context rather than a useful enumeration — and free text
 * is the likeliest place for something private to sit.
 */
const FREE_TEXT_NAME =
    /comment|description|note|body|message|summary|bio|content|remark|feedback|review|title|label/i;

/** ISO dates and timestamps, which SQLite stores in TEXT columns. */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

export function isSampleCandidate(column: ColumnSchema): boolean {
    if (column.isPrimaryKey) return false;
    if (SENSITIVE_NAME.test(column.name)) return false;
    if (FREE_TEXT_NAME.test(column.name)) return false;
    return TEXTUAL_TYPE.test(column.type);
}

/**
 * Cheap bounded row count. A plain COUNT(*) can seq-scan a large table, which
 * is unacceptable latency for a desktop client on connect, so this only asks
 * whether the table is bigger than the probe limit.
 */
export function buildRowProbeQuery(table: string, dialect: SqlDialect): string | null {
    if (!IDENT_RE.test(table)) return null;
    const q = dialect === 'postgres' ? '"' : '`';
    return `SELECT COUNT(*) FROM (SELECT 1 FROM ${q}${table}${q} LIMIT ${ROW_PROBE_LIMIT}) sub`;
}

/** Beyond this many rows, a column with few distinct values is a real enum. */
export const ROW_PROBE_LIMIT = 201;

// Identifiers cannot be parameterised, so they are allowlisted before quoting.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildDistinctQuery(
    table: string,
    column: string,
    dialect: SqlDialect,
): string | null {
    if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) return null;
    const q = dialect === 'postgres' ? '"' : '`';
    // One more than the cap, so "hit the limit" distinguishes a genuine
    // enumeration from a high-cardinality column without a COUNT scan.
    return (
        `SELECT DISTINCT ${q}${column}${q} FROM ${q}${table}${q} ` +
        `WHERE ${q}${column}${q} IS NOT NULL LIMIT ${SAMPLE_LIMITS.maxDistinct + 1}`
    );
}

/**
 * Reduce raw distinct rows to prompt-ready samples, or null when the column
 * fails any guard. Sorted for stable prompts, which keeps runs comparable and
 * keeps prompt caching effective.
 */
export function normalizeSamples(rows: unknown[][], rowCount?: number): string[] | null {
    if (rows.length === 0) return null;
    if (rows.length > SAMPLE_LIMITS.maxDistinct) return null;

    // Few distinct values only means "enumeration" relative to table size. In
    // an 8-row table, 8 distinct names is a unique identifier, not an enum —
    // and dumping it puts every customer name in the prompt. Above the probe
    // limit the table is large enough that a low distinct count is meaningful
    // on its own.
    if (rowCount !== undefined && rowCount < ROW_PROBE_LIMIT && rows.length >= rowCount) {
        return null;
    }

    const values: string[] = [];
    for (const row of rows) {
        const cell = row[0];
        if (cell === null || cell === undefined) continue;
        if (typeof cell !== 'string') return null;
        // A single long value marks the column as free text; partial samples
        // of prose are noise in the prompt and a needless disclosure.
        if (cell.length > SAMPLE_LIMITS.maxValueLength) return null;
        values.push(cell);
    }

    if (values.length === 0) return null;
    // SQLite has no date type, so date columns arrive as TEXT and would
    // otherwise be sampled. Listing twelve dates teaches the model nothing and
    // costs as many tokens as a useful enumeration.
    if (values.every((v) => DATE_LIKE.test(v))) return null;

    return [...new Set(values)].sort().slice(0, SAMPLE_LIMITS.maxSamples);
}

export type QueryRunner = (sql: string) => Promise<unknown[][] | null>;

/**
 * Return a copy of `schema` with sample values attached where they apply.
 *
 * Best-effort by design: a permission error or an exotic type on one column
 * must not cost the model its entire schema context, so failures are dropped
 * silently and that column simply carries no samples.
 */
export async function attachSampleValues(
    schema: DatabaseSchema,
    runQuery: QueryRunner,
): Promise<DatabaseSchema> {
    const tables = await Promise.all(
        schema.tables.map(async (table) => {
            const candidates = table.columns.filter(isSampleCandidate);
            if (candidates.length === 0) return table;

            // One bounded probe per table, not per column.
            let rowCount: number | undefined;
            const probeSql = buildRowProbeQuery(table.name, schema.dialect);
            if (probeSql) {
                try {
                    const probeRows = await runQuery(probeSql);
                    const raw = probeRows?.[0]?.[0];
                    const parsed = typeof raw === 'string' ? Number(raw) : raw;
                    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
                        rowCount = parsed;
                    }
                } catch {
                    // Leave undefined; the distinct cap still applies.
                }
            }

            const columns = await Promise.all(
                table.columns.map(async (column) => {
                    if (!isSampleCandidate(column)) return column;

                    const sql = buildDistinctQuery(table.name, column.name, schema.dialect);
                    if (!sql) return column;

                    try {
                        const rows = await runQuery(sql);
                        if (!rows) return column;
                        const sampleValues = normalizeSamples(rows, rowCount);
                        return sampleValues ? { ...column, sampleValues } : column;
                    } catch {
                        return column;
                    }
                }),
            );
            return { ...table, columns };
        }),
    );

    return { ...schema, tables };
}
