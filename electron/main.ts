import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === 'development';
const getAssetPath = (...paths: string[]): string => {
  const basePath = isDev ? process.cwd() : path.join(process.resourcesPath, 'app');
  return path.join(basePath, ...paths);
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
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
  } else {
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
  ipcMain.handle('minimize-window', () => {
    if (!mainWindow) return;
    mainWindow.minimize();
  });

  ipcMain.handle('maximize-window', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('close-window', () => {
    if (!mainWindow) return;
    mainWindow.close();
  });
};

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle saving database changes
ipcMain.handle('save-database', async (_event, filePath: string, data: Buffer) => {
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
  } catch (error) {
    console.error('Error saving database:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
});

// Handle reading database file
ipcMain.handle('read-database', async (_event, filePath: string) => {
  try {
    console.log('Reading database from:', filePath);
    
    let absoluteFilePath = filePath;
    
    // If it's not an absolute path, try different ways to resolve it
    if (!path.isAbsolute(filePath)) {
      // First try relative to current working directory
      let testPath = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(testPath)) {
        absoluteFilePath = testPath;
      } else {
        // If that doesn't exist, try relative to user's home directory
        testPath = path.resolve(app.getPath('home'), filePath);
        if (fs.existsSync(testPath)) {
          absoluteFilePath = testPath;
        } else {
          // If that doesn't exist, try relative to downloads directory
          testPath = path.resolve(app.getPath('downloads'), filePath);
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
  } catch (error) {
    console.error('Error reading database:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
});

// Handle file dialog
ipcMain.on('open-file-dialog', (event) => {
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'] as const,
    filters: [
      { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }
    ]
  };

  if (os.platform() === 'linux' || os.platform() === 'win32') {
    dialog.showOpenDialog(options).then(result => {
      if (!result.canceled && result.filePaths.length > 0) {
        event.reply('selected-file', result.filePaths[0]);
      }
    });
  } else {
    dialog.showOpenDialog({
      ...options,
      properties: ['openFile', 'openDirectory'] as const
    }).then(result => {
      if (!result.canceled && result.filePaths.length > 0) {
        event.reply('selected-file', result.filePaths[0]);
      }
    });
  }
}); 