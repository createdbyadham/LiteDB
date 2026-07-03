import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile, mkdir } from '@tauri-apps/plugin-fs';

// Define types matching the Rust backend
export interface QueryResult {
  success: boolean;
  columns: string[];
  rows: any[];
  row_count: number;
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

  // File System
  saveDatabase: async (filePath: string, data: Uint8Array): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    try {
      await writeFile(filePath, data);
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  readDatabase: async (filePath: string): Promise<{ success: boolean; data?: Uint8Array; filePath?: string; error?: string }> => {
    try {
      const data = await readFile(filePath);
      return { success: true, data, filePath };
    } catch (e) {
      return { success: false, error: String(e) };
    }
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
