import { contextBridge, ipcRenderer } from 'electron';

console.log('Preload script starting...');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
  'electron',
  {
    saveDatabase: async (filePath: string, data: Uint8Array) => {
      console.log('Calling saveDatabase from preload:', filePath);
      return ipcRenderer.invoke('save-database', filePath, data);
    },
    readDatabase: async (filePath: string) => {
      console.log('Calling readDatabase from preload:', filePath);
      return ipcRenderer.invoke('read-database', filePath);
    },
    exportDatabase: async (data: string, format: string) => {
      console.log('Calling exportDatabase from preload:', format);
      return ipcRenderer.invoke('export-database', data, format);
    },
    minimizeWindow: () => {
      return ipcRenderer.invoke('minimize-window');
    },
    maximizeWindow: () => {
      return ipcRenderer.invoke('maximize-window');
    },
    closeWindow: () => {
      return ipcRenderer.invoke('close-window');
    },
    openFileDialog: (callback: (filePath: string) => void) => {
      const subscription = (_event: any, filePath: string) => {
        callback(filePath);
      };
      ipcRenderer.on('selected-file', subscription);
      ipcRenderer.send('open-file-dialog');
      return () => {
        ipcRenderer.removeListener('selected-file', subscription);
      };
    }
  }
);

console.log('Preload script completed, electron API exposed'); 