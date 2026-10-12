import { app, BrowserWindow, protocol, net, ipcMain, dialog, session } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pickMarkdownFile, registerIpcHandlers } from './ipc';
import { configureSpellcheck } from './spellcheck';
import {
  initAppMenu,
  parseMenuToggles,
  rebuildMenu,
  sendMenuAction,
  setMenuToggles,
  setVimKeys,
} from './menu';
import {
  attachWindow,
  deliveringPath,
  detachWindow,
  queuePathForWindow,
  pickPathFromArgv,
} from './fileOpenQueue';
import { getDocumentPath, readDocument, readText, windowShowing } from './watcher';
import { forgetRecent, isRecent, noteRecent, onRecentChange } from './recent';
import {
  Orphan,
  hasRecoveryCopy,
  keepRecoveryOnClose,
  offerRecovery,
  restoreInto,
} from './recovery';
import { guardFileRequests, guardNavigation, openLeavingLink } from './links';
import { mditorPath } from './assets';
import { IpcChannels, FileResult, MenuToggles, OpenPathArgs } from '../shared/types';
import { isMarkdownPath } from '../shared/fileTypes';

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
      const filePath = mditorPath(new URL(request.url));
      if (filePath === null) {
        return new Response('mditor protocol error: not a local file', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
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
// A window whose page crashes again within this long isn't reloaded again.
const CRASH_RELOAD_GAP_MS = 10_000;

interface WindowState {
  dirty: boolean;
  /** Auto-save is on and saving the window's document, so closing saves without asking. */
  autoSave: boolean;
  /** Closing already asked the window to save; if it is still open, that save failed. */
  autoSaveCloseSent: boolean;
  forceClose: boolean;
  /**
   * The quit under way already saved the window's changes or was told not to
   * keep them. Only for that quit, and only until the window has changes
   * again: if a later window cancels it, the window is asked about again.
   */
  quitHandled: boolean;
  closePromptInFlight: boolean;
  pendingSaveAction: 'quit' | 'window' | null;
}

const windowStates = new WeakMap<BrowserWindow, WindowState>();
const prelaunchPaths: string[] = [];
// Set while finishClose carries a quit on to the next window, as opposed to
// the user starting a quit afresh.
let continuingQuit = false;

function getState(win: BrowserWindow): WindowState {
  let s = windowStates.get(win);
  if (!s) {
    s = {
      dirty: false,
      autoSave: false,
      autoSaveCloseSent: false,
      forceClose: false,
      quitHandled: false,
      closePromptInFlight: false,
      pendingSaveAction: null,
    };
    windowStates.set(win, s);
  }
  return s;
}

/**
 * Whether closing `win` would lose unsaved changes. A recovery copy counts:
 * a page that reloaded (or was given a crashed session's work) reports itself
 * clean before it has restored the copy, and drops the copy once it is clean.
 */
function hasUnsavedChanges(win: BrowserWindow): boolean {
  return getState(win).dirty || hasRecoveryCopy(win);
}

function finishClose(win: BrowserWindow, mode: 'quit' | 'window'): void {
  const s = getState(win);
  if (mode === 'quit') {
    s.quitHandled = true;
    // before-quit runs within app.quit().
    continuingQuit = true;
    try {
      app.quit();
    } finally {
      continuingQuit = false;
    }
  } else {
    s.forceClose = true;
    if (!win.isDestroyed()) win.destroy();
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
      sendMenuAction(win, 'saveAndQuit');
    })
    .catch(() => {
      s.closePromptInFlight = false;
    });
}

/** Close or quit despite unsaved changes in `win`: save them when auto-save is on, else ask. */
function closeDirtyWindow(win: BrowserWindow, mode: 'quit' | 'window'): void {
  const s = getState(win);
  // A crashed page can neither save nor be asked to. Its unsaved work lives
  // on in its recovery copy, which the next launch offers to restore.
  if (!win.isDestroyed() && win.webContents.isCrashed()) {
    keepRecoveryOnClose(win);
    // Not from within the close event or before-quit that got here.
    setImmediate(() => finishClose(win, mode));
    return;
  }
  // Auto-save would have written the changes anyway. If the window is still
  // open on the next attempt that save failed, so ask then: "Don't Save"
  // must stay reachable.
  if (s.autoSave && !s.autoSaveCloseSent && !win.isDestroyed()) {
    s.autoSaveCloseSent = true;
    s.pendingSaveAction = mode;
    sendMenuAction(win, 'saveAndQuit');
    return;
  }
  promptUnsavedChanges(win, mode);
}

/** Bring `win` to the front, restoring it if it is minimized. */
function revealWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.focus();
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
  void openDocument(filePath, null);
});

app.on('second-instance', (_event, argv, workingDirectory) => {
  if (isDev) return;
  const filePath = pickPathFromArgv(argv);
  if (filePath) {
    // Relative to where the second instance was started, not to this one.
    void openDocument(path.resolve(workingDirectory, filePath), null);
    return;
  }
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (focused) revealWindow(focused);
});

interface CreateWindowOptions {
  /** Start with an empty document, bypassing the "welcome on launch" content. */
  blank?: boolean;
  /** Unsaved work from a crashed session for the window to show instead. */
  recovered?: Orphan;
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

  if (options.recovered) restoreInto(win, options.recovered);

  configureSpellcheck(win);

  // Links that open a new window (target=_blank, middle-click) go to the
  // browser or mail app; no other kind of URL is handed to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLeavingLink(win, url);
    return { action: 'deny' };
  });
  guardNavigation(win);

  win.on('close', (event) => {
    if (getState(win).forceClose || !hasUnsavedChanges(win)) return;
    event.preventDefault();
    closeDirtyWindow(win, 'window');
  });

  // Files queued for the window go to its page once it has loaded. A reload
  // (View > Reload, or after a crash) starts the page over, untitled: it gets
  // its unsaved work back from the recovery copy, or else its file (a clean
  // document has no copy).
  let leavingPath: string | null = null;
  let reloadingPath: string | null = null;
  win.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    // Read before the new page makes the window untitled. A page left before
    // its file reached it (reloads in quick succession) passes the file on.
    if (isMainFrame && !isSameDocument) {
      leavingPath = getDocumentPath(win) ?? deliveringPath(win) ?? reloadingPath;
    }
  });
  // Taken up only once the new page commits, which none that guardNavigation
  // stops does. A reload that never finished loading (it crashed) still owes
  // its page the file.
  win.webContents.on('did-navigate', () => {
    reloadingPath = leavingPath ?? reloadingPath;
  });
  win.webContents.on('did-finish-load', () => {
    const docPath = reloadingPath;
    reloadingPath = null;
    // Whether there is a recovery copy is only known now: the old page sent
    // its last unsaved changes as it went. A file another window has opened
    // meanwhile stays there.
    if (docPath !== null && !hasRecoveryCopy(win) && !windowShowing(docPath)) {
      queuePathForWindow(win, docPath, { reopen: true });
    }
    attachWindow(win);
  });

  // A crashed page is reloaded (see above). One that crashes again straight
  // away (its document may be the cause) is left as it is.
  let lastCrash = -Infinity;
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    if (now - lastCrash > CRASH_RELOAD_GAP_MS) {
      win.webContents.reload();
    } else {
      void dialog.showMessageBox(win, {
        type: 'error',
        message: 'This window stopped working.',
        detail:
          'View > Reload tries again. Closing the window keeps its unsaved changes, and MDitor offers them the next time it starts.',
      });
    }
    lastCrash = now;
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
}

ipcMain.on(IpcChannels.DirtySet, (event, dirty: unknown, autoSave: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const s = getState(win);
  const wasDirty = s.dirty;
  s.dirty = Boolean(dirty);
  s.autoSave = autoSave === true;
  if (!s.dirty) s.autoSaveCloseSent = false;
  // Edited again after the quit under way saved it (while another window's
  // prompt was up): that quit asks about it again.
  if (s.dirty && !wasDirty) s.quitHandled = false;
});

// Windows whose editor has Vim keys on; the focused one decides whether menu
// shortcuts make way for Vim's Ctrl keys.
const vimWindows = new WeakSet<BrowserWindow>();

ipcMain.on(IpcChannels.VimModeSet, (event, on: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (on === true) vimWindows.add(win);
  else vimWindows.delete(win);
  if (win.isFocused()) setVimKeys(on === true);
});

// Each window's on/off states; the focused one's are the menu's checkmarks.
const windowToggles = new WeakMap<BrowserWindow, MenuToggles>();

ipcMain.on(IpcChannels.MenuTogglesSet, (event, toggles: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const parsed = parseMenuToggles(toggles);
  windowToggles.set(win, parsed);
  if (win.isFocused()) setMenuToggles(parsed);
});

app.on('browser-window-focus', (_event, win) => {
  setVimKeys(vimWindows.has(win));
  setMenuToggles(windowToggles.get(win) ?? null);
});

// Vim's :q closes the window the way its close button does. :q!, and :wq once
// its save went through, close it without asking about unsaved changes.
ipcMain.on(IpcChannels.WindowClose, (event, force: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (force === true) finishClose(win, 'window');
  else win.close();
});

ipcMain.on(IpcChannels.WindowNew, () => {
  void createWindow(undefined, { blank: true });
});

// Open…: the picked file loads into the asking window (FileOpen) or a new one
// (WindowOpen), unless a window already shows it.
ipcMain.handle(IpcChannels.FileOpen, async (event): Promise<FileResult | null> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const filePath = await pickMarkdownFile(win);
  return filePath ? openDocument(filePath, win) : null;
});

ipcMain.handle(IpcChannels.WindowOpen, async (event): Promise<void> => {
  const filePath = await pickMarkdownFile(BrowserWindow.fromWebContents(event.sender));
  if (!filePath) return;
  // Checked before a window is made for it, which would otherwise stay empty
  // with no word why; the error reaches the asking window's banner.
  if (!(await fs.stat(filePath)).isFile()) throw new Error('It isn’t a file.');
  // Readable, and UTF-8 text.
  await readText(filePath);
  await openDocument(filePath, null);
});

/**
 * Why `filePath` can't be opened as a document (null if it can): it must be
 * an existing file that is Markdown or that the user opened here before
 * (Open… also offers "All Files"). A file that no longer exists is dropped
 * from Open Recent.
 */
async function openProblem(filePath: string): Promise<string | null> {
  if (!isMarkdownPath(filePath) && !isRecent(filePath)) {
    return 'It isn’t a Markdown file.';
  }
  try {
    return (await fs.stat(filePath)).isFile() ? null : 'It isn’t a file.';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return err instanceof Error ? err.message : String(err);
    }
    forgetRecent(filePath);
    return 'The file no longer exists. It may have been moved, renamed or deleted.';
  }
}

/**
 * Show `filePath` (already vetted by openProblem): focus the window that has
 * it open, else read it into `into` (returned for that window's renderer to
 * show) or, without `into`, open it in a new window.
 */
async function openDocument(
  filePath: string,
  into: BrowserWindow | null,
): Promise<FileResult | null> {
  const showing = windowShowing(filePath);
  // A page only asks for a file in its own window when it doesn't show it, so
  // if main has the file down as that window's document the page never got
  // it: load it there again rather than focus a window that doesn't show it.
  if (showing && showing !== into) {
    revealWindow(showing);
    return null;
  }
  if (!into) {
    await createWindow(filePath, { blank: true });
    return null;
  }
  const content = await readDocument(into, filePath);
  noteRecent(filePath);
  return { path: filePath, content };
}

ipcMain.handle(
  IpcChannels.FileOpenPath,
  async (event, args: OpenPathArgs): Promise<FileResult | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof args?.path !== 'string' || !path.isAbsolute(args.path)) {
      throw new Error('Not a file path.');
    }
    const filePath = path.resolve(args.path);
    const problem = await openProblem(filePath);
    if (problem) throw new Error(problem);
    const into = args.inThisWindow === true ? win : null;
    // As for Open…: no new window for a file it couldn't show.
    if (!into && !windowShowing(filePath)) await readText(filePath);
    return openDocument(filePath, into);
  },
);

// Before a file replaces a window's document (Files panel), so the user isn't
// asked about unsaved changes for a file that is already open elsewhere.
ipcMain.handle(IpcChannels.FileFocusWindow, (_event, filePath: unknown): boolean => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  const showing = windowShowing(path.resolve(filePath));
  if (!showing) return false;
  revealWindow(showing);
  return true;
});

async function openRecentFromMenu(filePath: string): Promise<void> {
  const win = BrowserWindow.getFocusedWindow();
  const problem = await openProblem(filePath);
  if (problem) {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: `Couldn’t open “${path.basename(filePath)}”.`,
      detail: problem,
    };
    await (win && !win.isDestroyed()
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options));
    return;
  }
  // The window decides whether to load it in place or in a new window.
  if (win && !win.isDestroyed()) {
    sendMenuAction(win, 'openRecent', { path: filePath });
  } else {
    await openDocument(filePath, null);
  }
}

ipcMain.on(IpcChannels.QuitConfirm, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const s = getState(win);
  const mode = s.pendingSaveAction ?? 'window';
  s.pendingSaveAction = null;
  finishClose(win, mode);
});

app.on('before-quit', (event) => {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  // A quit started afresh asks again about windows an earlier, cancelled
  // quit dealt with: they may have changed since.
  if (!continuingQuit) for (const w of windows) getState(w).quitHandled = false;
  const dirtyWin = windows.find((w) => {
    const s = getState(w);
    return hasUnsavedChanges(w) && !s.forceClose && !s.quitHandled;
  });
  if (!dirtyWin) {
    // The windows close now, those dealt with above too, although they may
    // not have reported their saved state yet.
    for (const w of windows) if (getState(w).quitHandled) getState(w).forceClose = true;
    return;
  }
  event.preventDefault();
  revealWindow(dirtyWin);
  closeDirtyWindow(dirtyWin, 'quit');
});

// The file: request guard covers the windows' default session (below) and
// any session made later.
app.on('session-created', guardFileRequests);

void app.whenReady().then(async () => {
  guardFileRequests(session.defaultSession);
  registerMditorProtocol();
  registerIpcHandlers();
  initAppMenu({
    getFocused: () => BrowserWindow.getFocusedWindow(),
    openRecent: (filePath) => void openRecentFromMenu(filePath),
  });
  onRecentChange(rebuildMenu);

  // Asked before any window opens. Only the instance holding the lock may
  // look: to any other, the running instance's snapshots would look orphaned.
  const recovered = gotLock
    ? await offerRecovery().catch((err) => {
        console.warn('Crash recovery failed:', err);
        return [];
      })
    : [];
  for (const orphan of recovered) void createWindow(undefined, { blank: true, recovered: orphan });

  const initialPaths: string[] = [];
  if (!isDev) {
    const argvPath = pickPathFromArgv(process.argv);
    if (argvPath) initialPaths.push(argvPath);
    initialPaths.push(...prelaunchPaths.splice(0));
  }

  if (initialPaths.length === 0) {
    // Restored documents take the place of the usual first window.
    if (recovered.length === 0) void createWindow();
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
