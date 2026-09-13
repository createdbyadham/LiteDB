// This service handles SQLite database operations
import { toast } from "@/hooks/use-toast";
import { tauriService } from '@/lib/tauri';
import { assertIdent } from '@/lib/types';
import { assertWritable, ReadOnlyConnectionError } from '@/lib/queryGate';
import { classifyStatement } from '@/lib/sqlClassifier';
import type { TableInfo, ColumnInfo, ForeignKeyInfo, IndexInfo, RowData } from '@/lib/types';

export type { TableInfo, ColumnInfo, ForeignKeyInfo, IndexInfo, RowData };

interface SqlJs {
    Database: new (data: Uint8Array) => Database;
}

interface Database {
    exec(sql: string): QueryResults[];
    close(): void;
    export(): Uint8Array;
    /** Rows changed by the most recent statement. sql.js wraps sqlite3_changes. */
    getRowsModified(): number;
}

interface QueryResults {
    columns?: string[];
    values?: unknown[][];
}

declare global {
    interface Window {
        SQL: SqlJs;
        initSqlJs: (config: { locateFile: (file: string) => string }) => Promise<SqlJs>;
    }
}

class SqliteService {
    private db: Database | null = null;
    private SQL: SqlJs | null = null;
    private initPromise: Promise<SqliteService> | null = null;
    private currentTables: TableInfo[] = [];
    private lastSavedData: Uint8Array | null = null;
    public currentFilePath: string | null = null;
    /** mtime of the file when we last loaded it or successfully wrote it. */
    private diskMtimeMs: number | null = null;
    /** Serializes disk reads/writes so a reload cannot race an in-flight save. */
    private ioChain: Promise<void> = Promise.resolve();

    async init() {
        if (this.SQL) {
            return this;
        }

        if (this.initPromise) {
            await this.initPromise;
            return this;
        }

        this.initPromise = new Promise<SqliteService>((resolve, reject) => {
            const initializeAsync = async () => {
                try {
                    // Load SQL.js script if not already loaded
                    if (!window.initSqlJs) {
                        const script = document.createElement('script');
                        script.src = import.meta.env.PROD ? './sql-wasm.js' : '/sql-wasm.js';
                        script.async = true;
                        document.body.appendChild(script);

                        await new Promise<void>((resolveScript) => {
                            script.onload = () => {
                                resolveScript();
                            };
                            script.onerror = () => {
                                reject(new Error('Failed to load SQL.js script'));
                            };
                        });
                    }

                    // Initialize SQL.js with WASM file
                    this.SQL = await window.initSqlJs({
                        locateFile: (file: string) => {
                            return import.meta.env.PROD ? `./${file}` : `/${file}`;
                        }
                    });

                    resolve(this);
                } catch (error) {
                    console.error("Failed to initialize SQL.js:", error);
                    toast({
                        title: "Error",
                        description: "Failed to initialize database engine",
                        variant: "destructive"
                    });
                    reject(error);
                }
            };

            void initializeAsync();
        });

        await this.initPromise;
        return this;
    }

    async loadDbFromArrayBuffer(buffer: ArrayBuffer, filePath?: string) {
        try {
            if (!this.SQL) {
                await this.init();
            }

            if (!this.SQL) {
                throw new Error("SQL.js failed to initialize");
            }

            const data = new Uint8Array(buffer);
            if (!this.swapInDatabase(data, { keepCurrentOnFailure: false })) {
                return false;
            }

            if (filePath) {
                this.currentFilePath = filePath;
                await this.captureDiskMtime();
            } else {
                this.currentFilePath = null;
                this.diskMtimeMs = null;
            }

            return true;
        } catch (error) {
            console.error("Failed to load database:", error);
            this.currentTables = [];
            this.currentFilePath = null;
            this.diskMtimeMs = null;
            toast({
                title: "Error",
                description: error instanceof Error ? error.message : "Failed to load database",
                variant: "destructive"
            });
            return false;
        }
    }

    /**
     * Open `data` in a new sql.js handle and swap it in only after it parses.
     * A truncated file from an agent must not close the live editor first.
     */
    private swapInDatabase(data: Uint8Array, opts: { keepCurrentOnFailure: boolean }): boolean {
        if (!this.SQL) return false;

        let next: Database;
        try {
            next = new this.SQL.Database(data);
            next.exec("SELECT name FROM sqlite_master LIMIT 1");
        } catch (dbError) {
            console.error("Database creation error:", dbError);
            toast({
                title: "Invalid Database",
                description: "The file appears to be corrupted or not a valid SQLite database.",
                variant: "destructive"
            });
            if (!opts.keepCurrentOnFailure) {
                if (this.db) {
                    this.db.close();
                    this.db = null;
                }
                this.currentTables = [];
                this.currentFilePath = null;
                this.diskMtimeMs = null;
            }
            return false;
        }

        const previous = this.db;
        this.db = next;
        this.lastSavedData = data;
        this.currentTables = this.getTables();
        previous?.close();
        return true;
    }

    getTables(): TableInfo[] {
        if (!this.db) {
            return [];
        }

        try {
            const tables = this.db.exec(
                "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            );

            if (tables.length === 0 || !tables[0].values) {
                return [];
            }

            this.currentTables = tables[0].values.map((row) => ({
                name: row[0] as string,
                sql: row[1] as string
            }));

            return this.currentTables;
        } catch (error) {
            console.error("Error fetching tables:", error);
            toast({
                title: "Error",
                description: "Failed to retrieve table list",
                variant: "destructive"
            });
            return [];
        }
    }

    getTableColumns(tableName: string): ColumnInfo[] {
        if (!this.db) {
            return [];
        }

        try {
            assertIdent(tableName, 'table');
            const pragmaResult = this.db.exec(`PRAGMA table_info('${tableName}')`);

            if (pragmaResult.length === 0 || !pragmaResult[0].values) {
                return [];
            }

            return pragmaResult[0].values.map((row) => ({
                cid: row[0] as number,
                name: row[1] as string,
                type: row[2] as string,
                notnull: row[3] as number,
                pk: row[5] as number
            }));
        } catch (error) {
            console.error(`Error fetching columns for ${tableName}:`, error);
            toast({
                title: "Error",
                description: `Failed to retrieve columns for table ${tableName}`,
                variant: "destructive"
            });
            return [];
        }
    }

    getForeignKeys(tableName: string): ForeignKeyInfo[] {
        if (!this.db) {
            return [];
        }

        try {
            assertIdent(tableName, 'table');
            const pragmaResult = this.db.exec(`PRAGMA foreign_key_list('${tableName}')`);

            if (pragmaResult.length === 0 || !pragmaResult[0].values) {
                return [];
            }

            return pragmaResult[0].values.map((row) => ({
                id: row[0] as number,
                seq: row[1] as number,
                table: row[2] as string,
                from: row[3] as string,
                to: row[4] as string,
                on_update: row[5] as string,
                on_delete: row[6] as string,
                match: row[7] as string
            }));
        } catch (error) {
            console.error(`Error fetching foreign keys for ${tableName}:`, error);
            return [];
        }
    }

    getIndexes(tableName: string): IndexInfo[] {
        if (!this.db) {
            return [];
        }

        try {
            assertIdent(tableName, 'table');
            const indexListResult = this.db.exec(`PRAGMA index_list('${tableName}')`);

            if (indexListResult.length === 0 || !indexListResult[0].values) {
                return [];
            }

            const indexes: IndexInfo[] = [];

            for (const row of indexListResult[0].values) {
                const indexName = row[1] as string;
                const unique = row[2] === 1;

                // Get columns for this index
                const indexInfoResult = this.db.exec(`PRAGMA index_info('${indexName}')`);
                const columns: string[] = [];

                if (indexInfoResult.length > 0 && indexInfoResult[0].values) {
                    for (const colRow of indexInfoResult[0].values) {
                        columns.push(colRow[2] as string);
                    }
                }

                indexes.push({
                    name: indexName,
                    unique,
                    columns
                });
            }

            return indexes;
        } catch (error) {
            console.error(`Error fetching indexes for ${tableName}:`, error);
            return [];
        }
    }

    // Get complete schema information for all tables
    getFullSchema(): {
        tables: Array<{
            name: string;
            columns: ColumnInfo[];
            foreignKeys: ForeignKeyInfo[];
            indexes: IndexInfo[];
        }>;
    } {
        const tables = this.getTables();
        return {
            tables: tables.map(table => ({
                name: table.name,
                columns: this.getTableColumns(table.name),
                foreignKeys: this.getForeignKeys(table.name),
                indexes: this.getIndexes(table.name)
            }))
        };
    }

    getTableData(tableName: string, limit = 1000, offset = 0): { columns: string[], rows: RowData[] } {
        if (!this.db) {
            return { columns: [], rows: [] };
        }

        try {
            assertIdent(tableName, 'table');
            // First get the column information
            const columns = this.getTableColumns(tableName);
            const columnNames = columns.map(col => col.name);
            columnNames.forEach(n => assertIdent(n, 'column'));

            // Execute the query with proper column names
            const result = this.db.exec(
                `SELECT ${columnNames.map(name => `\`${name}\``).join(', ')} FROM \`${tableName}\` LIMIT ${limit} OFFSET ${offset}`
            );

            if (result.length === 0 || !result[0].values) {
                return { columns: columnNames, rows: [] };
            }

            // Map the results to row objects
            const rows = result[0].values.map((row) => {
                const rowData: RowData = {};
                columnNames.forEach((colName, index) => {
                    rowData[colName] = row[index];
                });
                return rowData;
            });

            return { columns: columnNames, rows };
        } catch (error) {
            console.error(`Error fetching data for ${tableName}:`, error);
            toast({
                title: "Error",
                description: `Failed to retrieve data for table ${tableName}`,
                variant: "destructive"
            });
            return { columns: [], rows: [] };
        }
    }

    private async captureDiskMtime(): Promise<void> {
        if (!this.currentFilePath) {
            this.diskMtimeMs = null;
            return;
        }
        this.diskMtimeMs = await tauriService.getFileMtime(this.currentFilePath);
    }

    /**
     * sql.js holds a full copy of the file. If an agent (or anything else)
     * wrote the file since we loaded it, writing our copy back would silently
     * undo that. Refuse, and offer a reload instead.
     */
    private async diskChangedUnderUs(): Promise<boolean> {
        if (!this.currentFilePath || this.diskMtimeMs == null) return false;
        const now = await tauriService.getFileMtime(this.currentFilePath);
        // We had an mtime and now cannot read one: do not overwrite.
        if (now == null) return true;
        return now !== this.diskMtimeMs;
    }

    private offerReloadInsteadOfOverwrite(): void {
        this.dispatchWindowEvent('sqliteFileChangedOnDisk');
    }

    async reloadFromDisk(): Promise<boolean> {
        return this.enqueueIo(() => this.reloadFromDiskNow());
    }

    private async reloadFromDiskNow(): Promise<boolean> {
        if (!this.currentFilePath) return false;
        const path = this.currentFilePath;
        const result = await tauriService.readDatabase(path);
        if (!result.success || !result.data) {
            toast({
                title: "Reload failed",
                description: result.error || "Could not re-read the database file",
                variant: "destructive",
            });
            return false;
        }
        const copy = new Uint8Array(result.data);
        if (!this.swapInDatabase(copy, { keepCurrentOnFailure: true })) {
            return false;
        }
        this.currentFilePath = path;
        await this.captureDiskMtime();
        this.dispatchWindowEvent('sqliteFileReloaded');
        toast({
            title: "Reloaded from disk",
            description: "Editor now matches the file, including any agent writes.",
        });
        return true;
    }

    private enqueueIo<T>(work: () => Promise<T>): Promise<T> {
        const pending = this.ioChain.then(work, work);
        this.ioChain = pending.then(
            () => undefined,
            () => undefined,
        );
        return pending;
    }

    private dispatchWindowEvent(type: string): void {
        const host = globalThis as {
            Event?: new (type: string) => object;
            dispatchEvent?: (event: object) => void;
        };
        if (typeof host.Event !== 'function' || typeof host.dispatchEvent !== 'function') return;
        host.dispatchEvent(new host.Event(type));
    }

    private saveToDisk(): Promise<boolean> {
        return this.enqueueIo(() => this.saveToDiskNow());
    }

    private async saveToDiskNow(): Promise<boolean> {
        if (!this.db || !this.currentFilePath) return false;

        try {
            if (await this.diskChangedUnderUs()) {
                this.offerReloadInsteadOfOverwrite();
                return false;
            }

            this.lastSavedData = this.db.export();
            const result = await tauriService.saveDatabase(this.currentFilePath, this.lastSavedData);

            if (result.success) {
                await this.captureDiskMtime();
                return true;
            } else {
                console.error('Failed to auto-save database:', result.error);
                toast({
                    title: "Auto-save Failed",
                    description: result.error || "Failed to save changes to disk",
                    variant: "destructive"
                });
                return false;
            }
        } catch (error) {
            console.error('Error during auto-save:', error);
            return false;
        }
    }

    executeQuery(sql: string): { columns: string[], rows: unknown[][], rowsAffected: number } | null {
        if (!this.db) {
            return null;
        }

        // Second layer. The SQL editor already asks the gate before it gets
        // here, but a read-only connection has to hold for every caller —
        // including the table editor and anything added later that forgets to
        // ask. Enforcing it at the point of execution is what makes the mode a
        // property of the connection rather than of one screen.
        const classification = classifyStatement(sql);
        if (classification.kind !== 'read') {
            assertWritable(`the ${classification.verb || 'statement'}`);
        }

        try {
            const result = this.db.exec(sql);
            // Read immediately after exec, before saveToDisk or anything else
            // runs a statement of its own and moves the counter.
            //
            // Zero for a read, deliberately: sqlite3_changes reports the last
            // statement that *modified* rows, and a SELECT does not reset it.
            // Without this guard a SELECT run after an UPDATE inherited the
            // UPDATE's count and claimed to have changed rows.
            const rowsAffected =
                classification.kind === 'read' ? 0 : this.db.getRowsModified();

            // Check if this was a modification query and trigger auto-save
            const upperSql = sql.trim().toUpperCase();
            if (this.currentFilePath && (
                upperSql.startsWith('INSERT') || 
                upperSql.startsWith('UPDATE') || 
                upperSql.startsWith('DELETE') || 
                upperSql.startsWith('CREATE') || 
                upperSql.startsWith('DROP') || 
                upperSql.startsWith('ALTER')
            )) {
                void this.saveToDisk();
            }

            if (result.length === 0) {
                return { columns: [], rows: [], rowsAffected };
            }

            return {
                columns: result[0].columns || [],
                rows: result[0].values || [],
                rowsAffected
            };
        } catch (error) {
            console.error("Error executing query:", error);
            throw error;
        }
    }

    executeBatchOperations(sqlStatements: string[], useTransaction = true): { success: boolean; affectedTables: string[]; errors: string[]; rowsAffected: number } {
        if (!this.db) {
            return { success: false, affectedTables: [], errors: ["No database loaded"], rowsAffected: 0 };
        }

        // Track tables that might be affected by the operations
        const affectedTables: Set<string> = new Set();
        const errors: string[] = [];
        // Summed across statements, so a multi-statement script reports what it
        // actually changed rather than only what its last statement did.
        let rowsAffected = 0;

        try {
            // Before BEGIN, not inside the loop: a batch that refuses halfway
            // through leaves the database in a state nobody asked for. Inside
            // this try so a ReadOnlyConnectionError is returned as an error
            // rather than thrown past the caller.
            for (const statement of sqlStatements) {
                const classification = classifyStatement(statement);
                if (classification.kind !== 'read') {
                    assertWritable(`the ${classification.verb || 'statement'}`);
                    break;
                }
            }

            // Start transaction if requested
            if (useTransaction) {
                this.db.exec("BEGIN TRANSACTION");
            }

            // Execute each statement
            for (let i = 0; i < sqlStatements.length; i++) {
                const sql = sqlStatements[i].trim();
                if (!sql) continue; // Skip empty statements

                try {
                    // Execute the statement
                    this.db.exec(sql);
                    // Reads are excluded for the same reason as in
                    // executeQuery: sqlite3_changes still holds the previous
                    // write's count when a SELECT runs.
                    if (classifyStatement(sql).kind !== 'read') {
                        rowsAffected += this.db.getRowsModified();
                    }

                    // Try to identify affected tables from the SQL
                    const tableMatches = sql.match(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\s+`?(\w+)`?/i);
                    if (tableMatches && tableMatches[1]) {
                        affectedTables.add(tableMatches[1]);
                    }
                } catch (error) {
                    const errorMessage = `Error in statement #${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                    errors.push(errorMessage);

                    // If we're in a transaction, we should abort
                    if (useTransaction) {
                        this.db.exec("ROLLBACK");
                        return {
                            success: false,
                            affectedTables: [],
                            errors: [`Batch operation failed and was rolled back. ${errorMessage}`],
                            rowsAffected: 0
                        };
                    }

                    // If not in transaction, continue with next statement
                }
            }

            // If we made it here with a transaction, commit it
            if (useTransaction) {
                this.db.exec("COMMIT");
            }

            // Trigger auto-save if successful and we have a file path
            if (errors.length === 0 && this.currentFilePath) {
                void this.saveToDisk();
            }

            return {
                success: errors.length === 0,
                affectedTables: Array.from(affectedTables),
                errors,
                rowsAffected
            };
        } catch (error) {
            // Handle any unexpected errors
            if (useTransaction) {
                try {
                    this.db.exec("ROLLBACK");
                } catch (rollbackError) {
                    console.error("Error rolling back transaction:", rollbackError);
                }
            }

            return {
                success: false,
                affectedTables: [],
                errors: [error instanceof Error ? error.message : "Unknown error occurred during batch operation"],
                rowsAffected: 0
            };
        }
    }

    updateRow(tableName: string, oldRow: RowData, newRow: RowData): boolean {
        if (!this.db) return false;

        try {
            assertWritable(`the edit to ${tableName}`);
            assertIdent(tableName, 'table');
            // Get primary key column
            const primaryKeyColumn = this.getTableColumns(tableName).find(col => col.pk === 1);
            if (!primaryKeyColumn) {
                throw new Error('Table has no primary key');
            }

            const escapeValue = (v: unknown): string => {
                if (v === null || v === undefined) return 'NULL';
                if (typeof v === 'number' && Number.isFinite(v)) return v.toString();
                if (typeof v === 'boolean') return v ? '1' : '0';
                return `'${String(v).replace(/'/g, "''")}'`;
            };

            const setClause = Object.entries(newRow)
                .filter(([column]) => column !== primaryKeyColumn.name)
                .map(([column, value]) => {
                    assertIdent(column, 'column');
                    return `\`${column}\` = ${escapeValue(value)}`;
                })
                .join(', ');

            assertIdent(primaryKeyColumn.name, 'column');
            const whereClause = `\`${primaryKeyColumn.name}\` = ${escapeValue(oldRow[primaryKeyColumn.name])}`;

            const sql = `UPDATE \`${tableName}\` SET ${setClause} WHERE ${whereClause}`;
            this.db.exec(sql);

            // Auto-save
            if (this.currentFilePath) {
                void this.saveToDisk().then(success => {
                    if (success) {
                        toast({
                            title: "Success",
                            description: "Changes saved to database file"
                        });
                    }
                });
            }

            return true;
        } catch (error) {
            console.error('Error updating row:', error);
            // A refusal is not a malfunction, and silently returning false
            // leaves the user watching their edit revert with no explanation.
            // Say which rule stopped it.
            if (error instanceof ReadOnlyConnectionError) {
                toast({
                    title: "Read-only connection",
                    description: error.message,
                    variant: "destructive"
                });
            }
            return false;
        }
    }

    // Add method to get the current database state
    exportDatabase(): Uint8Array | null {
        if (!this.db) return null;
        const currentData = this.db.export();
        this.lastSavedData = currentData;
        return currentData;
    }

    // Export database to different formats
    exportToFormat(format: 'csv' | 'json' | 'xlsx'): string | null {
        if (!this.db) return null;

        // Get all tables
        const tables = this.getTables();

        if (format === 'json') {
            // Export all tables to JSON
            const result: Record<string, RowData[]> = {};

            for (const table of tables) {
                const data = this.getTableData(table.name);
                result[table.name] = data.rows;
            }

            return JSON.stringify(result, null, 2);
        }

        if (format === 'csv') {
            // Export all tables to CSV (one file with all tables)
            let result = '';

            for (const table of tables) {
                const data = this.getTableData(table.name);

                // Add table name as header
                result += `Table: ${table.name}\n`;

                // Add column headers
                result += data.columns.join(',') + '\n';

                // Add rows
                for (const row of data.rows) {
                    const values = data.columns.map(col => {
                        const value = row[col];
                        if (value === null) return '';
                        if (typeof value === 'string') {
                            // Escape quotes and wrap in quotes if contains comma
                            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                                return `"${value.replace(/"/g, '""')}"`;
                            }
                            return value;
                        }
                        return String(value);
                    });
                    result += values.join(',') + '\n';
                }

                // Add separator between tables
                result += '\n\n';
            }

            return result;
        }

        if (format === 'xlsx') {
            // For Excel, we'll return a JSON representation that the frontend can convert
            // using a library like xlsx or exceljs
            const result: Record<string, { columns: string[]; rows: RowData[] }> = {};

            for (const table of tables) {
                const data = this.getTableData(table.name);
                result[table.name] = {
                    columns: data.columns,
                    rows: data.rows
                };
            }

            return JSON.stringify(result);
        }

        return null;
    }

    // Add method to load database from last saved state
    loadLastSavedState(): boolean {
        if (!this.lastSavedData || !this.SQL) return false;

        try {
            if (this.db) {
                this.db.close();
            }
            this.db = new this.SQL.Database(this.lastSavedData);
            return true;
        } catch (error) {
            console.error('Error loading last saved state:', error);
            return false;
        }
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.diskMtimeMs = null;
    }
}

// Export a singleton instance
export const sqliteService = new SqliteService();
