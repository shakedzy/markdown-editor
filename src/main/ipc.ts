import { promises as fs, watch, FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { ipcMain, dialog, app, BrowserWindow, WebContents } from 'electron';
import {
  IpcChannels,
  FileNode,
  FileResult,
  FolderResult,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
  ExportPdfArgs,
} from '../shared/types';

const MARKDOWN_FILTER = {
  name: 'Markdown',
  extensions: ['md', 'markdown', 'mdown', 'mkd'],
};

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-main',
  'dist-renderer',
  'build',
  'out',
  'target',
]);
// Always skipped, even with "show hidden" on: version-control internals, never useful in a markdown tree.
const ALWAYS_IGNORE_HIDDEN_DIRS = new Set(['.git', '.hg', '.svn']);
const MAX_DEPTH = 8;

async function scanDir(dir: string, depth: number, showHidden: boolean): Promise<FileNode[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const hidden = entry.name.startsWith('.');
    if (hidden && ALWAYS_IGNORE_HIDDEN_DIRS.has(entry.name)) continue;
    if (hidden && !showHidden) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const children = await scanDir(full, depth + 1, showHidden);
      if (children.length > 0) {
        nodes.push({ name: entry.name, path: full, type: 'dir', children });
      }
    } else if (entry.isFile() && MD_EXT.test(entry.name)) {
      nodes.push({ name: entry.name, path: full, type: 'file' });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

interface WatchEntry {
  watcher: FSWatcher;
  root: string;
  showHidden: boolean;
  timer: NodeJS.Timeout | null;
}

const watchers = new Map<number, WatchEntry>();

function disposeWatcher(id: number): void {
  const entry = watchers.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher.close();
  watchers.delete(id);
}

function watchFolder(sender: WebContents, root: string, showHidden: boolean): void {
  disposeWatcher(sender.id);
  // Recursive watching is supported on macOS and Windows but not Linux;
  // on Linux we best-effort watch the root level only.
  const recursive = process.platform === 'darwin' || process.platform === 'win32';
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive });
  } catch {
    return;
  }
  const entry: WatchEntry = { watcher, root, showHidden, timer: null };
  watchers.set(sender.id, entry);

  watcher.on('change', () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void (async () => {
        const tree = await scanDir(root, 0, entry.showHidden);
        if (!sender.isDestroyed()) {
          sender.send(IpcChannels.FolderChanged, { root, tree } satisfies FolderResult);
        }
      })();
    }, 300);
  });
  watcher.on('error', () => disposeWatcher(sender.id));
  sender.once('destroyed', () => disposeWatcher(sender.id));
}

async function openFolderAt(
  sender: WebContents,
  root: string,
  showHidden: boolean,
): Promise<FolderResult> {
  const tree = await scanDir(root, 0, showHidden);
  watchFolder(sender, root, showHidden);
  return { root, tree };
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.FileOpen, async (event): Promise<FileResult | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open Markdown',
      properties: ['openFile'],
      filters: [MARKDOWN_FILTER, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0]!;
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  });

  ipcMain.handle(
    IpcChannels.FileRead,
    async (_event, filePath: string): Promise<FileResult | null> => {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return { path: filePath, content };
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FolderOpen,
    async (event, showHidden: boolean): Promise<FolderResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showOpenDialog(win!, {
        title: 'Open Folder',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return openFolderAt(event.sender, result.filePaths[0]!, showHidden);
    },
  );

  ipcMain.handle(
    IpcChannels.FolderReopen,
    async (event, root: string, showHidden: boolean): Promise<FolderResult | null> => {
      try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) return null;
      } catch {
        return null;
      }
      return openFolderAt(event.sender, root, showHidden);
    },
  );

  ipcMain.handle(
    IpcChannels.FileSave,
    async (_event, args: SaveArgs): Promise<SaveResult> => {
      await fs.writeFile(args.path, args.content, 'utf8');
      return { path: args.path };
    },
  );

  ipcMain.handle(
    IpcChannels.FileSaveAs,
    async (event, args: SaveAsArgs): Promise<SaveResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showSaveDialog(win!, {
        title: 'Save Markdown',
        defaultPath: args.suggestedName ?? 'Untitled.md',
        filters: [MARKDOWN_FILTER],
      });
      if (result.canceled || !result.filePath) return null;
      let target = result.filePath;
      if (!/\.[a-z0-9]+$/i.test(basename(target))) target += '.md';
      await fs.writeFile(target, args.content, 'utf8');
      return { path: target };
    },
  );

  ipcMain.handle(
    IpcChannels.PdfExport,
    async (event, args: ExportPdfArgs): Promise<SaveResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export to PDF',
        defaultPath: args.suggestedName ?? 'Untitled.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return null;
      let target = result.filePath;
      if (!/\.pdf$/i.test(target)) target += '.pdf';

      // Render the document in a throwaway offscreen window and print it. A temp
      // file (rather than a data: URL) keeps a stable file origin, and the HTML's
      // own <base href> resolves any relative asset/font URLs against the app.
      const tmpFile = join(
        app.getPath('temp'),
        `mditor-export-${Date.now()}-${process.pid}.html`,
      );
      await fs.writeFile(tmpFile, args.html, 'utf8');

      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // Throwaway window that only ever loads our own generated document;
          // relaxing this lets bundled fonts/assets load across origins.
          webSecurity: false,
        },
      });

      try {
        await pdfWin.loadFile(tmpFile);
        // Give fonts and images (KaTeX, mditor:// assets) a chance to settle so
        // they aren't missing from the printed output. Capped so a broken asset
        // can't stall the export.
        await pdfWin.webContents
          .executeJavaScript(
            `(async () => {
              const timeout = new Promise((r) => setTimeout(r, 4000));
              const ready = (async () => {
                try { if (document.fonts?.ready) await document.fonts.ready; } catch {}
                await Promise.all(Array.from(document.images).map((img) =>
                  img.complete ? null : new Promise((res) => {
                    img.addEventListener('load', res, { once: true });
                    img.addEventListener('error', res, { once: true });
                  })));
              })();
              await Promise.race([ready, timeout]);
              return true;
            })()`,
          )
          .catch(() => undefined);

        const data = await pdfWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
        });
        await fs.writeFile(target, data);
        return { path: target };
      } finally {
        if (!pdfWin.isDestroyed()) pdfWin.destroy();
        void fs.unlink(tmpFile).catch(() => undefined);
      }
    },
  );
}
