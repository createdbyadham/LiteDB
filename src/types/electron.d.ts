interface ElectronAPI {
  saveDatabase: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
  readDatabase: (filePath: string) => Promise<{ success: boolean; data?: Buffer; error?: string; filePath?: string }>;
  exportDatabase: (data: string, format: string) => Promise<{ success: boolean; error?: string; filePath?: string }>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  openFileDialog: (callback: (filePath: string) => void) => () => void;
  
  // PostgreSQL methods
  connectPostgres: (config: { host: string; port: number; database: string; username: string; password: string; ssl?: boolean }) => 
    Promise<{ success: boolean; error?: string }>;
  executePostgresQuery: (params: { query: string; values?: any[] }) => 
    Promise<{ success: boolean; columns?: string[]; rows?: any[]; error?: string; rowCount?: number }>;
  disconnectPostgres: () => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electron: ElectronAPI | undefined;
    SQL: any;
    initSqlJs: any;
  }
}

export interface ElectronFile extends File {
  path: string;
} 