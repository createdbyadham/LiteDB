// Postgres's catalog, across schemas.
//
// Tables used to be read from `public` alone, so Supabase's `auth` and
// `storage`, and any app with its own schemas, looked empty. Every schema the
// role can use is listed now. A table in the default schema keeps its bare
// name; elsewhere it is `schema.table`, which is also the key the rest of the
// app uses for it.

import { quoteIdent } from '@/lib/types';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, RowData, TableInfo } from '@/lib/types';
import { DbClient, rowsToObjects } from './client';
import { quoteString } from './sqlLiteral';

export interface VectorColumnInfo {
    tableName: string;
    columnName: string;
    dimensions: number;
}

export interface VectorStats {
    dimensions: number;
    min: number;
    max: number;
    mean: number;
    histogram: number[];
}

export interface SimilarityResult {
    row: RowData;
    distance: number;
    similarity: number;
}

export type DistanceMetric = '<=>' | '<->' | '<#>';

function cell(row: unknown[], i: number): string {
    const value = row[i];
    return value == null ? '' : String(value);
}

/**
 * `<tableoid>:<ctid>`. ctid repeats on every partition and inheritance
 * child, so it is not enough to name one row. It still changes when the
 * row is updated: an edit of a row someone else just changed matches
 * nothing, instead of a different row. The ctid comparison stays a TID scan.
 */
export const PG_ROW_LOCATOR_EXPR = "tableoid::text || ':' || ctid::text";

/**
 * tableoid is an unsigned 32-bit oid. A ctid is `(block,offset)`:
 * the block is 32-bit, the offset 16-bit.
 */
const UINT32_MAX = 4294967295n;
const UINT16_MAX = 65535n;
const PG_ROW_ADDRESS = /^(0|[1-9][0-9]{0,9}):\((0|[1-9][0-9]{0,9}),(0|[1-9][0-9]{0,4})\)$/;

export interface PgRowAddress {
    oid: string;
    block: string;
    offset: string;
}

function fitsUint(text: string, max: bigint): boolean {
    return BigInt(text) <= max;
}

/**
 * The pieces of a row address. Null when `value` is not exactly
 * `<oid>:(block,offset)` within those widths: the pieces are written into SQL.
 */
export function parsePgRowAddress(value: unknown): PgRowAddress | null {
    if (typeof value !== 'string') return null;
    const match = PG_ROW_ADDRESS.exec(value);
    if (!match) return null;
    const [, oid, block, offset] = match;
    if (!fitsUint(oid, UINT32_MAX) || !fitsUint(block, UINT32_MAX) || !fitsUint(offset, UINT16_MAX)) return null;
    return { oid, block, offset };
}

/** WHERE naming the one row `PG_ROW_LOCATOR_EXPR` selected. */
export function pgLocatorWhere(value: unknown): string {
    const address = parsePgRowAddress(value);
    if (!address) throw new Error('This row has no usable address.');
    return `tableoid = ${address.oid} AND ctid = ${quoteString(`(${address.block},${address.offset})`)}::tid`;
}

function distanceExpressions(metric: DistanceMetric, left: string, right: string) {
    const distance = `${left} ${metric} ${right}`;
    const similarity =
        metric === '<->' ? `1.0 / (1.0 + ${distance})` : metric === '<#>' ? `-(${distance})` : `1.0 - (${distance})`;
    return { distance, similarity };
}

export class PgClient extends DbClient {
    readonly dialect = 'postgres' as const;
    /** Schemas the role can use, in display order. */
    schemas: string[] = [];
    /** Where unqualified names resolve: the first schema on the search_path. */
    defaultSchema = 'public';
    serverVersionNum = 0;
    hasPgVector = false;
    vectorColumns: VectorColumnInfo[] = [];
    private locations = new Map<string, { schema: string; table: string }>();

    async init(): Promise<void> {
        const info = await this.query(
            "SELECT current_setting('server_version_num')::int, coalesce(current_schema(), 'public')",
        );
        this.serverVersionNum = Number(info.rows[0]?.[0] ?? 0);
        this.defaultSchema = cell(info.rows[0] ?? [], 1) || 'public';
    }

    /** Key for a table: bare in the default schema, `schema.table` elsewhere. */
    keyFor(schema: string, table: string): string {
        return schema === this.defaultSchema ? table : `${schema}.${table}`;
    }

    location(table: string): { schema: string; table: string } {
        const known = this.locations.get(table);
        if (known) return known;
        const dot = table.indexOf('.');
        if (dot > 0 && !this.tables.length) return { schema: table.slice(0, dot), table: table.slice(dot + 1) };
        return { schema: this.defaultSchema, table };
    }

    qualified(table: string): string {
        const { schema, table: name } = this.location(table);
        return `${quoteIdent(schema)}.${quoteIdent(name, 'table')}`;
    }

    /** `'"schema"."table"'::regclass`, the catalog's handle on a table. */
    private regclass(table: string): string {
        return `${quoteString(this.qualified(table))}::regclass`;
    }

    protected async loadTables(): Promise<TableInfo[]> {
        const schemas = await this.query(`
            SELECT n.nspname
            FROM pg_namespace n
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
              AND has_schema_privilege(n.oid, 'USAGE')
            ORDER BY n.nspname = ${quoteString(this.defaultSchema)} DESC, n.nspname`);
        this.schemas = schemas.rows.map((r) => cell(r, 0));

        const partitionFilter = this.serverVersionNum >= 100000 ? 'AND NOT c.relispartition' : '';
        const result = await this.query(`
            SELECT n.nspname, c.relname, c.relkind
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
              AND has_schema_privilege(n.oid, 'USAGE')
              ${partitionFilter}
            ORDER BY n.nspname = ${quoteString(this.defaultSchema)} DESC, n.nspname, c.relname`);

        this.locations.clear();
        const tables: TableInfo[] = [];
        for (const row of result.rows) {
            const schema = cell(row, 0);
            const table = cell(row, 1);
            const kind = cell(row, 2);
            let key = this.keyFor(schema, table);
            // A table literally named "auth.users" in the default schema would
            // collide with auth.users; quote the second one to keep keys unique.
            if (this.locations.has(key)) key = `${quoteIdent(schema)}.${quoteIdent(table)}`;
            this.locations.set(key, { schema, table });
            tables.push({
                name: key,
                schema,
                table,
                sql: '',
                type: kind === 'v' || kind === 'm' ? 'view' : 'table',
            });
        }
        return tables;
    }

    async getColumns(table: string): Promise<ColumnInfo[]> {
        const identity = this.serverVersionNum >= 100000 ? "a.attidentity <> ''" : 'false';
        const generatedCol = this.serverVersionNum >= 120000 ? "a.attgenerated <> ''" : 'false';
        const result = await this.query(`
            SELECT
              a.attnum,
              a.attname,
              format_type(a.atttypid, a.atttypmod),
              CASE WHEN a.attnotnull THEN 1 ELSE 0 END,
              COALESCE((
                SELECT k.ord FROM pg_index i
                CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                WHERE i.indrelid = a.attrelid AND i.indisprimary AND k.attnum = a.attnum
              ), 0),
              pg_get_expr(d.adbin, d.adrelid),
              (${identity} OR ${generatedCol} OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%')
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = ${this.regclass(table)} AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`);
        return result.rows.map((row) => ({
            cid: Number(row[0]),
            name: cell(row, 1),
            type: cell(row, 2),
            notnull: Number(row[3] ?? 0),
            pk: Number(row[4] ?? 0),
            defaultValue: row[5] == null ? null : String(row[5]),
            generated: row[6] === true || row[6] === 't',
        }));
    }

    async getForeignKeys(table: string): Promise<ForeignKeyInfo[]> {
        // pg_catalog, not information_schema: joining key_column_usage to
        // constraint_column_usage pairs every column of a composite key with
        // every other, and only shows tables the current role owns.
        try {
            const result = await this.query(`
                SELECT c.conname, a.attname, rn.nspname, rt.relname, ra.attname,
                       c.confupdtype, c.confdeltype, k.ord
                FROM pg_constraint c
                JOIN pg_class rt ON rt.oid = c.confrelid
                JOIN pg_namespace rn ON rn.oid = rt.relnamespace
                CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refattnum
                WHERE c.contype = 'f' AND c.conrelid = ${this.regclass(table)}
                ORDER BY c.conname, k.ord`);
            const action = (code: string) =>
                ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' } as Record<string, string>)[code] ??
                'NO ACTION';
            const ids = new Map<string, number>();
            return result.rows.map((row) => {
                const name = cell(row, 0);
                if (!ids.has(name)) ids.set(name, ids.size);
                return {
                    id: ids.get(name)!,
                    seq: Number(row[7]) - 1,
                    table: this.keyForExisting(cell(row, 2), cell(row, 3)),
                    from: cell(row, 1),
                    to: cell(row, 4),
                    on_update: action(cell(row, 5)),
                    on_delete: action(cell(row, 6)),
                    match: 'NONE',
                };
            });
        } catch {
            return [];
        }
    }

    /** The key a listed table goes by, so foreign keys match sidebar entries. */
    private keyForExisting(schema: string, table: string): string {
        for (const [key, loc] of this.locations) {
            if (loc.schema === schema && loc.table === table) return key;
        }
        return this.keyFor(schema, table);
    }

    async getIndexes(table: string): Promise<IndexInfo[]> {
        try {
            const result = await this.query(`
                SELECT i.relname, ix.indisunique,
                  COALESCE((
                    SELECT json_agg(a.attname ORDER BY k.ord)
                    FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                  ), '[]'::json)::text
                FROM pg_index ix
                JOIN pg_class i ON i.oid = ix.indexrelid
                WHERE ix.indrelid = ${this.regclass(table)}
                ORDER BY i.relname`);
            return result.rows.map((row) => {
                let columns: string[] = [];
                try {
                    const parsed = JSON.parse(cell(row, 2) || '[]');
                    if (Array.isArray(parsed)) columns = parsed.map(String);
                } catch {
                    columns = [];
                }
                return { name: cell(row, 0), unique: row[1] === true || row[1] === 't', columns };
            });
        } catch {
            return [];
        }
    }

    async getReferencingKeys(table: string): Promise<ReferencingKey[]> {
        const result = await this.query(`
            SELECT c.conname, n.nspname, t.relname,
              (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)::text,
              (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)::text
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.contype = 'f' AND c.confrelid = ${this.regclass(table)}
            ORDER BY n.nspname, t.relname, c.conname`);
        const parse = (text: string): string[] => {
            try {
                const value = JSON.parse(text || '[]');
                return Array.isArray(value) ? value.map(String) : [];
            } catch {
                return [];
            }
        };
        return result.rows.map((row) => ({
            table: this.keyForExisting(cell(row, 1), cell(row, 2)),
            columns: parse(cell(row, 3)),
            refColumns: parse(cell(row, 4)),
        }));
    }

    async getAllColumns(): Promise<Map<string, { name: string; type: string }[]>> {
        const result = await this.query(`
            SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
              AND has_schema_privilege(n.oid, 'USAGE')
            ORDER BY n.nspname, c.relname, a.attnum`);
        const columns = new Map<string, { name: string; type: string }[]>();
        for (const row of result.rows) {
            const key = this.keyForExisting(cell(row, 0), cell(row, 1));
            const list = columns.get(key) ?? [];
            list.push({ name: cell(row, 2), type: cell(row, 3) });
            columns.set(key, list);
        }
        return columns;
    }

    protected async rowLocator(): Promise<string | null> {
        return PG_ROW_LOCATOR_EXPR;
    }

    protected locatorWhere(value: unknown): string {
        return pgLocatorWhere(value);
    }

    protected containsExpr(column: string, pattern: string): string {
        return `${column}::text ILIKE ${pattern} ESCAPE '\\'`;
    }

    protected selectExpr(column: ColumnInfo): string {
        // pgvector reads back as text either way; the cast keeps it exact.
        return column.type.startsWith('vector')
            ? `${quoteIdent(column.name)}::text AS ${quoteIdent(column.name)}`
            : quoteIdent(column.name, 'column');
    }

    /**
     * An exact COUNT(*) scans the whole table on every page. Past a million
     * rows (by the planner's estimate) an unfiltered table shows the estimate.
     */
    protected async countRows(from: string, where: string): Promise<{ total: number; estimated: boolean }> {
        if (!where) {
            try {
                const estimate = await this.query(
                    `SELECT reltuples::bigint FROM pg_class WHERE oid = ${quoteString(from)}::regclass`,
                );
                const n = Number(estimate.rows[0]?.[0] ?? -1);
                if (n > 1_000_000) return { total: n, estimated: true };
            } catch {
                // Fall through to the exact count.
            }
        }
        const result = await this.query(`SELECT COUNT(*)::bigint FROM ${from}${where}`);
        return { total: Number(result.rows[0]?.[0] ?? 0), estimated: false };
    }

    // --- pgvector -------------------------------------------------------------

    async refreshVectorSupport(): Promise<void> {
        try {
            const ext = await this.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
            this.hasPgVector = ext.rows.length > 0;
        } catch {
            this.hasPgVector = false;
        }
        if (!this.hasPgVector) {
            this.vectorColumns = [];
            return;
        }
        try {
            const result = await this.query(`
                SELECT n.nspname, c.relname, a.attname,
                  COALESCE((regexp_match(format_type(a.atttypid, a.atttypmod), 'vector\\((\\d+)\\)'))[1]::int, 0)
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_type ty ON ty.oid = a.atttypid
                WHERE ty.typname = 'vector' AND a.attnum > 0 AND NOT a.attisdropped
                  AND c.relkind IN ('r', 'p', 'v', 'm')
                ORDER BY n.nspname, c.relname, a.attnum`);
            this.vectorColumns = result.rows.map((row) => ({
                tableName: this.keyForExisting(cell(row, 0), cell(row, 1)),
                columnName: cell(row, 2),
                dimensions: Number(row[3] ?? 0) || 0,
            }));
        } catch {
            this.vectorColumns = [];
        }
    }

    getTableVectorColumns(table: string): VectorColumnInfo[] {
        return this.vectorColumns.filter((vc) => vc.tableName === table);
    }

    getTablesWithVectors(): string[] {
        return [...new Set(this.vectorColumns.map((vc) => vc.tableName))];
    }

    parseVector(text: string): number[] {
        if (!text) return [];
        return text
            .replace(/[[\]]/g, '')
            .split(',')
            .map((v) => parseFloat(v.trim()))
            .filter((v) => !Number.isNaN(v));
    }

    async getVectorStats(table: string, column: string, sampleSize = 100): Promise<VectorStats | null> {
        if (!this.hasPgVector) return null;
        const col = quoteIdent(column);
        const result = await this.query(
            `SELECT ${col}::text FROM ${this.qualified(table)} WHERE ${col} IS NOT NULL LIMIT ${Math.trunc(sampleSize)}`,
        );
        const vectors = result.rows.map((r) => this.parseVector(cell(r, 0))).filter((v) => v.length > 0);
        if (vectors.length === 0) return null;
        const all = vectors.flat();
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (const v of all) {
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
        }
        const bucket = (max - min) / 10 || 1;
        const histogram = new Array(10).fill(0);
        for (const v of all) histogram[Math.min(Math.floor((v - min) / bucket), 9)]++;
        return {
            dimensions: vectors[0].length,
            min,
            max,
            mean: sum / all.length,
            histogram: histogram.map((count: number) => (count / all.length) * 100),
        };
    }

    async findSimilarByRowId(
        table: string,
        vectorColumn: string,
        keyColumn: string,
        rowId: string | number,
        limit = 10,
        metric: DistanceMetric = '<=>',
    ): Promise<SimilarityResult[]> {
        if (!this.hasPgVector) return [];
        const col = quoteIdent(vectorColumn);
        const key = quoteIdent(keyColumn);
        const id = typeof rowId === 'number' ? String(rowId) : quoteString(String(rowId));
        const { distance, similarity } = distanceExpressions(metric, `t.${col}`, `source.${col}`);
        const result = await this.query(`
            SELECT t.*, ${distance} AS distance, ${similarity} AS similarity
            FROM ${this.qualified(table)} t
            CROSS JOIN (SELECT ${col} FROM ${this.qualified(table)} WHERE ${key} = ${id}) source
            WHERE t.${key} != ${id} AND t.${col} IS NOT NULL
            ORDER BY ${distance}
            LIMIT ${Math.trunc(limit)}`);
        return this.similarityRows(result);
    }

    async findSimilarByVector(
        table: string,
        vectorColumn: string,
        vector: number[],
        limit = 10,
        metric: DistanceMetric = '<=>',
    ): Promise<SimilarityResult[]> {
        if (!this.hasPgVector) return [];
        const col = quoteIdent(vectorColumn);
        const literal = `${quoteString(`[${vector.join(',')}]`)}::vector`;
        const { distance, similarity } = distanceExpressions(metric, col, literal);
        const result = await this.query(`
            SELECT *, ${distance} AS distance, ${similarity} AS similarity
            FROM ${this.qualified(table)}
            WHERE ${col} IS NOT NULL
            ORDER BY ${distance}
            LIMIT ${Math.trunc(limit)}`);
        return this.similarityRows(result);
    }

    private similarityRows(result: Awaited<ReturnType<DbClient['query']>>): SimilarityResult[] {
        return rowsToObjects(result).map((row) => ({
            row,
            distance: parseFloat(String(row.distance ?? '')) || 0,
            similarity: parseFloat(String(row.similarity ?? '')) || 0,
        }));
    }
}
