// SQLite's catalog: sqlite_master and the table_info family of pragmas.

import { quoteIdent } from '@/lib/types';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ReferencingKey, TableInfo } from '@/lib/types';
import { DbClient } from './client';

export class SqliteClient extends DbClient {
    readonly dialect = 'sqlite' as const;
    private rowidCache = new Map<string, boolean>();

    constructor(
        id: string,
        policyId: string,
        public readonly path: string,
    ) {
        super(id, policyId);
    }

    protected async loadTables(): Promise<TableInfo[]> {
        this.rowidCache.clear();
        const result = await this.query(
            "SELECT name, sql, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name COLLATE NOCASE",
        );
        return result.rows.map((row) => ({
            name: String(row[0]),
            table: String(row[0]),
            sql: row[1] == null ? '' : String(row[1]),
            type: row[2] === 'view' ? ('view' as const) : ('table' as const),
        }));
    }

    async getColumns(table: string): Promise<ColumnInfo[]> {
        // table_xinfo also lists generated columns (hidden 2 and 3); hidden 1 is
        // a virtual table's internal column and stays out.
        const result = await this.query(`PRAGMA table_xinfo(${quoteIdent(table, 'table')})`);
        const columns = result.rows
            .filter((row) => Number(row[6] ?? 0) !== 1)
            .map((row) => ({
                cid: Number(row[0]),
                name: String(row[1]),
                type: String(row[2] ?? ''),
                notnull: Number(row[3] ?? 0),
                defaultValue: row[4] == null ? null : String(row[4]),
                pk: Number(row[5] ?? 0),
                generated: Number(row[6] ?? 0) >= 2,
            }));
        // A lone INTEGER PRIMARY KEY is the rowid: SQLite fills it in.
        const keys = columns.filter((c) => c.pk > 0);
        if (keys.length === 1 && keys[0].type.toUpperCase() === 'INTEGER') keys[0].generated = true;
        return columns;
    }

    async getForeignKeys(table: string): Promise<ForeignKeyInfo[]> {
        try {
            const result = await this.query(`PRAGMA foreign_key_list(${quoteIdent(table, 'table')})`);
            return result.rows.map((row) => ({
                id: Number(row[0]),
                seq: Number(row[1]),
                table: this.canonicalTable(String(row[2])),
                from: String(row[3]),
                // NULL "to" means the parent's primary key.
                to: row[4] == null ? '' : String(row[4]),
                on_update: String(row[5] ?? ''),
                on_delete: String(row[6] ?? ''),
                match: String(row[7] ?? ''),
            }));
        } catch {
            return [];
        }
    }

    /** SQLite matches table names case-insensitively; use the name as declared. */
    private canonicalTable(name: string): string {
        return this.tables.find((t) => t.name.toLowerCase() === name.toLowerCase())?.name ?? name;
    }

    async getIndexes(table: string): Promise<IndexInfo[]> {
        try {
            const list = await this.query(`PRAGMA index_list(${quoteIdent(table, 'table')})`);
            const indexes: IndexInfo[] = [];
            for (const row of list.rows) {
                const name = String(row[1]);
                const info = await this.query(`PRAGMA index_info(${quoteIdent(name)})`);
                indexes.push({
                    name,
                    unique: Number(row[2]) === 1,
                    columns: info.rows.map((r) => String(r[2] ?? '')),
                });
            }
            return indexes;
        } catch {
            return [];
        }
    }

    async getReferencingKeys(table: string): Promise<ReferencingKey[]> {
        const target = table.toLowerCase();
        const found: ReferencingKey[] = [];
        for (const other of this.tables) {
            if (other.type === 'view') continue;
            const keys = await this.getForeignKeys(other.name);
            const byId = new Map<number, ReferencingKey>();
            for (const fk of keys) {
                if (fk.table.toLowerCase() !== target) continue;
                const entry = byId.get(fk.id) ?? { table: other.name, columns: [], refColumns: [] };
                entry.columns.push(fk.from);
                entry.refColumns.push(fk.to);
                byId.set(fk.id, entry);
            }
            found.push(...byId.values());
        }
        // A NULL target column means the parent's primary key.
        if (found.some((k) => k.refColumns.some((c) => !c))) {
            const pk = (await this.getColumns(table)).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
            for (const key of found) key.refColumns = key.refColumns.map((c, i) => c || pk[i] || c);
        }
        return found;
    }

    async getAllColumns(): Promise<Map<string, { name: string; type: string }[]>> {
        const result = await this.query(
            "SELECT m.name, p.name, p.type FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
                "WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid",
        );
        const columns = new Map<string, { name: string; type: string }[]>();
        for (const row of result.rows) {
            const table = String(row[0]);
            const list = columns.get(table) ?? [];
            list.push({ name: String(row[1]), type: String(row[2] ?? '') });
            columns.set(table, list);
        }
        return columns;
    }

    qualified(table: string): string {
        return quoteIdent(table, 'table');
    }

    /** WITHOUT ROWID tables always have a primary key, so they never get here. */
    protected async rowLocator(table: string): Promise<string | null> {
        let has = this.rowidCache.get(table);
        if (has === undefined) {
            try {
                await this.query(`SELECT rowid FROM ${this.qualified(table)} LIMIT 0`);
                has = true;
            } catch {
                has = false;
            }
            this.rowidCache.set(table, has);
        }
        return has ? 'rowid' : null;
    }

    protected locatorWhere(value: unknown): string {
        // Rowids past 2^53 arrive as strings so they stay exact.
        if (typeof value === 'number' && Number.isInteger(value)) return `rowid = ${value}`;
        if (typeof value === 'string' && /^-?\d+$/.test(value)) return `rowid = ${value}`;
        throw new Error('This row has no usable rowid.');
    }

    protected containsExpr(column: string, pattern: string): string {
        return `CAST(${column} AS TEXT) LIKE ${pattern} ESCAPE '\\'`;
    }

    protected selectExpr(column: ColumnInfo): string {
        return quoteIdent(column.name, 'column');
    }
}
