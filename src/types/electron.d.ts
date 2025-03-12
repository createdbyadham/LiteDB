interface ElectronAPI {
  saveDatabase: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; error?: string }>;
  readDatabase: (filePath: string) => Promise<{ success: boolean; data?: Buffer; error?: string; filePath?: string }>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  openFileDialog: (callback: (filePath: string) => void) => () => void;
}

declare global {
  interface Window {
    electron: ElectronAPI | undefined;
  }
}

export interface ElectronFile extends File {
  path: string;
} 