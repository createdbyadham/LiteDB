"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
let mainWindow = null;
const isDev = process.env.NODE_ENV === 'development';
const getAssetPath = (...paths) => {
    const basePath = isDev ? process.cwd() : path.join(process.resourcesPath, 'app');
    return path.join(basePath, ...paths);
};
const createWindow = () => {
    mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 800,
        frame: false, // Remove default window frame
        icon: getAssetPath('public', 'appicon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false // Allow loading local files
        }
    });
    console.log('Created main window with preload script:', path.join(__dirname, 'preload.js'));
    if (isDev) {
        console.log('Running in development mode, loading from localhost:3000');
        mainWindow.loadURL('http://localhost:3000');
        mainWindow.webContents.openDevTools();
    }
    else {
        console.log('Running in production mode');
        const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
        console.log('Loading index from:', indexPath);
        mainWindow.loadFile(indexPath).catch(console.error);
        // Handle any navigation errors
        mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error('Failed to load:', errorCode, errorDescription);
            console.log('Attempting to reload...');
            mainWindow?.loadFile(indexPath).catch(console.error);
        });
    }
    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Window loaded successfully');
    });
    // Window control handlers
    electron_1.ipcMain.handle('minimize-window', () => {
        if (!mainWindow)
            return;
        mainWindow.minimize();
    });
    electron_1.ipcMain.handle('maximize-window', () => {
        if (!mainWindow)
            return;
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        }
        else {
            mainWindow.maximize();
        }
    });
    electron_1.ipcMain.handle('close-window', () => {
        if (!mainWindow)
            return;
        mainWindow.close();
    });
};
electron_1.app.whenReady().then(() => {
    createWindow();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
// Handle saving database changes
electron_1.ipcMain.handle('save-database', async (_event, filePath, data) => {
    try {
        console.log('Received save request:', { filePath, dataLength: data.length });
        // Convert to absolute path if needed
        const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        console.log('Absolute file path:', absoluteFilePath);
        // Ensure the directory exists
        const directory = path.dirname(absoluteFilePath);
        await fs.promises.mkdir(directory, { recursive: true });
        console.log('Writing file to:', absoluteFilePath);
        await fs.promises.writeFile(absoluteFilePath, data);
        console.log('File written successfully');
        return { success: true, filePath: absoluteFilePath };
    }
    catch (error) {
        console.error('Error saving database:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
});
// Handle reading database file
electron_1.ipcMain.handle('read-database', async (_event, filePath) => {
    try {
        console.log('Reading database from:', filePath);
        let absoluteFilePath = filePath;
        // If it's not an absolute path, try different ways to resolve it
        if (!path.isAbsolute(filePath)) {
            // First try relative to current working directory
            let testPath = path.resolve(process.cwd(), filePath);
            if (fs.existsSync(testPath)) {
                absoluteFilePath = testPath;
            }
            else {
                // If that doesn't exist, try relative to user's home directory
                testPath = path.resolve(electron_1.app.getPath('home'), filePath);
                if (fs.existsSync(testPath)) {
                    absoluteFilePath = testPath;
                }
                else {
                    // If that doesn't exist, try relative to downloads directory
                    testPath = path.resolve(electron_1.app.getPath('downloads'), filePath);
                    if (fs.existsSync(testPath)) {
                        absoluteFilePath = testPath;
                    }
                }
            }
        }
        console.log('Resolved absolute file path:', absoluteFilePath);
        if (!fs.existsSync(absoluteFilePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        // Read the file
        const data = await fs.promises.readFile(absoluteFilePath);
        console.log('Database read successfully, size:', data.length);
        return { success: true, data, filePath: absoluteFilePath };
    }
    catch (error) {
        console.error('Error reading database:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
});
// Handle exporting database to different formats
electron_1.ipcMain.handle('export-database', async (_event, data, format) => {
    try {
        console.log('Received export request:', { format, dataLength: data.length });
        // Define file extension based on format
        const fileExtension = format.toLowerCase();
        // Show save dialog
        const result = await electron_1.dialog.showSaveDialog({
            title: 'Export Database',
            defaultPath: `export.${fileExtension}`,
            filters: [
                { name: format.toUpperCase(), extensions: [fileExtension] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePath) {
            return { success: false, error: 'Export cancelled' };
        }
        // Ensure the directory exists
        const directory = path.dirname(result.filePath);
        await fs.promises.mkdir(directory, { recursive: true });
        // Write the file
        console.log('Writing file to:', result.filePath);
        await fs.promises.writeFile(result.filePath, data);
        console.log('File exported successfully');
        return { success: true, filePath: result.filePath };
    }
    catch (error) {
        console.error('Error exporting database:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
});
// Handle file dialog
electron_1.ipcMain.on('open-file-dialog', (event) => {
    const options = {
        properties: ['openFile'],
        filters: [
            { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }
        ]
    };
    if (os.platform() === 'linux' || os.platform() === 'win32') {
        electron_1.dialog.showOpenDialog(options).then(result => {
            if (!result.canceled && result.filePaths.length > 0) {
                event.reply('selected-file', result.filePaths[0]);
            }
        });
    }
    else {
        electron_1.dialog.showOpenDialog({
            ...options,
            properties: ['openFile', 'openDirectory']
        }).then(result => {
            if (!result.canceled && result.filePaths.length > 0) {
                event.reply('selected-file', result.filePaths[0]);
            }
        });
    }
});
