import { app, BrowserWindow, shell, protocol, net, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers } from './ipc';
import { configureSpellcheck } from './spellcheck';
import { buildAppMenu } from './menu';
import {
  attachWindow,
  detachWindow,
  queuePathForWindow,
  pickPathFromArgv,
} from './fileOpenQueue';
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

interface WindowState {
  dirty: boolean;
  forceClose: boolean;
  closePromptInFlight: boolean;
  pendingSaveAction: 'quit' | 'window' | null;
}

const windowStates = new WeakMap<BrowserWindow, WindowState>();
const prelaunchPaths: string[] = [];

function getState(win: BrowserWindow): WindowState {
  let s = windowStates.get(win);
  if (!s) {
    s = {
      dirty: false,
      forceClose: false,
      closePromptInFlight: false,
      pendingSaveAction: null,
    };
    windowStates.set(win, s);
  }
  return s;
}

function finishClose(win: BrowserWindow, mode: 'quit' | 'window'): void {
  const s = getState(win);
  s.forceClose = true;
  if (mode === 'quit') {
    app.quit();
  } else if (!win.isDestroyed()) {
    win.destroy();
  }
}

function promptUnsavedChanges(win: BrowserWindow, mode: 'quit' | 'window'): void {
  const s = getState(win);
  if (s.closePromptInFlight || win.isDestroyed()) return;
  s.closePromptInFlight = true;
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
      s.closePromptInFlight = false;
      if (win.isDestroyed()) return;
      if (result.response === 2) return;
      if (result.response === 1) {
        finishClose(win, mode);
        return;
      }
      s.pendingSaveAction = mode;
      win.webContents.send('menu:action', 'saveAndQuit');
    })
    .catch(() => {
      s.closePromptInFlight = false;
    });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (isDev) return;
  if (!app.isReady()) {
    prelaunchPaths.push(filePath);
    return;
  }
  void createWindow(filePath);
});

app.on('second-instance', (_event, argv) => {
  if (isDev) return;
  const filePath = pickPathFromArgv(argv);
  if (filePath) {
    void createWindow(filePath);
    return;
  }
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (focused) {
    if (focused.isMinimized()) focused.restore();
    focused.focus();
  }
});

interface CreateWindowOptions {
  /** Start with an empty document, bypassing the "welcome on launch" content. */
  blank?: boolean;
}

async function createWindow(
  initialFilePath?: string,
  options: CreateWindowOptions = {},
): Promise<void> {
  const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');

  const win = new BrowserWindow({
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

  windowStates.set(win, {
    dirty: false,
    forceClose: false,
    closePromptInFlight: false,
    pendingSaveAction: null,
  });

  configureSpellcheck(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    const s = getState(win);
    if (s.forceClose || !s.dirty) return;
    event.preventDefault();
    promptUnsavedChanges(win, 'window');
  });

  win.on('closed', () => {
    detachWindow(win);
    windowStates.delete(win);
  });

  if (initialFilePath) {
    queuePathForWindow(win, initialFilePath);
  }

  if (isDev) {
    await win.loadURL(options.blank ? `${DEV_URL}?blank=1` : DEV_URL);
  } else {
    await win.loadFile(
      path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'),
      options.blank ? { query: { blank: '1' } } : undefined,
    );
  }

  attachWindow(win);
}

ipcMain.on(IpcChannels.DirtySet, (event, dirty: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  getState(win).dirty = Boolean(dirty);
});

ipcMain.on(IpcChannels.WindowNew, () => {
  void createWindow(undefined, { blank: true });
});

ipcMain.handle(IpcChannels.WindowOpen, async (event): Promise<void> => {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(parent!, {
    title: 'Open Markdown',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await createWindow(result.filePaths[0], { blank: true });
});

ipcMain.on(IpcChannels.QuitConfirm, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const s = getState(win);
  const mode = s.pendingSaveAction ?? 'window';
  s.pendingSaveAction = null;
  finishClose(win, mode);
});

app.on('before-quit', (event) => {
  const dirtyWin = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && getState(w).dirty && !getState(w).forceClose,
  );
  if (!dirtyWin) return;
  event.preventDefault();
  if (dirtyWin.isMinimized()) dirtyWin.restore();
  dirtyWin.focus();
  promptUnsavedChanges(dirtyWin, 'quit');
});

void app.whenReady().then(() => {
  registerMditorProtocol();
  registerIpcHandlers();
  buildAppMenu(() => BrowserWindow.getFocusedWindow());

  const initialPaths: string[] = [];
  if (!isDev) {
    const argvPath = pickPathFromArgv(process.argv);
    if (argvPath) initialPaths.push(argvPath);
    initialPaths.push(...prelaunchPaths.splice(0));
  }

  if (initialPaths.length === 0) {
    void createWindow();
  } else {
    for (const p of initialPaths) void createWindow(p);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
