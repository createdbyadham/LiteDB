// This service handles PostgreSQL database operations
import { toast } from "@/hooks/use-toast";
import { tauriService } from '@/lib/tauri';
import { assertIdent } from '@/lib/types';
import type { TableInfo, ColumnInfo, RowData, ForeignKeyInfo, IndexInfo } from '@/lib/types';

// Define PostgreSQL connection config
export interface PgConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

// Vector column info
export interface VectorColumnInfo {
  tableName: string;
  columnName: string;
  dimensions: number;
}

// Vector statistics for visualization
export interface VectorStats {
  dimensions: number;
  min: number;
  max: number;
  mean: number;
  histogram: number[]; // 10 buckets
}

// Similarity search result
export interface SimilarityResult {
  row: RowData;
  distance: number;
  similarity: number;
}

function cell(row: RowData, key: string): string {
  const value = row[key];
  return value == null ? '' : String(value);
}

class PgService {
  private currentTables: TableInfo[] = [];
  public currentConfig: PgConfig | null = null;
  public connected = false;
  public hasPgVector = false;
  public vectorColumns: VectorColumnInfo[] = [];

  // Kept for API compatibility with the SQLite service. All real connection
  // setup happens in connect() through a Rust command, so there's nothing to
  // initialize on the JS side.
  async init() {
    return this;
  }

  async connect(config: PgConfig) {
    try {
      // Save the config
      this.currentConfig = config;

      // Call main process to establish connection
      const result = await tauriService.connectPostgres(config);

      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to connect to PostgreSQL database");
      }

      this.connected = true;

      // Fetch tables to verify connection
      this.currentTables = await this.getTables();

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
      return [];
    }

    try {
      const result = await tauriService.executePostgresQuery({
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

      this.currentTables = result.rows.map((row) => ({
        name: cell(row, 'name'),
        sql: cell(row, 'sql')
      }));

      return this.currentTables;
    } catch (error) {
      console.error("Error fetching PostgreSQL tables:", error);
      toast({
        title: "Error",
        description: "Failed to retrieve table list",
        variant: "destructive"
      });
      return [];
    }
  }

  async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
    if (!this.connected) {
      return [];
    }

    try {
      assertIdent(tableName, 'table');
      const result = await tauriService.executePostgresQuery({
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

      return result.rows.map((row) => ({
        cid: parseInt(cell(row, 'cid')),
        name: cell(row, 'name'),
        type: cell(row, 'type'),
        notnull: parseInt(cell(row, 'notnull')),
        pk: parseInt(cell(row, 'pk'))
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
      assertIdent(tableName, 'table');
      // SELECT * returns pgvector columns as raw binary which sqlx can't decode to string,
      // so we try to introspect columns and cast vector columns to text. Falls back to *.
      let query = `SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset};`;

      try {
        const columns = await this.getTableColumns(tableName);
        if (columns.length > 0) {
          const selectClause = columns.map(col => {
            assertIdent(col.name, 'column');
            if (col.type.startsWith('vector')) {
              return `"${col.name}"::text`;
            }
            return `"${col.name}"`;
          }).join(', ');
          query = `SELECT ${selectClause} FROM "${tableName}" LIMIT ${limit} OFFSET ${offset};`;
        }
      } catch {
        // Failed to fetch columns for smart select, falling back to SELECT *
      }

      const result = await tauriService.executePostgresQuery({
        query
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

  async getForeignKeys(tableName: string): Promise<ForeignKeyInfo[]> {
    if (!this.connected) {
      return [];
    }

    try {
      assertIdent(tableName, 'table');
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT
            tc.constraint_name,
            kcu.column_name as from_column,
            ccu.table_name AS to_table,
            ccu.column_name AS to_column,
            rc.update_rule,
            rc.delete_rule
          FROM 
            information_schema.table_constraints AS tc 
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            JOIN information_schema.referential_constraints AS rc
              ON tc.constraint_name = rc.constraint_name
              AND tc.table_schema = rc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' 
            AND tc.table_name = '${tableName}'
            AND tc.table_schema = 'public';
        `
      });

      if (!result || !result.success) {
        return [];
      }

      return result.rows.map((row, index) => ({
        id: index,
        seq: 0,
        table: cell(row, 'to_table'),
        from: cell(row, 'from_column'),
        to: cell(row, 'to_column'),
        on_update: cell(row, 'update_rule') || 'NO ACTION',
        on_delete: cell(row, 'delete_rule') || 'NO ACTION',
        match: 'NONE'
      }));
    } catch (error) {
      console.error(`Error fetching foreign keys for ${tableName}:`, error);
      return [];
    }
  }

  async getIndexes(tableName: string): Promise<IndexInfo[]> {
    if (!this.connected) {
      return [];
    }

    try {
      assertIdent(tableName, 'table');
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT
            i.relname as index_name,
            ix.indisunique as is_unique,
            array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns
          FROM
            pg_class t
            JOIN pg_index ix ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          WHERE
            t.relname = '${tableName}'
            AND t.relkind = 'r'
          GROUP BY
            i.relname, ix.indisunique;
        `
      });

      if (!result || !result.success) {
        return [];
      }

      return result.rows.map((row) => ({
        name: cell(row, 'index_name'),
        unique: Boolean(row.is_unique),
        columns: Array.isArray(row.columns) ? row.columns.map(String) : [cell(row, 'columns')]
      }));
    } catch (error) {
      console.error(`Error fetching indexes for ${tableName}:`, error);
      return [];
    }
  }

  async getFullSchema(): Promise<{
    tables: Array<{
      name: string;
      columns: ColumnInfo[];
      foreignKeys: ForeignKeyInfo[];
      indexes: IndexInfo[];
    }>;
  }> {
    const tables = await this.getTables();
    const schemaPromises = tables.map(async (table) => ({
      name: table.name,
      columns: await this.getTableColumns(table.name),
      foreignKeys: await this.getForeignKeys(table.name),
      indexes: await this.getIndexes(table.name)
    }));

    return {
      tables: await Promise.all(schemaPromises)
    };
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
      const result = await tauriService.executePostgresQuery({
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

  async insertRow(tableName: string, rowData: RowData): Promise<boolean> {
    if (!this.connected) {
      toast({
        title: "Error",
        description: "No PostgreSQL connection",
        variant: "destructive"
      });
      return false;
    }

    try {
      assertIdent(tableName, 'table');
      const columns = Object.keys(rowData);
      const values = Object.values(rowData);

      if (columns.length === 0) {
        return false;
      }

      columns.forEach(c => assertIdent(c, 'column'));
      const columnNames = columns.map(c => `"${c}"`).join(', ');
      const valuePlaceholders = values.map(v => this.formatValueForSQL(v)).join(', ');

      const sql = `
        INSERT INTO "${tableName}" (${columnNames})
        VALUES (${valuePlaceholders});
      `;

      const result = await tauriService.executePostgresQuery({
        query: sql
      });

      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to insert row");
      }

      return true;
    } catch (error) {
      console.error("Insert row error:", error);
      toast({
        title: "Insert Error",
        description: error instanceof Error ? error.message : "Failed to insert row",
        variant: "destructive"
      });
      return false;
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
      assertIdent(tableName, 'table');
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
        assertIdent(column, 'column');
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

      // Execute the query without using parameterized style
      const result = await tauriService.executePostgresQuery({
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
  private formatValueForSQL(value: unknown): string {
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
      tauriService.disconnectPostgres();
      this.connected = false;
      this.currentConfig = null;
      this.currentTables = [];
      this.hasPgVector = false;
      this.vectorColumns = [];
    }
  }

  // Check if pgvector extension is installed
  async checkPgVectorExtension(): Promise<boolean> {
    if (!this.connected) return false;

    try {
      const result = await tauriService.executePostgresQuery({
        query: `SELECT 1 FROM pg_extension WHERE extname = 'vector';`
      });

      this.hasPgVector = result?.success && result.rows.length > 0;
      return this.hasPgVector;
    } catch (error) {
      console.error('Error checking pgvector extension:', error);
      this.hasPgVector = false;
      return false;
    }
  }

  // Get all vector columns in the database
  async getVectorColumns(): Promise<VectorColumnInfo[]> {
    if (!this.connected || !this.hasPgVector) return [];

    try {
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT 
            c.table_name,
            c.column_name,
            CASE 
              WHEN c.udt_name = 'vector' THEN 
                COALESCE(
                  (regexp_match(format_type(a.atttypid, a.atttypmod), 'vector\\((\\d+)\\)'))[1]::int,
                  0
                )
              ELSE 0
            END as dimensions
          FROM information_schema.columns c
          JOIN pg_attribute a ON a.attname = c.column_name
          JOIN pg_class t ON t.relname = c.table_name AND a.attrelid = t.oid
          WHERE c.table_schema = 'public'
            AND c.udt_name = 'vector'
          ORDER BY c.table_name, c.column_name;
        `
      });

      if (!result?.success) return [];

      this.vectorColumns = result.rows.map((row) => ({
        tableName: cell(row, 'table_name'),
        columnName: cell(row, 'column_name'),
        dimensions: parseInt(cell(row, 'dimensions')) || 0
      }));

      return this.vectorColumns;
    } catch (error) {
      console.error('Error fetching vector columns:', error);
      return [];
    }
  }

  // Get vector columns for a specific table
  getTableVectorColumns(tableName: string): VectorColumnInfo[] {
    return this.vectorColumns.filter(vc => vc.tableName === tableName);
  }

  // Check if a column is a vector column
  isVectorColumn(tableName: string, columnName: string): VectorColumnInfo | undefined {
    return this.vectorColumns.find(
      vc => vc.tableName === tableName && vc.columnName === columnName
    );
  }

  // Parse vector string to array of numbers
  parseVector(vectorStr: string): number[] {
    if (!vectorStr) return [];
    // Vector format is like "[0.1,0.2,0.3]" or just "0.1,0.2,0.3"
    const cleaned = vectorStr.replace(/[[\]]/g, '');
    return cleaned.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
  }

  // Get statistics for a vector column
  async getVectorStats(tableName: string, columnName: string, sampleSize = 100): Promise<VectorStats | null> {
    if (!this.connected || !this.hasPgVector) return null;

    try {
      assertIdent(tableName, 'table');
      assertIdent(columnName, 'column');
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT "${columnName}"::text as vector_text
          FROM "${tableName}"
          WHERE "${columnName}" IS NOT NULL
          LIMIT ${sampleSize};
        `
      });

      if (!result?.success || result.rows.length === 0) return null;

      // Parse vectors and compute statistics
      const vectors = result.rows
        .map((row) => this.parseVector(cell(row, 'vector_text')))
        .filter((v) => v.length > 0);

      if (vectors.length === 0) return null;

      const dimensions = vectors[0].length;
      
      // Flatten all values for overall statistics
      const allValues = vectors.flat();
      const min = Math.min(...allValues);
      const max = Math.max(...allValues);
      const mean = allValues.reduce((a: number, b: number) => a + b, 0) / allValues.length;

      // Compute histogram (10 buckets)
      const bucketSize = (max - min) / 10 || 1;
      const histogram = new Array(10).fill(0);
      
      for (const value of allValues) {
        const bucketIndex = Math.min(Math.floor((value - min) / bucketSize), 9);
        histogram[bucketIndex]++;
      }

      // Normalize histogram to percentages
      const total = histogram.reduce((a: number, b: number) => a + b, 0);
      const normalizedHistogram = histogram.map((count: number) => (count / total) * 100);

      return {
        dimensions,
        min,
        max,
        mean,
        histogram: normalizedHistogram
      };
    } catch (error) {
      console.error('Error computing vector stats:', error);
      return null;
    }
  }

  // Run similarity search by vector (from row ID)
  async findSimilarByRowId(
    tableName: string,
    vectorColumn: string,
    primaryKeyColumn: string,
    rowId: string | number,
    limit = 10,
    distanceMetric: '<=>' | '<->' | '<#>' = '<=>'
  ): Promise<SimilarityResult[]> {
    if (!this.connected || !this.hasPgVector) return [];

    try {
      assertIdent(tableName, 'table');
      assertIdent(vectorColumn, 'column');
      assertIdent(primaryKeyColumn, 'column');
      // Build the query based on the distance metric
      let distanceExpr: string;
      let orderExpr: string;
      let similarityExpr: string;

      switch (distanceMetric) {
        case '<->': // L2 distance
          distanceExpr = `t."${vectorColumn}" <-> source."${vectorColumn}"`;
          orderExpr = distanceExpr;
          similarityExpr = `1.0 / (1.0 + ${distanceExpr})`;
          break;
        case '<#>': // Inner product (negative)
          distanceExpr = `t."${vectorColumn}" <#> source."${vectorColumn}"`;
          orderExpr = distanceExpr;
          similarityExpr = `-(${distanceExpr})`; // Higher is more similar
          break;
        case '<=>': // Cosine distance
        default:
          distanceExpr = `t."${vectorColumn}" <=> source."${vectorColumn}"`;
          orderExpr = distanceExpr;
          similarityExpr = `1.0 - (${distanceExpr})`; // Convert to similarity
          break;
      }

      const escapedRowId = typeof rowId === 'string' ? `'${rowId.replace(/'/g, "''")}'` : rowId;

      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT 
            t.*,
            ${distanceExpr} as distance,
            ${similarityExpr} as similarity
          FROM "${tableName}" t
          CROSS JOIN (
            SELECT "${vectorColumn}" 
            FROM "${tableName}" 
            WHERE "${primaryKeyColumn}" = ${escapedRowId}
          ) source
          WHERE t."${primaryKeyColumn}" != ${escapedRowId}
            AND t."${vectorColumn}" IS NOT NULL
          ORDER BY ${orderExpr}
          LIMIT ${limit};
        `
      });

      if (!result?.success) return [];

      return result.rows.map((row) => ({
        row: { ...row },
        distance: parseFloat(cell(row, 'distance')) || 0,
        similarity: parseFloat(cell(row, 'similarity')) || 0
      }));
    } catch (error) {
      console.error('Error finding similar rows:', error);
      toast({
        title: "Similarity Search Error",
        description: error instanceof Error ? error.message : "Failed to find similar rows",
        variant: "destructive"
      });
      return [];
    }
  }

  // Run similarity search by raw vector
  async findSimilarByVector(
    tableName: string,
    vectorColumn: string,
    queryVector: number[],
    limit = 10,
    distanceMetric: '<=>' | '<->' | '<#>' = '<=>'
  ): Promise<SimilarityResult[]> {
    if (!this.connected || !this.hasPgVector) return [];

    try {
      assertIdent(tableName, 'table');
      assertIdent(vectorColumn, 'column');
      const vectorStr = `[${queryVector.join(',')}]`;
      
      let distanceExpr: string;
      let orderExpr: string;
      let similarityExpr: string;

      switch (distanceMetric) {
        case '<->':
          distanceExpr = `"${vectorColumn}" <-> '${vectorStr}'::vector`;
          orderExpr = distanceExpr;
          similarityExpr = `1.0 / (1.0 + ${distanceExpr})`;
          break;
        case '<#>':
          distanceExpr = `"${vectorColumn}" <#> '${vectorStr}'::vector`;
          orderExpr = distanceExpr;
          similarityExpr = `-(${distanceExpr})`;
          break;
        case '<=>':
        default:
          distanceExpr = `"${vectorColumn}" <=> '${vectorStr}'::vector`;
          orderExpr = distanceExpr;
          similarityExpr = `1.0 - (${distanceExpr})`;
          break;
      }

      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT 
            *,
            ${distanceExpr} as distance,
            ${similarityExpr} as similarity
          FROM "${tableName}"
          WHERE "${vectorColumn}" IS NOT NULL
          ORDER BY ${orderExpr}
          LIMIT ${limit};
        `
      });

      if (!result?.success) return [];

      return result.rows.map((row) => ({
        row: { ...row },
        distance: parseFloat(cell(row, 'distance')) || 0,
        similarity: parseFloat(cell(row, 'similarity')) || 0
      }));
    } catch (error) {
      console.error('Error finding similar by vector:', error);
      toast({
        title: "Similarity Search Error",
        description: error instanceof Error ? error.message : "Failed to find similar rows",
        variant: "destructive"
      });
      return [];
    }
  }

  // Get tables that have vector columns
  getTablesWithVectors(): string[] {
    return [...new Set(this.vectorColumns.map(vc => vc.tableName))];
  }

  async deleteRows(tableName: string, primaryKeyColumn: string, rowIds: string[]): Promise<boolean> {
    if (!this.connected) return false;

    try {
      assertIdent(tableName, 'table');
      assertIdent(primaryKeyColumn, 'column');
      const sql = `DELETE FROM "${tableName}" WHERE "${primaryKeyColumn}" IN (${rowIds.map(id => this.formatValueForSQL(id)).join(',')})`;
      const result = await tauriService.executePostgresQuery({ query: sql });

      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to delete rows");
      }

      return true;
    } catch (error) {
      console.error("Delete rows error:", error);
      toast({
        title: "Delete Error",
        description: error instanceof Error ? error.message : "Failed to delete rows",
        variant: "destructive"
      });
      return false;
    }
  }
}

export const pgService = new PgService(); 