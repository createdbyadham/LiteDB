import { useState, useEffect } from 'react';
import { pgService, PgConfig, VectorColumnInfo, VectorStats, SimilarityResult } from '@/lib/pgService';
import { TableInfo, ColumnInfo, RowData, ForeignKeyInfo, IndexInfo } from '@/lib/sqliteService';
import { toast } from '@/hooks/use-toast';
import { aiService, DatabaseSchema, TableSchema } from '@/lib/aiService';

export interface UsePgReturn {
  isConnected: boolean;
  isConnecting: boolean;
  tables: TableInfo[];
  connectToDatabase: (config: PgConfig) => Promise<boolean>;
  getTableData: (tableName: string) => Promise<{ columns: string[], rows: RowData[] }>;
  getTableColumns: (tableName: string) => Promise<ColumnInfo[]>;
  getForeignKeys: (tableName: string) => Promise<ForeignKeyInfo[]>;
  getIndexes: (tableName: string) => Promise<IndexInfo[]>;
  executeQuery: (sql: string) => Promise<{ columns: string[], rows: unknown[][] } | null>;
  disconnect: () => void;
  refreshTables: () => Promise<void>;
  // pgvector support
  hasPgVector: boolean;
  vectorColumns: VectorColumnInfo[];
  getTableVectorColumns: (tableName: string) => VectorColumnInfo[];
  isVectorColumn: (tableName: string, columnName: string) => VectorColumnInfo | undefined;
  getVectorStats: (tableName: string, columnName: string) => Promise<VectorStats | null>;
  findSimilarByRowId: (
    tableName: string,
    vectorColumn: string,
    primaryKeyColumn: string,
    rowId: string | number,
    limit?: number,
    distanceMetric?: '<=>' | '<->' | '<#>'
  ) => Promise<SimilarityResult[]>;
  findSimilarByVector: (
    tableName: string,
    vectorColumn: string,
    queryVector: number[],
    limit?: number,
    distanceMetric?: '<=>' | '<->' | '<#>'
  ) => Promise<SimilarityResult[]>;
  getTablesWithVectors: () => string[];
  refreshVectorColumns: () => Promise<void>;
}

export function usePostgres(): UsePgReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [hasPgVector, setHasPgVector] = useState(false);
  const [vectorColumns, setVectorColumns] = useState<VectorColumnInfo[]>([]);

  const pushPgSchemaToAI = async (tableList: TableInfo[]) => {
    try {
      const tableSchemas: TableSchema[] = [];
      for (const t of tableList) {
        const cols = await pgService.getTableColumns(t.name);
        tableSchemas.push({
          name: t.name,
          columns: cols.map(c => ({
            name: c.name,
            type: c.type,
            isPrimaryKey: c.pk === 1,
            isNotNull: c.notnull === 1
          }))
        });
      }
      const schema: DatabaseSchema = { dialect: 'postgres', tables: tableSchemas };
      await aiService.setSchemaWithSamples(schema, async (sql) => {
        const result = await pgService.executeQuery(sql);
        return result ? result.rows : null;
      });
    } catch {
      // Best-effort; ignore schema push errors
    }
  };

  // Initialize pg service
  useEffect(() => {
    let mounted = true;

    const initPg = async () => {
      try {
        await pgService.init();

        if (!mounted) return;

        // Check if we already have a connection
        if (pgService.connected) {
          const existingTables = await pgService.getTables();

          if (mounted) {
            setTables(existingTables);
            setIsConnected(true);
            // Push schema to AI
            await pushPgSchemaToAI(existingTables);
            
            // Check for pgvector support
            const hasVector = await pgService.checkPgVectorExtension();
            if (mounted && hasVector) {
              setHasPgVector(true);
              const vecCols = await pgService.getVectorColumns();
              if (mounted) setVectorColumns(vecCols);
            }
          }
        }
      } catch {
        if (mounted) {
          setIsConnected(false);
          setTables([]);
          setHasPgVector(false);
          setVectorColumns([]);
          aiService.clearSchema();
        }
      }
    };

    void initPg();

    return () => {
      mounted = false;
    };
  }, []);

  const connectToDatabase = async (config: PgConfig): Promise<boolean> => {
    setIsConnecting(true);
    setIsConnected(false);
    setTables([]); // Clear existing tables while connecting
    setHasPgVector(false);
    setVectorColumns([]);

    try {
      // Ensure pgService is initialized
      await pgService.init();

      const success = await pgService.connect(config);

      if (success) {
        const tableList = await pgService.getTables();

        // Check for pgvector extension
        const hasVector = await pgService.checkPgVectorExtension();
        setHasPgVector(hasVector);
        
        if (hasVector) {
          const vecCols = await pgService.getVectorColumns();
          setVectorColumns(vecCols);
        }

        if (tableList.length > 0) {
          setTables(tableList);
          setIsConnected(true);
          // Push schema to AI
          await pushPgSchemaToAI(tableList);

          const vectorInfo = hasVector ? ` (pgvector enabled with ${vectorColumns.length} vector columns)` : '';
          toast({
            title: "Connected to PostgreSQL",
            description: `Connected to ${config.database} with ${tableList.length} tables${vectorInfo}`,
          });

          return true;
        } else {
          setIsConnected(true); // Still connected, just no tables
          setTables([]);
          aiService.clearSchema();

          toast({
            title: "Connected to PostgreSQL",
            description: "Connected but the database contains no tables",
          });
          return true;
        }
      }

      setIsConnected(false);
      setTables([]);
      setHasPgVector(false);
      setVectorColumns([]);
      aiService.clearSchema();
      return false;
    } catch (error) {
      setIsConnected(false);
      setTables([]);
      setHasPgVector(false);
      setVectorColumns([]);
      aiService.clearSchema();

      toast({
        title: "Connection Error",
        description: error instanceof Error ? error.message : "Failed to connect to PostgreSQL database",
        variant: "destructive"
      });

      return false;
    } finally {
      setIsConnecting(false);
    }
  };

  const getTableData = async (tableName: string) => {
    if (!isConnected || !tables.length) {
      toast({
        title: "Error",
        description: "Not connected to PostgreSQL. Please connect first.",
        variant: "destructive"
      });
      return { columns: [], rows: [] };
    }
    return pgService.getTableData(tableName);
  };

  const getTableColumns = async (tableName: string) => {
    if (!isConnected || !tables.length) {
      toast({
        title: "Error",
        description: "Not connected to PostgreSQL. Please connect first.",
        variant: "destructive"
      });
      return [];
    }
    return pgService.getTableColumns(tableName);
  };

  const getForeignKeys = async (tableName: string) => {
    if (!isConnected) {
      return [];
    }
    return pgService.getForeignKeys(tableName);
  };

  const getIndexes = async (tableName: string) => {
    if (!isConnected) {
      return [];
    }
    return pgService.getIndexes(tableName);
  };

  const executeQuery = async (sql: string) => {
    if (!isConnected) {
      toast({
        title: "Error",
        description: "Not connected to PostgreSQL. Please connect first.",
        variant: "destructive"
      });
      return null;
    }
    return pgService.executeQuery(sql);
  };

  const refreshTables = async () => {
    if (!isConnected) {
      return;
    }
    try {
      const tableList = await pgService.getTables();
      setTables(tableList);
      // Update AI schema
      if (tableList.length > 0) {
        await pushPgSchemaToAI(tableList);
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

  const disconnect = () => {
    pgService.disconnect();
    setIsConnected(false);
    setTables([]);
    setHasPgVector(false);
    setVectorColumns([]);
    aiService.clearSchema();

    toast({
      title: "Disconnected",
      description: "Disconnected from PostgreSQL database",
    });
  };

  // pgvector methods
  const getTableVectorColumns = (tableName: string) => {
    return pgService.getTableVectorColumns(tableName);
  };

  const isVectorColumn = (tableName: string, columnName: string) => {
    return pgService.isVectorColumn(tableName, columnName);
  };

  const getVectorStats = async (tableName: string, columnName: string) => {
    return pgService.getVectorStats(tableName, columnName);
  };

  const findSimilarByRowId = async (
    tableName: string,
    vectorColumn: string,
    primaryKeyColumn: string,
    rowId: string | number,
    limit = 10,
    distanceMetric: '<=>' | '<->' | '<#>' = '<=>'
  ) => {
    return pgService.findSimilarByRowId(tableName, vectorColumn, primaryKeyColumn, rowId, limit, distanceMetric);
  };

  const findSimilarByVector = async (
    tableName: string,
    vectorColumn: string,
    queryVector: number[],
    limit = 10,
    distanceMetric: '<=>' | '<->' | '<#>' = '<=>'
  ) => {
    return pgService.findSimilarByVector(tableName, vectorColumn, queryVector, limit, distanceMetric);
  };

  const getTablesWithVectors = () => {
    return pgService.getTablesWithVectors();
  };

  const refreshVectorColumns = async () => {
    if (!isConnected) return;
    const hasVector = await pgService.checkPgVectorExtension();
    setHasPgVector(hasVector);
    if (hasVector) {
      const vecCols = await pgService.getVectorColumns();
      setVectorColumns(vecCols);
    }
  };

  return {
    isConnected,
    isConnecting,
    tables,
    connectToDatabase,
    getTableData,
    getTableColumns,
    getForeignKeys,
    getIndexes,
    executeQuery,
    disconnect,
    refreshTables,
    // pgvector support
    hasPgVector,
    vectorColumns,
    getTableVectorColumns,
    isVectorColumn,
    getVectorStats,
    findSimilarByRowId,
    findSimilarByVector,
    getTablesWithVectors,
    refreshVectorColumns
  };
} 