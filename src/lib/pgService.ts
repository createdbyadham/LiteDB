// This service handles PostgreSQL database operations
import { toast } from "@/hooks/use-toast";
import { tauriService } from '@/lib/tauri';
import { quoteIdent, quoteLiteral, primaryKeyColumns, escapeLike, ROW_LOCATOR } from '@/lib/types';
import type { TableQuery, TablePage } from '@/lib/types';
import { assertWritable, clearActiveConnection } from '@/lib/queryGate';
import { classifyStatement } from '@/lib/sqlClassifier';
import { pgSslHint } from '@/lib/pgSslHint';
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
      clearActiveConnection();

      const message = error instanceof Error ? error.message : "Failed to connect to PostgreSQL database";
      const hint = pgSslHint(message, config.ssl ?? false);
      toast({
        title: "Connection Error",
        description: hint ? `${hint} (${message})` : message,
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
            table_type,
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
        sql: cell(row, 'sql'),
        type: cell(row, 'table_type') === 'VIEW' ? 'view' as const : 'table' as const
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
            a.attrelid = ${quoteLiteral(quoteIdent(tableName))}::regclass
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

  /**
   * One page of a table with search and sort done by the server, plus the
   * matching row count. The grid used to fetch the first 1000 rows and page,
   * search and sort only those.
   */
  async queryTable(tableName: string, q: TableQuery): Promise<TablePage> {
    if (!this.connected) return { columns: [], rows: [], total: 0 };

    try {
      const columns = await this.getTableColumns(tableName);
      if (columns.length === 0) return { columns: [], rows: [], total: 0 };
      const from = quoteIdent(tableName, 'table');
      const names = columns.map(c => c.name);
      const readOnly = this.isView(tableName);
      // No primary key: carry the ctid so single rows can still be addressed.
      const useCtid = !readOnly && primaryKeyColumns(columns).length === 0;

      // pgvector columns come back as binary sqlx cannot decode; read them as text.
      const selectClause = columns
        .map(col => (col.type.startsWith('vector') ? `${quoteIdent(col.name)}::text AS ${quoteIdent(col.name)}` : quoteIdent(col.name)))
        .join(', ');

      let where = '';
      const search = q.search?.trim();
      if (search) {
        const pattern = quoteLiteral(`%${escapeLike(search)}%`);
        where = ' WHERE ' + names.map(n => `${quoteIdent(n)}::text ILIKE ${pattern} ESCAPE '\\'`).join(' OR ');
      }

      let order = '';
      if (q.sortColumn && names.includes(q.sortColumn)) {
        order = q.sortDirection === 'desc'
          ? ` ORDER BY ${quoteIdent(q.sortColumn)} DESC NULLS LAST`
          : ` ORDER BY ${quoteIdent(q.sortColumn)} ASC NULLS FIRST`;
      }

      const limit = Math.max(1, Math.trunc(q.limit));
      const offset = Math.max(0, Math.trunc(q.offset));
      const [count, page] = await Promise.all([
        tauriService.executePostgresQuery({ query: `SELECT COUNT(*)::bigint AS n FROM ${from}${where};` }),
        tauriService.executePostgresQuery({ query: `SELECT ${selectClause}${useCtid ? `, ctid::text AS ${quoteIdent(ROW_LOCATOR)}` : ''} FROM ${from}${where}${order} LIMIT ${limit} OFFSET ${offset};` }),
      ]);
      if (!page?.success) throw new Error(page?.error || 'Failed to retrieve table data');
      if (!count?.success) throw new Error(count?.error || 'Failed to count rows');

      return {
        columns: names,
        rows: page.rows || [],
        total: Number(cell(count.rows[0] ?? {}, 'n')) || 0,
        readOnly,
        rowLocator: useCtid ? ROW_LOCATOR : undefined,
      };
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

  async getTableData(tableName: string, limit = 1000, offset = 0): Promise<{ columns: string[], rows: RowData[] }> {
    if (!this.connected) {
      return { columns: [], rows: [] };
    }

    try {
      // SELECT * returns pgvector columns as raw binary which sqlx can't decode to string,
      // so we try to introspect columns and cast vector columns to text. Falls back to *.
      // A negative limit means every row (exports).
      const page = limit < 0 ? '' : ` LIMIT ${Math.trunc(limit)} OFFSET ${Math.max(0, Math.trunc(offset))}`;
      let query = `SELECT * FROM ${quoteIdent(tableName)}${page};`;

      try {
        const columns = await this.getTableColumns(tableName);
        if (columns.length > 0) {
          const selectClause = columns.map(col => {
            if (col.type.startsWith('vector')) {
              return `${quoteIdent(col.name)}::text AS ${quoteIdent(col.name)}`;
            }
            return `${quoteIdent(col.name)}`;
          }).join(', ');
          query = `SELECT ${selectClause} FROM ${quoteIdent(tableName)}${page};`;
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
      // pg_catalog, not information_schema: joining key_column_usage to
      // constraint_column_usage pairs every column of a composite key with
      // every other (a 2-column FK came back as 4 relations), and
      // constraint_column_usage only shows tables the current role owns.
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT
            c.conname AS constraint_name,
            a.attname AS from_column,
            rt.relname AS to_table,
            ra.attname AS to_column,
            c.confupdtype AS update_code,
            c.confdeltype AS delete_code,
            k.ord AS seq
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_class rt ON rt.oid = c.confrelid
          CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refattnum
          WHERE c.contype = 'f'
            AND n.nspname = 'public'
            AND t.relname = ${quoteLiteral(tableName)}
          ORDER BY c.conname, k.ord;
        `
      });

      if (!result || !result.success) {
        return [];
      }

      const action = (code: string) =>
        ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' } as Record<string, string>)[code] ?? 'NO ACTION';
      const ids = new Map<string, number>();

      return result.rows.map((row) => {
        const name = cell(row, 'constraint_name');
        if (!ids.has(name)) ids.set(name, ids.size);
        return {
          id: ids.get(name)!,
          seq: Number(cell(row, 'seq')) - 1,
          table: cell(row, 'to_table'),
          from: cell(row, 'from_column'),
          to: cell(row, 'to_column'),
          on_update: action(cell(row, 'update_code')),
          on_delete: action(cell(row, 'delete_code')),
          match: 'NONE'
        };
      });
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
      // Arrays reach us as Postgres text ("{a,b}"), so the column list is sent
      // as JSON. Limited to the public schema like the table list, so a table
      // of the same name elsewhere does not lend its indexes.
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT
            i.relname AS index_name,
            ix.indisunique AS is_unique,
            COALESCE((
              SELECT json_agg(a.attname ORDER BY k.ord)
              FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
            ), '[]'::json)::text AS columns
          FROM pg_class t
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_index ix ON ix.indrelid = t.oid
          JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE n.nspname = 'public'
            AND t.relname = ${quoteLiteral(tableName)}
            AND t.relkind IN ('r', 'p')
          ORDER BY i.relname;
        `
      });

      if (!result || !result.success) {
        return [];
      }

      const parseColumns = (raw: unknown): string[] => {
        if (Array.isArray(raw)) return raw.map(String);
        try {
          const parsed = JSON.parse(String(raw ?? '[]'));
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      };

      return result.rows.map((row) => ({
        name: cell(row, 'index_name'),
        unique: row.is_unique === true || row.is_unique === 't' || row.is_unique === 'true',
        columns: parseColumns(row.columns)
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

  async executeQuery(sql: string): Promise<{ columns: string[], rows: unknown[][], rowsAffected: number } | null> {
    if (!this.connected) {
      toast({
        title: "Error",
        description: "No PostgreSQL connection",
        variant: "destructive"
      });
      return null;
    }

    // Second layer. The SQL editor already asks the gate before it gets here,
    // but a read-only connection has to hold for every caller — including the
    // table editor and anything added later that forgets to ask. Thrown rather
    // than toasted so the caller learns the statement did not run.
    const classification = classifyStatement(sql);
    if (classification.kind !== 'read') {
      assertWritable(`the ${classification.verb || 'statement'}`);
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
        rows: (result.rows || []) as unknown as unknown[][],
        rowsAffected: result.rows_affected ?? 0
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
      assertWritable(`the insert into ${tableName}`);
      const columns = Object.keys(rowData);
      const values = Object.values(rowData);

      if (columns.length === 0) {
        return false;
      }

      const columnNames = columns.map(c => `${quoteIdent(c)}`).join(', ');
      const valuePlaceholders = values.map(v => this.formatValueForSQL(v)).join(', ');

      const sql = `
        INSERT INTO ${quoteIdent(tableName)} (${columnNames})
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

  /**
   * WHERE clause naming exactly one row by its whole primary key. Using only
   * the first key column rewrote or deleted every row sharing that value.
   */
  private isView(tableName: string): boolean {
    return this.currentTables.some(t => t.name === tableName && t.type === 'view');
  }

  private keyWhere(keyColumns: { name: string }[], row: RowData): string {
    if (keyColumns.length === 0) {
      // ctid is the row's physical address. It changes when the row is
      // updated, so an edit to a row someone else just changed matches
      // nothing and is reported, instead of hitting a different row.
      const ctid = row[ROW_LOCATOR];
      if (typeof ctid !== 'string') {
        throw new Error('This table has no primary key, so a single row cannot be addressed. Use the SQL editor');
      }
      return `ctid = ${quoteLiteral(ctid)}::tid`;
    }
    return keyColumns
      .map(col => {
        const value = row[col.name];
        if (value === undefined) throw new Error(`Row is missing its key column ${col.name}`);
        return value === null
          ? `${quoteIdent(col.name)} IS NULL`
          : `${quoteIdent(col.name)} = ${this.formatValueForSQL(value)}`;
      })
      .join(' AND ');
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
      assertWritable(`the edit to ${tableName}`);
      if (this.isView(tableName)) throw new Error(`${tableName} is a view, so it is read-only`);
      const keyColumns = primaryKeyColumns(await this.getTableColumns(tableName));

      const changes = Object.entries(newRow).filter(([column, value]) => column !== ROW_LOCATOR && oldRow[column] !== value);
      if (changes.length === 0) return true;

      const setClauses = changes.map(([column, value]) => `${quoteIdent(column)} = ${this.formatValueForSQL(value)}`);
      const sql = `UPDATE ${quoteIdent(tableName)} SET ${setClauses.join(', ')} WHERE ${this.keyWhere(keyColumns, oldRow)};`;

      const result = await tauriService.executePostgresQuery({ query: sql });
      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to update row");
      }
      if (result.rows_affected === 0) {
        throw new Error('The row no longer exists. It may have been changed or deleted elsewhere');
      }

      return true;
    } catch (error) {
      console.error("Update row error:", error);
      toast({
        title: "Row not updated",
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
      clearActiveConnection();
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
      const result = await tauriService.executePostgresQuery({
        query: `
          SELECT ${quoteIdent(columnName)}::text as vector_text
          FROM ${quoteIdent(tableName)}
          WHERE ${quoteIdent(columnName)} IS NOT NULL
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
      // Build the query based on the distance metric
      let distanceExpr: string;
      let orderExpr: string;
      let similarityExpr: string;

      switch (distanceMetric) {
        case '<->': // L2 distance
          distanceExpr = `t.${quoteIdent(vectorColumn)} <-> source.${quoteIdent(vectorColumn)}`;
          orderExpr = distanceExpr;
          similarityExpr = `1.0 / (1.0 + ${distanceExpr})`;
          break;
        case '<#>': // Inner product (negative)
          distanceExpr = `t.${quoteIdent(vectorColumn)} <#> source.${quoteIdent(vectorColumn)}`;
          orderExpr = distanceExpr;
          similarityExpr = `-(${distanceExpr})`; // Higher is more similar
          break;
        case '<=>': // Cosine distance
        default:
          distanceExpr = `t.${quoteIdent(vectorColumn)} <=> source.${quoteIdent(vectorColumn)}`;
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
          FROM ${quoteIdent(tableName)} t
          CROSS JOIN (
            SELECT ${quoteIdent(vectorColumn)} 
            FROM ${quoteIdent(tableName)} 
            WHERE ${quoteIdent(primaryKeyColumn)} = ${escapedRowId}
          ) source
          WHERE t.${quoteIdent(primaryKeyColumn)} != ${escapedRowId}
            AND t.${quoteIdent(vectorColumn)} IS NOT NULL
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
      const vectorStr = `[${queryVector.join(',')}]`;
      
      let distanceExpr: string;
      let orderExpr: string;
      let similarityExpr: string;

      switch (distanceMetric) {
        case '<->':
          distanceExpr = `${quoteIdent(vectorColumn)} <-> '${vectorStr}'::vector`;
          orderExpr = distanceExpr;
          similarityExpr = `1.0 / (1.0 + ${distanceExpr})`;
          break;
        case '<#>':
          distanceExpr = `${quoteIdent(vectorColumn)} <#> '${vectorStr}'::vector`;
          orderExpr = distanceExpr;
          similarityExpr = `-(${distanceExpr})`;
          break;
        case '<=>':
        default:
          distanceExpr = `${quoteIdent(vectorColumn)} <=> '${vectorStr}'::vector`;
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
          FROM ${quoteIdent(tableName)}
          WHERE ${quoteIdent(vectorColumn)} IS NOT NULL
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

  /** Delete the given rows, each named by its whole primary key, in one transaction. */
  async deleteRows(tableName: string, rows: RowData[]): Promise<boolean> {
    if (!this.connected) return false;
    if (rows.length === 0) return true;

    try {
      assertWritable(`the row deletion from ${tableName}`);
      if (this.isView(tableName)) throw new Error(`${tableName} is a view, so it is read-only`);
      const keyColumns = primaryKeyColumns(await this.getTableColumns(tableName));
      const where = rows.map(row => `(${this.keyWhere(keyColumns, row)})`).join(' OR ');
      const sql = `DELETE FROM ${quoteIdent(tableName)} WHERE ${where}`;
      const result = await tauriService.executePostgresQuery({ query: sql });

      if (!result || !result.success) {
        throw new Error(result?.error || "Failed to delete rows");
      }

      return true;
    } catch (error) {
      console.error("Delete rows error:", error);
      toast({
        title: "Rows not deleted",
        description: error instanceof Error ? error.message : "Failed to delete rows",
        variant: "destructive"
      });
      return false;
    }
  }
}

export const pgService = new PgService(); 