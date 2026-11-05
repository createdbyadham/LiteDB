// This service handles SQLite database operations
import { toast } from "@/hooks/use-toast";
import { tauriService } from '@/lib/tauri';
import { quoteIdent, primaryKeyColumns, escapeLike, ROW_LOCATOR } from '@/lib/types';
import type { TableQuery, TablePage } from '@/lib/types';
import { csvRow, rowsToJson } from '@/lib/exportFormat';
import { buildXlsx } from '@/lib/xlsx';
import { assertWritable, ReadOnlyConnectionError } from '@/lib/queryGate';
import { classifyStatement } from '@/lib/sqlClassifier';
import { saveWouldClobber, type DiskAlert, type DiskSnapshot } from '@/lib/diskGuard';
import type { TableInfo, ColumnInfo, ForeignKeyInfo, IndexInfo, RowData } from '@/lib/types';

export type { TableInfo, ColumnInfo, ForeignKeyInfo, IndexInfo, RowData };

interface SqlJs {
    Database: new (data: Uint8Array) => Database;
}

interface Database {
    exec(sql: string, params?: (string | number | null)[]): QueryResults[];
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
    /** The file as of the last successful load or save. */
    private lastSnapshot: DiskSnapshot | null = null;
    /** Local writes that have not landed on disk. */
    private dirty = false;
    private alert: DiskAlert | null = null;
    /** Poll-driven save retries back off so a stuck file is not re-exported every second. */
    private saveRetryDelayMs = 0;
    private saveRetryAt = 0;
    /** A version of the file that failed to reload; not retried until it changes again. */
    private unreadableMtime: number | null = null;
    /** Serializes disk reads/writes so a reload cannot race an in-flight save. */
    private ioChain: Promise<void> = Promise.resolve();
    // ponytail: 1s poll of mtime+wal, native fs.watch if lag matters
    private watchTimer: ReturnType<typeof setInterval> | null = null;
    private watchQueued = false;

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

    /**
     * `snapshot` should come from the same read as `buffer`
     * (`tauriService.readSqliteFile`). Without it the file is stat'd now, and
     * a write between that read and this stat would be mistaken for the
     * version on screen.
     */
    async loadDbFromArrayBuffer(buffer: ArrayBuffer, filePath?: string, snapshot?: DiskSnapshot) {
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

            this.stopWatch();
            this.resetDiskTracking();
            if (filePath) {
                this.currentFilePath = filePath;
                this.lastSnapshot = snapshot ?? (await tauriService.sqliteDiskState(filePath));
                this.startWatch();
            } else {
                this.currentFilePath = null;
            }

            return true;
        } catch (error) {
            console.error("Failed to load database:", error);
            this.currentTables = [];
            this.currentFilePath = null;
            this.resetDiskTracking();
            this.stopWatch();
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
                this.resetDiskTracking();
                this.stopWatch();
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
                "SELECT name, sql, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
            );

            if (tables.length === 0 || !tables[0].values) {
                return [];
            }

            this.currentTables = tables[0].values.map((row) => ({
                name: row[0] as string,
                sql: row[1] as string,
                type: row[2] === 'view' ? 'view' as const : 'table' as const
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
            const pragmaResult = this.db.exec(`PRAGMA table_info(${quoteIdent(tableName, 'table')})`);

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
            const pragmaResult = this.db.exec(`PRAGMA foreign_key_list(${quoteIdent(tableName, 'table')})`);

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
            const indexListResult = this.db.exec(`PRAGMA index_list(${quoteIdent(tableName, 'table')})`);

            if (indexListResult.length === 0 || !indexListResult[0].values) {
                return [];
            }

            const indexes: IndexInfo[] = [];

            for (const row of indexListResult[0].values) {
                const indexName = row[1] as string;
                const unique = row[2] === 1;

                // Get columns for this index
                const indexInfoResult = this.db.exec(`PRAGMA index_info(${quoteIdent(indexName)})`);
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

    /**
     * One page of a table with the search and sort applied in SQL, plus the
     * matching row count. The grid used to load the first 1000 rows and page,
     * search and sort only those, so anything past row 1000 was unreachable.
     */
    queryTable(tableName: string, q: TableQuery): TablePage {
        if (!this.db) return { columns: [], rows: [], total: 0 };

        try {
            const columnInfo = this.getTableColumns(tableName);
            const columnNames = columnInfo.map(col => col.name);
            if (columnNames.length === 0) return { columns: [], rows: [], total: 0 };
            const from = quoteIdent(tableName, 'table');
            const readOnly = this.isView(tableName);
            // No primary key: carry the rowid so single rows can still be addressed.
            const useRowid = !readOnly && primaryKeyColumns(columnInfo).length === 0 && this.hasRowid(tableName);

            const params: string[] = [];
            let where = '';
            const search = q.search?.trim();
            if (search) {
                const pattern = `%${escapeLike(search)}%`;
                where = ' WHERE ' + columnNames
                    .map(name => {
                        params.push(pattern);
                        return `CAST(${quoteIdent(name, 'column')} AS TEXT) LIKE ? ESCAPE '\\'`;
                    })
                    .join(' OR ');
            }

            let order = '';
            if (q.sortColumn && columnNames.includes(q.sortColumn)) {
                order = ` ORDER BY ${quoteIdent(q.sortColumn, 'column')} ${q.sortDirection === 'desc' ? 'DESC' : 'ASC'}`;
            }

            const countResult = this.db.exec(`SELECT COUNT(*) FROM ${from}${where}`, params);
            const total = Number(countResult[0]?.values?.[0]?.[0] ?? 0);

            const limit = Math.max(1, Math.trunc(q.limit));
            const offset = Math.max(0, Math.trunc(q.offset));
            const result = this.db.exec(
                `SELECT ${columnNames.map(name => quoteIdent(name, 'column')).join(', ')}${useRowid ? `, rowid AS ${quoteIdent(ROW_LOCATOR)}` : ''} FROM ${from}${where}${order} LIMIT ${limit} OFFSET ${offset}`,
                params,
            );

            const rows = (result[0]?.values ?? []).map(row => {
                const rowData: RowData = {};
                columnNames.forEach((colName, index) => {
                    rowData[colName] = row[index];
                });
                if (useRowid) rowData[ROW_LOCATOR] = row[columnNames.length];
                return rowData;
            });

            return { columns: columnNames, rows, total, readOnly, rowLocator: useRowid ? ROW_LOCATOR : undefined };
        } catch (error) {
            console.error(`Error querying ${tableName}:`, error);
            toast({
                title: "Error",
                description: `Failed to retrieve data for table ${tableName}`,
                variant: "destructive"
            });
            return { columns: [], rows: [], total: 0 };
        }
    }

    getTableData(tableName: string, limit = 1000, offset = 0): { columns: string[], rows: RowData[] } {
        if (!this.db) {
            return { columns: [], rows: [] };
        }

        try {
            // First get the column information
            const columns = this.getTableColumns(tableName);
            const columnNames = columns.map(col => col.name);

            // Execute the query with proper column names. A negative limit
            // means every row (SQLite treats LIMIT -1 as no limit).
            const result = this.db.exec(
                `SELECT ${columnNames.map(name => quoteIdent(name, 'column')).join(', ')} FROM ${quoteIdent(tableName, 'table')} LIMIT ${Math.trunc(limit)} OFFSET ${Math.max(0, Math.trunc(offset))}`
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

    get isDirty(): boolean {
        return this.dirty;
    }

    get diskAlert(): DiskAlert | null {
        return this.alert;
    }

    private resetDiskTracking(): void {
        this.lastSnapshot = null;
        this.dirty = false;
        this.alert = null;
        this.saveRetryDelayMs = 0;
        this.saveRetryAt = 0;
        this.unreadableMtime = null;
    }

    /** One event per change of state, so the UI toasts once, not every poll. */
    private setAlert(next: DiskAlert | null): void {
        if (next === this.alert) return;
        this.alert = next;
        this.dispatchWindowEvent('sqliteDiskAlert');
    }

    private backOffSaves(): void {
        this.saveRetryDelayMs = Math.min(Math.max(this.saveRetryDelayMs * 2, 1000), 10_000);
        this.saveRetryAt = Date.now() + this.saveRetryDelayMs;
    }

    private startWatch(): void {
        this.stopWatch();
        if (!this.currentFilePath) return;
        this.watchTimer = setInterval(() => {
            if (this.watchQueued) return;
            this.watchQueued = true;
            void this.enqueueIo(async () => {
                try {
                    await this.pollDiskNow();
                } finally {
                    this.watchQueued = false;
                }
            });
        }, 1000);
    }

    private stopWatch(): void {
        if (this.watchTimer != null) {
            clearInterval(this.watchTimer);
            this.watchTimer = null;
        }
        this.watchQueued = false;
    }

    private async pollDiskNow(): Promise<void> {
        const path = this.currentFilePath;
        if (!path) return;
        let current: DiskSnapshot;
        try {
            current = await tauriService.sqliteDiskState(path);
        } catch (error) {
            console.error('Could not check the database file:', error);
            return;
        }
        if (this.currentFilePath !== path) return;

        const block = saveWouldClobber(current, this.lastSnapshot);
        if (block === 'ok') {
            if (this.dirty) {
                if (Date.now() >= this.saveRetryAt) await this.saveToDiskNow();
            } else if (this.alert !== 'save-failed') {
                this.setAlert(null);
            }
            return;
        }
        if (block === 'changed' && !this.dirty && current.mtime !== this.unreadableMtime) {
            await this.reloadFromDiskNow({ silent: true, mtime: current.mtime });
            return;
        }
        this.setAlert(block);
    }

    async reloadFromDisk(): Promise<boolean> {
        return this.enqueueIo(() => this.reloadFromDiskNow());
    }

    /**
     * `silent` is the poll following someone else's write while nothing is
     * unsaved: no toast, and a version that fails to load is remembered by
     * `mtime` so it is not retried — and complained about — every second.
     */
    private async reloadFromDiskNow(opts?: { silent?: boolean; mtime?: number | null }): Promise<boolean> {
        if (!this.currentFilePath) return false;
        const path = this.currentFilePath;
        let read: Awaited<ReturnType<typeof tauriService.readSqliteFile>>;
        try {
            read = await tauriService.readSqliteFile(path);
        } catch (error) {
            if (this.currentFilePath !== path) return false;
            if (opts?.silent) {
                console.error('Could not reload the database file:', error);
                this.unreadableMtime = opts.mtime ?? null;
                this.setAlert('changed');
            } else {
                toast({
                    title: "Reload failed",
                    description: String(error) || "Could not re-read the database file",
                    variant: "destructive",
                });
            }
            return false;
        }
        if (this.currentFilePath !== path) return false;
        if (!this.swapInDatabase(read.data, { keepCurrentOnFailure: true })) {
            this.unreadableMtime = read.snapshot.mtime;
            this.setAlert('changed');
            return false;
        }
        this.currentFilePath = path;
        this.dirty = false;
        this.lastSnapshot = read.snapshot;
        this.unreadableMtime = null;
        this.saveRetryDelayMs = 0;
        this.saveRetryAt = 0;
        const block = saveWouldClobber(read.snapshot, read.snapshot);
        this.setAlert(block === 'ok' ? null : block);
        this.dispatchWindowEvent('sqliteFileReloaded');
        if (!opts?.silent) {
            toast({
                title: "Reloaded from disk",
                description: "Editor now matches the file, including any agent writes.",
            });
        }
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

    /**
     * The conflict checks run in Rust under the same handle as the write. A
     * refusal leaves the edit in memory and `dirty`; the poll retries with
     * back-off, and the UI hears about it once per change of state.
     */
    private async saveToDiskNow(): Promise<boolean> {
        if (!this.db || !this.currentFilePath) return false;
        const path = this.currentFilePath;

        try {
            const data = this.db.export();
            const outcome = await tauriService.saveSqliteFile(path, data, this.lastSnapshot?.mtime ?? null);
            if (this.currentFilePath !== path) return false;

            if (outcome.status === 'saved') {
                this.lastSavedData = data;
                this.dirty = false;
                this.lastSnapshot = { mtime: outcome.mtime, walSize: 0, inUse: false };
                this.saveRetryDelayMs = 0;
                this.saveRetryAt = 0;
                this.setAlert(null);
                return true;
            }
            this.backOffSaves();
            this.setAlert(outcome.status);
            return false;
        } catch (error) {
            console.error('Failed to auto-save database:', error);
            if (this.currentFilePath !== path) return false;
            this.backOffSaves();
            this.setAlert('save-failed');
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

            if (classification.kind !== 'read' && this.currentFilePath) {
                this.dirty = true;
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
                const wrote = sqlStatements.some((s) => classifyStatement(s).kind !== 'read');
                if (wrote) {
                    this.dirty = true;
                    void this.saveToDisk();
                }
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

    /** SQL literal for a cell value, matching how sql.js hands values back. */
    private sqlValue(v: unknown): string {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' && Number.isFinite(v)) return v.toString();
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'boolean') return v ? '1' : '0';
        if (v instanceof Uint8Array) {
            return `X'${Array.from(v, b => b.toString(16).padStart(2, '0')).join('')}'`;
        }
        return `'${String(v).replace(/'/g, "''")}'`;
    }

    /**
     * WHERE clause naming exactly one row by its whole primary key.
     *
     * Edits and deletes used only the first key column, so on a table keyed by
     * (EmployeeID, TerritoryID) editing one row rewrote every row that shared
     * its EmployeeID.
     */
    private keyWhere(keyColumns: ColumnInfo[], row: RowData): string {
        if (keyColumns.length === 0) {
            const rowid = row[ROW_LOCATOR];
            if (typeof rowid !== 'number') {
                throw new Error('This table has no primary key or rowid, so a single row cannot be addressed. Use the SQL editor');
            }
            return `rowid = ${rowid}`;
        }
        return keyColumns
            .map(col => {
                const value = row[col.name];
                if (value === undefined) throw new Error(`Row is missing its key column ${col.name}`);
                return value === null
                    ? `${quoteIdent(col.name, 'column')} IS NULL`
                    : `${quoteIdent(col.name, 'column')} = ${this.sqlValue(value)}`;
            })
            .join(' AND ');
    }

    private isView(tableName: string): boolean {
        return this.currentTables.some(t => t.name === tableName && t.type === 'view');
    }

    /** False for WITHOUT ROWID tables, which always have a primary key anyway. */
    private hasRowid(tableName: string): boolean {
        try {
            this.db?.exec(`SELECT rowid FROM ${quoteIdent(tableName, 'table')} LIMIT 0`);
            return true;
        } catch {
            return false;
        }
    }

    private assertTableWritable(tableName: string): void {
        if (this.isView(tableName)) throw new Error(`${tableName} is a view, so it is read-only`);
    }

    private autoSave(message: string): void {
        if (!this.currentFilePath) return;
        this.dirty = true;
        void this.saveToDisk().then(success => {
            if (success) {
                toast({ title: "Saved", description: message });
            }
        });
    }

    private reportWriteError(error: unknown, fallback: string): void {
        console.error(fallback, error);
        // A refusal is not a malfunction, and silently returning false leaves
        // the user watching their edit revert with no explanation.
        toast({
            title: error instanceof ReadOnlyConnectionError ? "Read-only connection" : fallback,
            description: error instanceof Error ? error.message : String(error),
            variant: "destructive"
        });
    }

    updateRow(tableName: string, oldRow: RowData, newRow: RowData): boolean {
        if (!this.db) return false;

        try {
            assertWritable(`the edit to ${tableName}`);
            this.assertTableWritable(tableName);
            const keyColumns = primaryKeyColumns(this.getTableColumns(tableName));

            // Only what the edit changed. The grid now refreshes under an open
            // edit when an agent writes, and writing back every column from
            // the dialog's copy would quietly revert the agent's other ones.
            const changed = Object.entries(newRow).filter(
                ([column, value]) => column !== ROW_LOCATOR && value !== oldRow[column],
            );
            if (changed.length === 0) return true;

            const setClause = changed
                .map(([column, value]) => `${quoteIdent(column, 'column')} = ${this.sqlValue(value)}`)
                .join(', ');

            this.db.exec(`UPDATE ${quoteIdent(tableName, 'table')} SET ${setClause} WHERE ${this.keyWhere(keyColumns, oldRow)}`);
            if (this.db.getRowsModified() === 0) {
                throw new Error('The row no longer exists. It may have been changed or deleted elsewhere');
            }

            this.autoSave('Row saved to the database file');
            return true;
        } catch (error) {
            this.reportWriteError(error, 'Row not updated');
            return false;
        }
    }

    /** Delete the given rows, each named by its whole primary key. */
    deleteRows(tableName: string, rows: RowData[]): boolean {
        if (!this.db) return false;
        if (rows.length === 0) return true;

        try {
            assertWritable(`the row deletion from ${tableName}`);
            this.assertTableWritable(tableName);
            const keyColumns = primaryKeyColumns(this.getTableColumns(tableName));

            const table = quoteIdent(tableName, 'table');
            this.db.exec('BEGIN');
            try {
                for (const row of rows) {
                    this.db.exec(`DELETE FROM ${table} WHERE ${this.keyWhere(keyColumns, row)}`);
                }
                this.db.exec('COMMIT');
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }

            this.autoSave(`${rows.length} ${rows.length === 1 ? 'row' : 'rows'} deleted`);
            return true;
        } catch (error) {
            this.reportWriteError(error, 'Rows not deleted');
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
    /** Every table and view as one worksheet each, with every row. */
    exportToXlsx(): Uint8Array | null {
        if (!this.db) return null;
        return buildXlsx(this.getTables().map(table => {
            const data = this.getTableData(table.name, -1);
            return { name: table.name, columns: data.columns, rows: data.rows };
        }));
    }

    exportToFormat(format: 'csv' | 'json'): string | null {
        if (!this.db) return null;

        // Get all tables
        const tables = this.getTables();

        if (format === 'json') {
            // Export all tables to JSON
            const result: Record<string, RowData[]> = {};

            for (const table of tables) {
                // -1: every row. The default page size (1000) silently cut exports short.
                const data = this.getTableData(table.name, -1);
                result[table.name] = rowsToJson(data.rows);
            }

            return JSON.stringify(result, null, 2);
        }

        if (format === 'csv') {
            // Export all tables to CSV (one file with all tables)
            let result = '';

            for (const table of tables) {
                const data = this.getTableData(table.name, -1);

                // Add table name as header
                result += `Table: ${table.name}\n`;

                // Add column headers
                result += csvRow(data.columns) + '\n';

                // Add rows
                for (const row of data.rows) {
                    result += csvRow(data.columns.map(col => row[col])) + '\n';
                }

                // Add separator between tables
                result += '\n\n';
            }

            return result;
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
        this.stopWatch();
        this.currentFilePath = null;
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.resetDiskTracking();
    }
}

// Export a singleton instance
export const sqliteService = new SqliteService();
