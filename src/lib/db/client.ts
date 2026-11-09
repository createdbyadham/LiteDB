// One open database, whichever engine it is.
//
// The grid, the editor, the schema view and the importers talk to a DbClient
// and never to an engine directly. The engine-specific parts, catalog
// queries, quoting, how a row without a key is addressed, are the abstract
// methods; everything built on them (paging, filters, edits, import, export)
// is written once here, so SQLite and Postgres behave the same.

import { quoteIdent, primaryKeyColumns, escapeLike, ROW_LOCATOR } from '@/lib/types';
import type {
    ColumnFilter,
    ColumnInfo,
    ForeignKeyInfo,
    IndexInfo,
    ReferencingKey,
    RowData,
    TableInfo,
    TablePage,
    TableQuery,
} from '@/lib/types';
import type { SqlDialect } from '@/lib/schemaTypes';
import { classifyStatement } from '@/lib/sqlClassifier';
import { assertWritable } from '@/lib/queryGate';
import { dbClose, dbRun, QueryError, type RunOptions, type RunResponse, type StatementResult } from './native';
import { quoteString, sqlLiteral } from './sqlLiteral';

const EMPTY_RESULT: StatementResult = {
    statement: 0,
    columns: [],
    columnTypes: [],
    rows: [],
    returnsRows: false,
    rowsAffected: 0,
    truncated: false,
    elapsedMs: 0,
};

/** Rows per INSERT when importing. SQLite caps a VALUES list at 500 terms. */
const IMPORT_CHUNK_ROWS = 200;

export function rowsToObjects(result: StatementResult): RowData[] {
    return result.rows.map((row) => {
        const obj: RowData = {};
        result.columns.forEach((column, i) => {
            obj[column] = row[i];
        });
        return obj;
    });
}

export abstract class DbClient {
    abstract readonly dialect: SqlDialect;
    /** Every table and view, refreshed by `refreshTables`. */
    tables: TableInfo[] = [];

    /**
     * @param id Runtime id of the connection in Rust.
     * @param policyId Key the safety policy is stored under for this database.
     */
    constructor(
        public readonly id: string,
        public readonly policyId: string,
    ) {}

    // --- engine-specific ----------------------------------------------------

    protected abstract loadTables(): Promise<TableInfo[]>;
    abstract getColumns(table: string): Promise<ColumnInfo[]>;
    abstract getForeignKeys(table: string): Promise<ForeignKeyInfo[]>;
    abstract getIndexes(table: string): Promise<IndexInfo[]>;
    abstract getReferencingKeys(table: string): Promise<ReferencingKey[]>;
    /** Every column of every table in one catalog query, for autocomplete. */
    abstract getAllColumns(): Promise<Map<string, { name: string; type: string }[]>>;
    /** The table as SQL: quoted, and schema-qualified where that applies. */
    abstract qualified(table: string): string;
    /** Expression selecting a row's physical address, or null if it has none. */
    protected abstract rowLocator(table: string): Promise<string | null>;
    /** WHERE condition naming one row by the address `rowLocator` returned. */
    protected abstract locatorWhere(value: unknown): string;
    /** A column read as text and matched case-insensitively against a LIKE pattern. */
    protected abstract containsExpr(column: string, pattern: string): string;
    /** How a column is selected for display (pgvector needs a cast). */
    protected abstract selectExpr(column: ColumnInfo): string;
    /** A row count that may be estimated when the table is large. */
    protected async countRows(from: string, where: string): Promise<{ total: number; estimated: boolean }> {
        const result = await this.query(`SELECT COUNT(*) FROM ${from}${where}`);
        return { total: Number(result.rows[0]?.[0] ?? 0), estimated: false };
    }

    // --- running SQL ----------------------------------------------------------

    run(statements: string[], options: RunOptions = {}): Promise<RunResponse> {
        return dbRun(this.id, statements, options);
    }

    /** One read for the app's own use. Throws on error; returns the last result set. */
    async query(sql: string, options: RunOptions = {}): Promise<StatementResult> {
        const response = await this.run([sql], options);
        if (response.errors.length > 0) throw new QueryError(response.errors[0]);
        return response.results[response.results.length - 1] ?? EMPTY_RESULT;
    }

    async queryObjects(sql: string): Promise<RowData[]> {
        return rowsToObjects(await this.query(sql));
    }

    /**
     * Statements a person or a model wrote. A second line of defence behind
     * the gate: on a read-only connection anything but a read is refused here
     * too, whichever screen sent it.
     */
    execute(statements: string[], options: RunOptions = {}): Promise<RunResponse> {
        for (const sql of statements) {
            const classification = classifyStatement(sql);
            if (classification.kind !== 'read') {
                assertWritable(`the ${classification.verb || 'statement'}`, this.policyId);
            }
        }
        return this.run(statements, options);
    }

    async close(): Promise<void> {
        await dbClose(this.id);
    }

    // --- tables -----------------------------------------------------------------

    async refreshTables(): Promise<TableInfo[]> {
        this.tables = await this.loadTables();
        return this.tables;
    }

    tableInfo(table: string): TableInfo | undefined {
        return this.tables.find((t) => t.name === table);
    }

    isView(table: string): boolean {
        return this.tableInfo(table)?.type === 'view';
    }

    async getFullSchema(tables: TableInfo[] = this.tables): Promise<{
        tables: Array<{ name: string; columns: ColumnInfo[]; foreignKeys: ForeignKeyInfo[]; indexes: IndexInfo[] }>;
    }> {
        return {
            tables: await Promise.all(
                tables.map(async (t) => ({
                    name: t.name,
                    columns: await this.getColumns(t.name),
                    foreignKeys: await this.getForeignKeys(t.name),
                    indexes: await this.getIndexes(t.name),
                })),
            ),
        };
    }

    // --- the grid ---------------------------------------------------------------

    private filterExpr(filter: ColumnFilter, columns: ColumnInfo[]): string | null {
        if (!columns.some((c) => c.name === filter.column)) return null;
        const col = quoteIdent(filter.column, 'column');
        switch (filter.op) {
            case 'is null':
                return `${col} IS NULL`;
            case 'is not null':
                return `${col} IS NOT NULL`;
            case 'contains':
                return this.containsExpr(col, quoteString(`%${escapeLike(String(filter.value ?? ''))}%`));
            default: {
                if (filter.value === null) return filter.op === '!=' ? `${col} IS NOT NULL` : `${col} IS NULL`;
                return `${col} ${filter.op} ${sqlLiteral(filter.value, this.dialect)}`;
            }
        }
    }

    /**
     * One page of a table with search, filters and sort applied in SQL, plus
     * the matching row count, so every row is reachable, not just the first
     * thousand.
     */
    async queryTable(table: string, q: TableQuery): Promise<TablePage> {
        const columns = await this.getColumns(table);
        if (columns.length === 0) return { columns: [], rows: [], total: 0 };
        const names = columns.map((c) => c.name);
        const from = this.qualified(table);
        const readOnly = this.isView(table);
        const locator = !readOnly && primaryKeyColumns(columns).length === 0 ? await this.rowLocator(table) : null;

        const conditions: string[] = [];
        const search = q.search?.trim();
        if (search) {
            const pattern = quoteString(`%${escapeLike(search)}%`);
            conditions.push(`(${names.map((n) => this.containsExpr(quoteIdent(n, 'column'), pattern)).join(' OR ')})`);
        }
        for (const filter of q.filters ?? []) {
            const expr = this.filterExpr(filter, columns);
            if (expr) conditions.push(expr);
        }
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

        let order = '';
        if (q.sortColumn && names.includes(q.sortColumn)) {
            const col = quoteIdent(q.sortColumn, 'column');
            if (this.dialect === 'postgres') {
                order = q.sortDirection === 'desc' ? ` ORDER BY ${col} DESC NULLS LAST` : ` ORDER BY ${col} ASC NULLS FIRST`;
            } else {
                order = ` ORDER BY ${col} ${q.sortDirection === 'desc' ? 'DESC' : 'ASC'}`;
            }
        }

        const limit = Math.max(1, Math.trunc(q.limit));
        const offset = Math.max(0, Math.trunc(q.offset));
        const select = columns.map((c) => this.selectExpr(c)).join(', ') + (locator ? `, ${locator} AS ${quoteIdent(ROW_LOCATOR)}` : '');

        const [count, page] = await Promise.all([
            this.countRows(from, where),
            this.query(`SELECT ${select} FROM ${from}${where}${order} LIMIT ${limit} OFFSET ${offset}`),
        ]);

        return {
            columns: names,
            rows: rowsToObjects(page),
            total: count.total,
            totalEstimated: count.estimated,
            readOnly,
            rowLocator: locator ? ROW_LOCATOR : undefined,
        };
    }

    // --- writes -------------------------------------------------------------------

    private assertTableWritable(table: string, operation: string): void {
        assertWritable(operation, this.policyId);
        if (this.isView(table)) throw new Error(`${table} is a view, so it is read-only.`);
    }

    /**
     * WHERE clause naming exactly one row by its whole primary key, or by its
     * physical address when the table has none. Using only the first key
     * column once rewrote every row that shared it.
     */
    keyWhere(keyColumns: ColumnInfo[], row: RowData): string {
        if (keyColumns.length === 0) {
            const locator = row[ROW_LOCATOR];
            if (locator === undefined || locator === null) {
                throw new Error('This table has no primary key, so a single row cannot be addressed. Use the SQL editor.');
            }
            return this.locatorWhere(locator);
        }
        return keyColumns
            .map((col) => {
                const value = row[col.name];
                if (value === undefined) throw new Error(`The row is missing its key column ${col.name}.`);
                const quoted = quoteIdent(col.name, 'column');
                return value === null ? `${quoted} IS NULL` : `${quoted} = ${sqlLiteral(value, this.dialect)}`;
            })
            .join(' AND ');
    }

    /** Insert one row. Columns left out (undefined) take their default. Returns the SQL that ran. */
    async insertRow(table: string, values: RowData): Promise<string> {
        this.assertTableWritable(table, `the insert into ${table}`);
        const entries = Object.entries(values).filter(([column, value]) => column !== ROW_LOCATOR && value !== undefined);
        const sql = entries.length === 0
            ? `INSERT INTO ${this.qualified(table)} DEFAULT VALUES`
            : `INSERT INTO ${this.qualified(table)} (${entries.map(([c]) => quoteIdent(c, 'column')).join(', ')}) VALUES (${entries
                  .map(([, v]) => sqlLiteral(v, this.dialect))
                  .join(', ')})`;
        await this.query(sql);
        return sql;
    }

    /**
     * Write only the columns the edit changed. The grid refreshes under an
     * open edit when an agent writes, and writing back every column would
     * quietly revert the agent's other changes. Returns the SQL that ran.
     */
    async updateRow(table: string, oldRow: RowData, newRow: RowData): Promise<string | null> {
        this.assertTableWritable(table, `the edit to ${table}`);
        const keyColumns = primaryKeyColumns(await this.getColumns(table));
        const changed = Object.entries(newRow).filter(
            ([column, value]) => column !== ROW_LOCATOR && value !== oldRow[column],
        );
        if (changed.length === 0) return null;
        const set = changed.map(([column, value]) => `${quoteIdent(column, 'column')} = ${sqlLiteral(value, this.dialect)}`).join(', ');
        const sql = `UPDATE ${this.qualified(table)} SET ${set} WHERE ${this.keyWhere(keyColumns, oldRow)}`;
        const result = await this.query(sql);
        if (result.rowsAffected === 0) {
            throw new Error('The row no longer exists. It may have been changed or deleted elsewhere.');
        }
        return sql;
    }

    /** Delete rows named by their whole key, in one transaction. Returns the statements. */
    async deleteRows(table: string, rows: RowData[]): Promise<string[]> {
        if (rows.length === 0) return [];
        this.assertTableWritable(table, `the row deletion from ${table}`);
        const keyColumns = primaryKeyColumns(await this.getColumns(table));
        const from = this.qualified(table);
        const statements = rows.map((row) => `DELETE FROM ${from} WHERE ${this.keyWhere(keyColumns, row)}`);
        const response = await this.run(statements, { transaction: true });
        if (response.errors.length > 0) throw new QueryError(response.errors[0]);
        return statements;
    }

    /**
     * Insert many rows in one transaction, all or nothing. Values are written
     * as literals and the database converts them to each column's type, which
     * is what makes a CSV of text land in integer and date columns.
     */
    async importRows(
        table: string,
        columns: string[],
        rows: unknown[][],
    ): Promise<{ inserted: number; statements: number }> {
        this.assertTableWritable(table, `the import into ${table}`);
        if (rows.length === 0) return { inserted: 0, statements: 0 };
        const head = `INSERT INTO ${this.qualified(table)} (${columns.map((c) => quoteIdent(c, 'column')).join(', ')}) VALUES `;
        const statements: string[] = [];
        for (let i = 0; i < rows.length; i += IMPORT_CHUNK_ROWS) {
            const chunk = rows.slice(i, i + IMPORT_CHUNK_ROWS);
            statements.push(head + chunk.map((row) => `(${row.map((v) => sqlLiteral(v, this.dialect)).join(', ')})`).join(', '));
        }
        const response = await this.run(statements, { transaction: true });
        if (response.errors.length > 0) {
            const error = response.errors[0];
            const firstRow = error.statement * IMPORT_CHUNK_ROWS + 1;
            throw new Error(`Nothing was imported. Rows ${firstRow.toLocaleString()}–${Math.min(firstRow + IMPORT_CHUNK_ROWS - 1, rows.length).toLocaleString()} failed: ${error.message}`);
        }
        return { inserted: response.results.reduce((n, r) => n + r.rowsAffected, 0), statements: statements.length };
    }

    /** Create a table for an import. Returns the statement that ran. */
    async createTable(table: string, columns: { name: string; type: string }[]): Promise<string> {
        assertWritable(`creating ${table}`, this.policyId);
        const sql = `CREATE TABLE ${this.qualified(table)} (${columns.map((c) => `${quoteIdent(c.name, 'column')} ${c.type}`).join(', ')})`;
        await this.query(sql);
        return sql;
    }

    /** Every row of a table, blobs included, for export. */
    async exportTable(table: string): Promise<{ columns: string[]; rows: RowData[] }> {
        const columns = await this.getColumns(table);
        if (columns.length === 0) return { columns: [], rows: [] };
        const result = await this.query(
            `SELECT ${columns.map((c) => this.selectExpr(c)).join(', ')} FROM ${this.qualified(table)}`,
            { fullBlobs: true },
        );
        return { columns: columns.map((c) => c.name), rows: rowsToObjects(result) };
    }
}
