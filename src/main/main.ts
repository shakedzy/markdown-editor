import { app, BrowserWindow, shell, protocol, net, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers } from './ipc';
import { configureSpellcheck } from './spellcheck';
import { buildAppMenu } from './menu';
import { attachWindow, detachWindow, queuePath, pickPathFromArgv } from './fileOpenQueue';
import { IpcChannels } from '../shared/types';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mditor',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerMditorProtocol(): void {
  protocol.handle('mditor', async (request) => {
    try {
      const u = new URL(request.url);
      let filePath = decodeURIComponent(u.pathname);
      if (process.platform === 'win32' && /^\/[a-z]:/i.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      return new Response(
        `mditor protocol error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500, headers: { 'Content-Type': 'text/plain' } },
      );
    }
  });
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;
let isDirty = false;
let forceClose = false;
let closePromptInFlight = false;
let pendingSaveAction: 'quit' | 'window' | null = null;

function finishClose(mode: 'quit' | 'window'): void {
  forceClose = true;
  if (mode === 'quit') {
    app.quit();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
}

function promptUnsavedChanges(mode: 'quit' | 'window'): void {
  if (closePromptInFlight || !mainWindow || mainWindow.isDestroyed()) return;
  closePromptInFlight = true;
  const win = mainWindow;
  void dialog
    .showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'Save changes before closing?',
      detail: 'Your changes will be lost if you don’t save them.',
    })
    .then((result) => {
      closePromptInFlight = false;
      if (win.isDestroyed()) return;
      if (result.response === 2) return;
      if (result.response === 1) {
        finishClose(mode);
        return;
      }
      pendingSaveAction = mode;
      win.webContents.send('menu:action', 'saveAndQuit');
    })
    .catch(() => {
      closePromptInFlight = false;
    });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (isDev) return;
  queuePath(filePath);
  if (app.isReady() && !mainWindow) {
    void createWindow();
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('second-instance', (_event, argv) => {
  if (isDev) return;
  const filePath = pickPathFromArgv(argv);
  if (filePath) queuePath(filePath);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'MDitor',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  configureSpellcheck(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (forceClose || !isDirty) return;
    event.preventDefault();
    promptUnsavedChanges('window');
  });

  mainWindow.on('closed', () => {
    if (mainWindow) detachWindow(mainWindow);
    mainWindow = null;
    isDirty = false;
    forceClose = false;
    closePromptInFlight = false;
    pendingSaveAction = null;
  });

  if (isDev) {
    await mainWindow.loadURL(DEV_URL);
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'),
    );
  }

  attachWindow(mainWindow);
}

ipcMain.on(IpcChannels.DirtySet, (_event, dirty: boolean) => {
  isDirty = Boolean(dirty);
});

ipcMain.on(IpcChannels.QuitConfirm, () => {
  const mode = pendingSaveAction ?? 'window';
  pendingSaveAction = null;
  finishClose(mode);
});

app.on('before-quit', (event) => {
  if (forceClose || !isDirty) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  event.preventDefault();
  promptUnsavedChanges('quit');
});

void app.whenReady().then(() => {
  registerMditorProtocol();
  registerIpcHandlers();
  buildAppMenu(() => mainWindow);

  if (!isDev) {
    const initial = pickPathFromArgv(process.argv);
    if (initial) queuePath(initial);
  }

  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
