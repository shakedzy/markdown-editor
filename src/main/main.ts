import { app, BrowserWindow, shell, protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers } from './ipc';
import { configureSpellcheck } from './spellcheck';
import { buildAppMenu } from './menu';
import { attachWindow, queuePath, pickPathFromArgv } from './fileOpenQueue';

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

  mainWindow.on('closed', () => {
    mainWindow = null;
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
