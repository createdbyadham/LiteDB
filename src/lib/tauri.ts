import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import type { DiskSnapshot } from '@/lib/diskGuard';
import type { RowData } from '@/lib/types';

export type SqliteSaveOutcome =
  | { status: 'saved'; mtime: number }
  | { status: 'changed' | 'in-use' | 'missing' };

// Define types matching the Rust backend
export interface QueryResult {
  success: boolean;
  columns: string[];
  rows: RowData[];
  /** Rows returned. Zero for an UPDATE or DELETE. */
  row_count: number;
  /**
   * Rows the statement changed, as reported by the server.
   *
   * The only honest answer to "did my write do anything?" — an UPDATE whose
   * WHERE matches nothing succeeds and returns no rows, which looks identical
   * to one that changed thousands.
   */
  rows_affected: number;
  error?: string;
}

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

// Wrapper for Tauri commands to handle database operations
export const tauriService = {
  // PostgreSQL
  connectPostgres: async (config: PgConfig): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await invoke<QueryResult>('connect_postgres', { config });
      return { success: result.success, error: result.error };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  executePostgresQuery: async (params: { query: string }): Promise<QueryResult> => {
    try {
      return await invoke<QueryResult>('execute_postgres_query', {
        query: params.query
      });
    } catch (e) {
      return {
        success: false,
        columns: [],
        rows: [],
        row_count: 0,
        rows_affected: 0,
        error: String(e)
      };
    }
  },

  disconnectPostgres: async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await invoke<QueryResult>('disconnect_postgres');
      return { success: result.success, error: result.error };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  // SQLite files. Read, checked and saved in Rust (src-tauri/src/sqlite_file.rs)
  // so the check and the write happen under one file handle.

  sqliteDiskState: (filePath: string): Promise<DiskSnapshot> =>
    invoke<DiskSnapshot>('sqlite_disk_state', { path: filePath }),

  /** The bytes and the modified time they belong to, read together. Throws on failure. */
  readSqliteFile: async (filePath: string): Promise<{ data: Uint8Array; snapshot: DiskSnapshot }> => {
    const body = new Uint8Array(await invoke<ArrayBuffer>('read_sqlite_file', { path: filePath }));
    const metaLength = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
    const snapshot = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + metaLength))) as DiskSnapshot;
    // slice, not subarray: callers take `.buffer`, which must not include the header.
    return { data: body.slice(4 + metaLength), snapshot };
  },

  /** Throws only for I/O errors; conflicts come back as a status. */
  saveSqliteFile: (filePath: string, data: Uint8Array, expectedMtime: number | null): Promise<SqliteSaveOutcome> => {
    const meta = new TextEncoder().encode(JSON.stringify({ path: filePath, expectedMtime }));
    const body = new Uint8Array(4 + meta.length + data.length);
    new DataView(body.buffer).setUint32(0, meta.length, true);
    body.set(meta, 4);
    body.set(data, 4 + meta.length);
    return invoke<SqliteSaveOutcome>('save_sqlite_file', body);
  },

  exportDatabase: async (data: string, format: string): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    try {
      const filePath = await save({
        filters: [{
          name: format.toUpperCase(),
          extensions: [format.toLowerCase()]
        }]
      });

      if (!filePath) return { success: false, error: 'Export cancelled' };

      // Handle data writing based on format (similar to Electron implementation)
      // If it's base64 image data
      if (['png', 'jpg', 'jpeg'].includes(format.toLowerCase()) && data.startsWith('data:')) {
        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        await writeFile(filePath, binaryData);
      } else {
        // Text data (SVG, SQL, JSON, CSV)
        const encoder = new TextEncoder();
        await writeFile(filePath, encoder.encode(data));
      }

      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  openFileDialog: async (): Promise<string | null> => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'SQLite Database',
          extensions: ['db', 'sqlite', 'sqlite3']
        }]
      });
      return selected as string | null;
    } catch (e) {
      console.error('Error opening file dialog:', e);
      return null;
    }
  }
};
