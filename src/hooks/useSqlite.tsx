import { useState, useEffect } from 'react';
import { sqliteService, TableInfo, ColumnInfo, RowData, ForeignKeyInfo, IndexInfo } from '@/lib/sqliteService';
import { toast } from '@/hooks/use-toast';
import { aiService, DatabaseSchema, TableSchema } from '@/lib/aiService';

export interface UseSqliteReturn {
    isLoaded: boolean;
    isLoading: boolean;
    tables: TableInfo[];
    loadDatabase: (data: ArrayBuffer | Buffer, filePath?: string) => Promise<boolean>;
    getTableData: (tableName: string) => { columns: string[], rows: RowData[] };
    getTableColumns: (tableName: string) => ColumnInfo[];
    getForeignKeys: (tableName: string) => ForeignKeyInfo[];
    getIndexes: (tableName: string) => IndexInfo[];
    executeQuery: (sql: string) => { columns: string[], rows: unknown[][] } | null;
    refreshTables: () => void;
}

export function useSqlite(): UseSqliteReturn {
    const [isLoaded, setIsLoaded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [tables, setTables] = useState<TableInfo[]>([]);

    const pushSQLiteSchemaToAI = async (tableList: TableInfo[]) => {
        try {
            const tableSchemas: TableSchema[] = tableList.map((t) => {
                const cols = sqliteService.getTableColumns(t.name);
                return {
                    name: t.name,
                    columns: cols.map(c => ({
                        name: c.name,
                        type: c.type,
                        isPrimaryKey: c.pk === 1,
                        isNotNull: c.notnull === 1
                    }))
                };
            });
            const schema: DatabaseSchema = { dialect: 'sqlite', tables: tableSchemas };
            await aiService.setSchemaWithSamples(schema, async (sql) => {
                const result = sqliteService.executeQuery(sql);
                return result ? result.rows : null;
            });
        } catch {
            // Best-effort; ignore schema push errors
        }
    };

    // Initialize SQL.js and check for existing database
    useEffect(() => {
        let mounted = true;

        const initDb = async () => {
            try {
                await sqliteService.init();

                if (!mounted) return;

                // Check if we already have tables loaded
                const existingTables = sqliteService.getTables();

                if (existingTables.length > 0 && mounted) {
                    setTables(existingTables);
                    setIsLoaded(true);
                    // Push schema to AI
                    void pushSQLiteSchemaToAI(existingTables);
                }
            } catch {
                if (mounted) {
                    setIsLoaded(false);
                    setTables([]);
                    aiService.clearSchema();
                }
            }
        };

        void initDb();

        return () => {
            mounted = false;
        };
    }, []);

    const loadDatabase = async (data: ArrayBuffer | Buffer, filePath?: string): Promise<boolean> => {
        setIsLoading(true);
        setIsLoaded(false);
        setTables([]); // Clear existing tables while loading

        try {
            // Ensure sqliteService is initialized
            await sqliteService.init();

            const success = await sqliteService.loadDbFromArrayBuffer(data, filePath);

            if (success) {
                const tableList = sqliteService.getTables();

                if (tableList.length > 0) {
                    setTables(tableList);
                    setIsLoaded(true);
                    // Push schema to AI
                    void pushSQLiteSchemaToAI(tableList);

                    toast({
                        title: "Database loaded",
                        description: `Loaded ${tableList.length} tables successfully`,
                    });

                    return true;
                } else {
                    setIsLoaded(false);
                    setTables([]);
                    aiService.clearSchema();

                    toast({
                        title: "Warning",
                        description: "Database loaded but contains no tables",
                        variant: "destructive"
                    });
                    return false;
                }
            }

            setIsLoaded(false);
            setTables([]);
            aiService.clearSchema();
            return false;
        } catch (error) {
            setIsLoaded(false);
            setTables([]);
            aiService.clearSchema();

            toast({
                title: "Error",
                description: error instanceof Error ? error.message : "Failed to load database",
                variant: "destructive"
            });

            return false;
        } finally {
            setIsLoading(false);
        }
    };

    const getTableData = (tableName: string) => {
        if (!isLoaded || !tables.length) {
            toast({
                title: "Error",
                description: "No database loaded. Please load a database first.",
                variant: "destructive"
            });
            return { columns: [], rows: [] };
        }
        return sqliteService.getTableData(tableName);
    };

    const getTableColumns = (tableName: string) => {
        if (!isLoaded || !tables.length) {
            toast({
                title: "Error",
                description: "No database loaded. Please load a database first.",
                variant: "destructive"
            });
            return [];
        }
        return sqliteService.getTableColumns(tableName);
    };

    const getForeignKeys = (tableName: string) => {
        if (!isLoaded || !tables.length) {
            return [];
        }
        return sqliteService.getForeignKeys(tableName);
    };

    const getIndexes = (tableName: string) => {
        if (!isLoaded || !tables.length) {
            return [];
        }
        return sqliteService.getIndexes(tableName);
    };

    const executeQuery = (sql: string) => {
        if (!isLoaded || !tables.length) {
            toast({
                title: "Error",
                description: "No database loaded. Please load a database first.",
                variant: "destructive"
            });
            return null;
        }
        return sqliteService.executeQuery(sql);
    };

    const refreshTables = () => {
        if (!isLoaded) {
            return;
        }
        try {
            const tableList = sqliteService.getTables();
            setTables(tableList);
            // Update AI schema
            if (tableList.length > 0) {
                void pushSQLiteSchemaToAI(tableList);
            } else {
                aiService.clearSchema();
            }
        } catch {
            toast({
                title: "Error",
                description: "Failed to refresh table list",
                variant: "destructive"
            });
        }
    };

    return {
        isLoaded,
        isLoading,
        tables,
        loadDatabase,
        getTableData,
        getTableColumns,
        getForeignKeys,
        getIndexes,
        executeQuery,
        refreshTables
    };
}
