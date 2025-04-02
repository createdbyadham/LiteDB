// This service handles PostgreSQL database operations
import { toast } from "@/hooks/use-toast";
import { TableInfo, ColumnInfo, RowData } from '@/lib/dbService';

// Define PostgreSQL connection config
export interface PgConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

class PgService {
  private client: any = null;
  private pg: any = null;
  private isInitializing = false;
  private initPromise: Promise<PgService> | null = null;
  private currentTables: TableInfo[] = [];
  public currentConfig: PgConfig | null = null;
  public connected = false;

  async init() {
    if (this.pg) {
      console.log("pg-promise already initialized");
      return this;
    }

    if (this.initPromise) {
      console.log("Waiting for existing initialization to complete");
      await this.initPromise;
      return this;
    }

    console.log("Starting pg initialization");
    this.isInitializing = true;
    this.initPromise = new Promise((resolve, reject) => {
      const initializeAsync = async () => {
        try {
          // In Electron we can use pg-promise directly through electron's IPC
          // For security reasons, we'll implement the actual connection in main process
          console.log("pg-promise initialized successfully");
          this.isInitializing = false;
          resolve(this);
        } catch (error) {
          this.isInitializing = false;
          console.error("Failed to initialize pg-promise:", error);
          toast({
            title: "Error",
            description: "Failed to initialize PostgreSQL engine",
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

  async connect(config: PgConfig) {
    try {
      console.log("Connecting to PostgreSQL database");
      
      // Save the config
      this.currentConfig = config;
      
      // Call main process to establish connection
      // This will be implemented in the Electron main process
      const result = await window.electron?.connectPostgres(config);
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to connect to PostgreSQL database");
      }
      
      this.connected = true;
      
      // Fetch tables to verify connection
      this.currentTables = await this.getTables();
      console.log("Connected to PostgreSQL with tables:", this.currentTables);
      
      return true;
    } catch (error) {
      console.error("PostgreSQL connection error:", error);
      this.currentTables = [];
      this.currentConfig = null;
      this.connected = false;
      
      toast({
        title: "Connection Error",
        description: error instanceof Error ? error.message : "Failed to connect to PostgreSQL database",
        variant: "destructive"
      });
      
      return false;
    }
  }

  async getTables(): Promise<TableInfo[]> {
    if (!this.connected) {
      return this.currentTables;
    }
    
    try {
      const result = await window.electron?.executePostgresQuery({
        query: `
          SELECT 
            table_name as name,
            'CREATE TABLE ' || table_name || ' (...)' as sql 
          FROM 
            information_schema.tables 
          WHERE 
            table_schema = 'public'
          ORDER BY 
            table_name;
        `
      });
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to retrieve tables");
      }
      
      this.currentTables = result.rows.map((row: any) => ({
        name: row.name,
        sql: row.sql
      }));
      
      return this.currentTables;
    } catch (error) {
      console.error("Error fetching PostgreSQL tables:", error);
      toast({
        title: "Error",
        description: "Failed to retrieve table list",
        variant: "destructive"
      });
      return this.currentTables;
    }
  }

  async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
    if (!this.connected) {
      return [];
    }
    
    try {
      const result = await window.electron?.executePostgresQuery({
        query: `
          SELECT 
            a.attnum as cid,
            a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type,
            CASE WHEN a.attnotnull THEN 1 ELSE 0 END as notnull,
            CASE WHEN p.contype = 'p' THEN 1 ELSE 0 END as pk
          FROM 
            pg_attribute a
          LEFT JOIN 
            pg_constraint p ON p.conrelid = a.attrelid AND a.attnum = ANY(p.conkey) AND p.contype = 'p'
          WHERE 
            a.attrelid = '${tableName}'::regclass
            AND a.attnum > 0
            AND NOT a.attisdropped
          ORDER BY 
            a.attnum;
        `
      });
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to retrieve columns");
      }
      
      return result.rows.map((row: any) => ({
        cid: parseInt(row.cid),
        name: row.name,
        type: row.type,
        notnull: parseInt(row.notnull),
        pk: parseInt(row.pk)
      }));
    } catch (error) {
      console.error(`Error fetching PostgreSQL columns for ${tableName}:`, error);
      toast({
        title: "Error",
        description: `Failed to retrieve columns for table ${tableName}`,
        variant: "destructive"
      });
      return [];
    }
  }

  async getTableData(tableName: string, limit = 1000, offset = 0): Promise<{ columns: string[], rows: RowData[] }> {
    if (!this.connected) {
      return { columns: [], rows: [] };
    }
    
    try {
      const result = await window.electron?.executePostgresQuery({
        query: `SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset};`
      });
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to retrieve table data");
      }
      
      return {
        columns: result.columns || [],
        rows: result.rows || []
      };
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

  async executeQuery(sql: string): Promise<{ columns: string[], rows: unknown[][] } | null> {
    if (!this.connected) {
      toast({
        title: "Error",
        description: "No PostgreSQL connection",
        variant: "destructive"
      });
      return null;
    }
    
    try {
      const result = await window.electron?.executePostgresQuery({
        query: sql
      });
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Query execution failed");
      }
      
      return {
        columns: result.columns || [],
        rows: result.rows || []
      };
    } catch (error) {
      console.error("Query execution error:", error);
      toast({
        title: "Query Error",
        description: error instanceof Error ? error.message : "Failed to execute query",
        variant: "destructive"
      });
      return null;
    }
  }

  async updateRow(tableName: string, oldRow: RowData, newRow: RowData): Promise<boolean> {
    if (!this.connected) {
      toast({
        title: "Error",
        description: "No PostgreSQL connection",
        variant: "destructive"
      });
      return false;
    }
    
    try {
      // Get the table columns to determine primary key and data types
      const columns = await this.getTableColumns(tableName);
      
      // Find the primary key column
      const primaryKeyColumn = columns.find(col => col.pk === 1);
      if (!primaryKeyColumn) {
        throw new Error(`Cannot update row: Table ${tableName} has no primary key`);
      }
      
      const pkName = primaryKeyColumn.name;
      const pkValue = oldRow[pkName];
      
      if (pkValue === undefined) {
        throw new Error(`Primary key value not found in row data`);
      }
      
      // Let's try a completely different approach to avoid parameter index issues
      // Instead of using $1, $2, etc. parameterized queries, we'll use a safer manual approach
      
      // Check if any changes are needed
      const changes = Object.entries(newRow)
        .filter(([column, value]) => {
          return column !== pkName && oldRow[column] !== value;
        });
      
      if (changes.length === 0) {
        toast({
          title: "No Changes",
          description: "No changes were made to the row",
        });
        return true; // No changes needed
      }
      
      // Manually construct the SET part with proper escaping
      const setClauses = changes.map(([column, value]) => {
        const escapedValue = this.formatValueForSQL(value);
        return `"${column}" = ${escapedValue}`;
      });
      
      // Format the primary key value for the WHERE clause
      const escapedPkValue = this.formatValueForSQL(pkValue);
      
      // Build and execute the UPDATE statement without parameters
      const sql = `
        UPDATE "${tableName}"
        SET ${setClauses.join(', ')}
        WHERE "${pkName}" = ${escapedPkValue};
      `;
      
      console.log("Update SQL:", sql);
      
      // Execute the query without using parameterized style
      const result = await window.electron?.executePostgresQuery({
        query: sql
      });
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to update row");
      }
      
      return true;
    } catch (error) {
      console.error("Update row error:", error);
      toast({
        title: "Update Error",
        description: error instanceof Error ? error.message : "Failed to update row",
        variant: "destructive"
      });
      return false;
    }
  }
  
  // Helper function to safely format values for SQL queries
  private formatValueForSQL(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    
    // Handle Date objects
    if (value instanceof Date) {
      // Format date as ISO string and escape properly
      return `'${value.toISOString().replace(/'/g, "''")}'`;
    }
    
    // Handle strings with proper escaping
    if (typeof value === 'string') {
      // Escape single quotes by doubling them
      return `'${value.replace(/'/g, "''")}'`;
    }
    
    // Handle booleans
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }
    
    // Handle numbers
    if (typeof value === 'number') {
      // Check if it's a valid number
      if (isNaN(value) || !isFinite(value)) {
        return 'NULL';
      }
      return value.toString();
    }
    
    // For objects or arrays, convert to JSON string and escape
    if (typeof value === 'object') {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }
    
    // Default fallback
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  disconnect() {
    if (this.connected) {
      window.electron?.disconnectPostgres();
      this.connected = false;
      this.currentConfig = null;
      this.currentTables = [];
    }
  }

  async deleteRows(tableName: string, primaryKeyColumn: string, rowIds: string[]): Promise<boolean> {
    if (!this.connected) return false;
    
    try {
      const sql = `DELETE FROM "${tableName}" WHERE "${primaryKeyColumn}" IN (${rowIds.map(id => this.formatValueForSQL(id)).join(',')})`;
      const result = await window.electron?.executePostgresQuery({ query: sql });
      
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to delete rows");
      }
      
      return true;
    } catch (error) {
      console.error("Delete rows error:", error);
      return false;
    }
  }
}

export const pgService = new PgService(); 