import { useState, useEffect } from 'react';
import { dbService, TableInfo, ColumnInfo, RowData } from '@/lib/dbService';
import { toast } from '@/hooks/use-toast';

export interface UseDbReturn {
  isLoaded: boolean;
  isLoading: boolean;
  tables: TableInfo[];
  loadDatabase: (data: ArrayBuffer | Buffer, filePath?: string) => Promise<boolean>;
  getTableData: (tableName: string) => { columns: string[], rows: RowData[] };
  getTableColumns: (tableName: string) => ColumnInfo[];
  executeQuery: (sql: string) => { columns: string[], rows: unknown[][] } | null;
}

export function useDatabase(): UseDbReturn {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [tables, setTables] = useState<TableInfo[]>([]);

  // Initialize SQL.js and check for existing database
  useEffect(() => {
    let mounted = true;

    const initDb = async () => {
      try {
        console.log("Initializing database service");
        await dbService.init();
        
        if (!mounted) return;

        // Check if we already have tables loaded
        const existingTables = dbService.getTables();
        console.log("Checking for existing tables:", existingTables);
        
        if (existingTables.length > 0 && mounted) {
          console.log("Found existing tables, setting state");
          setTables(existingTables);
          setIsLoaded(true);
        }
      } catch (error) {
        console.error("Failed to initialize database:", error);
        if (mounted) {
          setIsLoaded(false);
          setTables([]);
        }
      }
    };

    void initDb();
    
    return () => {
      mounted = false;
    };
  }, []);

  const loadDatabase = async (data: ArrayBuffer | Buffer, filePath?: string): Promise<boolean> => {
    console.log("Starting database load process");
    setIsLoading(true);
    setIsLoaded(false);
    setTables([]); // Clear existing tables while loading
    
    try {
      // Ensure dbService is initialized
      console.log("Ensuring dbService is initialized");
      await dbService.init();
      
      console.log("Loading database from ArrayBuffer");
      const success = await dbService.loadDbFromArrayBuffer(data, filePath);
      
      if (success) {
        console.log("Database loaded successfully, getting tables");
        const tableList = dbService.getTables();
        console.log("Retrieved tables:", tableList);
        
        if (tableList.length > 0) {
          console.log("Setting state with tables");
          setTables(tableList);
          setIsLoaded(true);
          
          toast({
            title: "Database loaded",
            description: `Loaded ${tableList.length} tables successfully`,
          });
          
          return true;
        } else {
          console.log("No tables found in database");
          setIsLoaded(false);
          setTables([]);
          
          toast({
            title: "Warning",
            description: "Database loaded but contains no tables",
            variant: "destructive"
          });
          return false;
        }
      }
      
      console.log("Failed to load database");
      setIsLoaded(false);
      setTables([]);
      return false;
    } catch (error) {
      console.error("Error loading database:", error);
      setIsLoaded(false);
      setTables([]);
      
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
      console.log("Attempted to get table data without loaded database");
      toast({
        title: "Error",
        description: "No database loaded. Please load a database first.",
        variant: "destructive"
      });
      return { columns: [], rows: [] };
    }
    return dbService.getTableData(tableName);
  };

  const getTableColumns = (tableName: string) => {
    if (!isLoaded || !tables.length) {
      console.log("Attempted to get table columns without loaded database");
      toast({
        title: "Error",
        description: "No database loaded. Please load a database first.",
        variant: "destructive"
      });
      return [];
    }
    return dbService.getTableColumns(tableName);
  };

  const executeQuery = (sql: string) => {
    if (!isLoaded || !tables.length) {
      console.log("Attempted to execute query without loaded database");
      toast({
        title: "Error",
        description: "No database loaded. Please load a database first.",
        variant: "destructive"
      });
      return null;
    }
    return dbService.executeQuery(sql);
  };

  return {
    isLoaded,
    isLoading,
    tables,
    loadDatabase,
    getTableData,
    getTableColumns,
    executeQuery
  };
}
