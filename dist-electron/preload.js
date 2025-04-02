"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
console.log('Preload script starting...');
// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
electron_1.contextBridge.exposeInMainWorld('electron', {
    saveDatabase: async (filePath, data) => {
        console.log('Calling saveDatabase from preload:', filePath);
        return electron_1.ipcRenderer.invoke('save-database', filePath, data);
    },
    readDatabase: async (filePath) => {
        console.log('Calling readDatabase from preload:', filePath);
        return electron_1.ipcRenderer.invoke('read-database', filePath);
    },
    exportDatabase: async (data, format) => {
        console.log('Calling exportDatabase from preload:', format);
        return electron_1.ipcRenderer.invoke('export-database', data, format);
    },
    minimizeWindow: () => {
        return electron_1.ipcRenderer.invoke('minimize-window');
    },
    maximizeWindow: () => {
        return electron_1.ipcRenderer.invoke('maximize-window');
    },
    closeWindow: () => {
        return electron_1.ipcRenderer.invoke('close-window');
    },
    openFileDialog: (callback) => {
        const subscription = (_event, filePath) => {
            callback(filePath);
        };
        electron_1.ipcRenderer.on('selected-file', subscription);
        electron_1.ipcRenderer.send('open-file-dialog');
        return () => {
            electron_1.ipcRenderer.removeListener('selected-file', subscription);
        };
    },
    // PostgreSQL methods
    connectPostgres: async (config) => {
        console.log('Calling connectPostgres from preload:', config.host, config.database);
        return electron_1.ipcRenderer.invoke('connect-postgres', config);
    },
    executePostgresQuery: async (params) => {
        console.log('Calling executePostgresQuery from preload, query length:', params.query.length);
        return electron_1.ipcRenderer.invoke('execute-postgres-query', params);
    },
    disconnectPostgres: async () => {
        console.log('Calling disconnectPostgres from preload');
        return electron_1.ipcRenderer.invoke('disconnect-postgres');
    }
});
console.log('Preload script completed, electron API exposed');
