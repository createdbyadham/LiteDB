import { useState, useEffect } from 'react';
import { pgService, PgConfig } from '@/lib/pgService';
import { TableInfo, ColumnInfo, RowData } from '@/lib/dbService';
import { toast } from '@/hooks/use-toast';

export interface UsePgReturn {
  isConnected: boolean;
  isConnecting: boolean;
  tables: TableInfo[];
  connectToDatabase: (config: PgConfig) => Promise<boolean>;
  getTableData: (tableName: string) => Promise<{ columns: string[], rows: RowData[] }>;
  getTableColumns: (tableName: string) => Promise<ColumnInfo[]>;
  executeQuery: (sql: string) => Promise<{ columns: string[], rows: unknown[][] } | null>;
  disconnect: () => void;
}

export function usePostgres(): UsePgReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [tables, setTables] = useState<TableInfo[]>([]);

  // Initialize pg service
  useEffect(() => {
    let mounted = true;

    const initPg = async () => {
      try {
        console.log("Initializing PostgreSQL service");
        await pgService.init();
        
        if (!mounted) return;

        // Check if we already have a connection
        if (pgService.connected) {
          console.log("Found existing PostgreSQL connection");
          const existingTables = await pgService.getTables();
          
          if (mounted) {
            setTables(existingTables);
            setIsConnected(true);
          }
        }
      } catch (error) {
        console.error("Failed to initialize PostgreSQL service:", error);
        if (mounted) {
          setIsConnected(false);
          setTables([]);
        }
      }
    };

    void initPg();
    
    return () => {
      mounted = false;
    };
  }, []);

  const connectToDatabase = async (config: PgConfig): Promise<boolean> => {
    console.log("Starting PostgreSQL connection process");
    setIsConnecting(true);
    setIsConnected(false);
    setTables([]); // Clear existing tables while connecting
    
    try {
      // Ensure pgService is initialized
      console.log("Ensuring pgService is initialized");
      await pgService.init();
      
      console.log("Connecting to PostgreSQL database");
      const success = await pgService.connect(config);
      
      if (success) {
        console.log("PostgreSQL connection successful, getting tables");
        const tableList = await pgService.getTables();
        console.log("Retrieved tables:", tableList);
        
        if (tableList.length > 0) {
          console.log("Setting state with tables");
          setTables(tableList);
          setIsConnected(true);
          
          toast({
            title: "Connected to PostgreSQL",
            description: `Connected to ${config.database} with ${tableList.length} tables`,
          });
          
          return true;
        } else {
          console.log("No tables found in database");
          setIsConnected(true); // Still connected, just no tables
          setTables([]);
          
          toast({
            title: "Connected to PostgreSQL",
            description: "Connected but the database contains no tables",
          });
          return true;
        }
      }
      
      console.log("Failed to connect to PostgreSQL database");
      setIsConnected(false);
      setTables([]);
      return false;
    } catch (error) {
      console.error("Error connecting to PostgreSQL:", error);
      setIsConnected(false);
      setTables([]);
      
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
      console.log("Attempted to get table data without PostgreSQL connection");
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
      console.log("Attempted to get table columns without PostgreSQL connection");
      toast({
        title: "Error",
        description: "Not connected to PostgreSQL. Please connect first.",
        variant: "destructive"
      });
      return [];
    }
    return pgService.getTableColumns(tableName);
  };

  const executeQuery = async (sql: string) => {
    if (!isConnected) {
      console.log("Attempted to execute query without PostgreSQL connection");
      toast({
        title: "Error",
        description: "Not connected to PostgreSQL. Please connect first.",
        variant: "destructive"
      });
      return null;
    }
    return pgService.executeQuery(sql);
  };

  const disconnect = () => {
    pgService.disconnect();
    setIsConnected(false);
    setTables([]);
    
    toast({
      title: "Disconnected",
      description: "Disconnected from PostgreSQL database",
    });
  };

  return {
    isConnected,
    isConnecting,
    tables,
    connectToDatabase,
    getTableData,
    getTableColumns,
    executeQuery,
    disconnect
  };
} 