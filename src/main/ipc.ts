import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ipcMain, dialog, app, BrowserWindow, clipboard } from 'electron';
import {
  IpcChannels,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
  ExportPdfArgs,
  ExportHtmlArgs,
  RichClipboard,
  RecoveredDocument,
  DiscardChoice,
  FolderListing,
  PathsExistArgs,
  LinkFileArgs,
  LinkFileResult,
  LinkDirectoryArgs,
  LinkDirEntry,
} from '../shared/types';
import { MARKDOWN_EXTENSIONS } from '../shared/fileTypes';
import { readAssetDataUrl } from './assets';
import { importAssets } from './importAssets';
import { pathsExist } from './pathsExist';
import { SaveConflictError, getDocumentPath, watchDocument, writeDocument } from './watcher';
import { noteRecent } from './recent';
import { parseSnapshot, recordSnapshot, recoveredDocument } from './recovery';
import { closeFolder, listFolder, openFolder } from './folder';
import { listLinkDirectory, openExternalLink, openLinkedFile } from './links';

const MARKDOWN_FILTER: Electron.FileFilter = {
  name: 'Markdown',
  extensions: [...MARKDOWN_EXTENSIONS],
};

/** Ask the user for a file to open, over `win` when there is one (null: cancelled). */
export async function pickMarkdownFile(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Markdown',
    properties: ['openFile'],
    filters: [MARKDOWN_FILTER, { name: 'All Files', extensions: ['*'] }],
  };
  const result = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// Put ahead of the PDF's HTML, whatever the renderer sent: the page is a
// local file, which in Electron may read other local files, so no script in
// it may run, nor any frame (a framed file: page wouldn't inherit this
// policy). Images and media load only from mditor: (the renderer makes the
// document's image and media paths such URLs), https: and data:, never
// straight from file: URLs, though the packaged preview's 'self' allows
// those; fonts come embedded. A later policy can only add restrictions,
// never lift this one.
const PDF_PAGE_POLICY =
  "script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; " +
  'img-src data: https: mditor:; media-src data: mditor:; font-src data:';
const PDF_PAGE_PREFIX =
  '<!doctype html>\n<meta charset="utf-8" />\n' +
  `<meta http-equiv="Content-Security-Policy" content="${PDF_PAGE_POLICY}" />\n`;

// Opening a document (file:open, file:openPath, window:open) is handled in
// main.ts, which makes the windows: every way in goes through openDocument.
export function registerIpcHandlers(): void {
  ipcMain.handle(
    IpcChannels.FileSave,
    async (event, args: SaveArgs): Promise<SaveResult> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      // Save only ever overwrites the window's own document; new targets go
      // through Save As, where the user picks them.
      if (!win || typeof args?.content !== 'string' || args.path !== getDocumentPath(win)) {
        throw new Error('That file is not the document open in this window.');
      }
      try {
        await writeDocument(win, args.path, args.content);
      } catch (err) {
        // Not a failure: the window was sent the disk's version to choose from.
        if (err instanceof SaveConflictError) return { path: args.path, conflict: true };
        throw err;
      }
      return { path: args.path };
    },
  );

  ipcMain.handle(
    IpcChannels.FileSaveAs,
    async (event, args: SaveAsArgs): Promise<SaveResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof args?.content !== 'string') return null;
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Markdown',
        defaultPath: args.suggestedName ?? 'Untitled.md',
        filters: [MARKDOWN_FILTER],
      });
      if (result.canceled || !result.filePath) return null;
      let target = result.filePath;
      if (!/\.[a-z0-9]+$/i.test(basename(target))) target += '.md';
      await writeDocument(win, target, args.content, { overwrite: true });
      noteRecent(target);
      return { path: target };
    },
  );

  ipcMain.on(IpcChannels.FileWatch, (event, filePath: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || (filePath !== null && typeof filePath !== 'string')) return;
    watchDocument(win, filePath);
  });

  // Asked before another file replaces a document with unsaved changes. It
  // names the document main knows the window has, not one the renderer names.
  ipcMain.handle(IpcChannels.FileConfirmDiscard, async (event): Promise<DiscardChoice> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'cancel';
    const docPath = getDocumentPath(win);
    const name = docPath ? basename(docPath) : 'Untitled';
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: `Save changes to “${name}” before opening another file?`,
      detail: 'Your changes will be lost if you don’t save them.',
    });
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  });

  ipcMain.handle(IpcChannels.FolderOpen, async (event): Promise<FolderListing | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? openFolder(win) : null;
  });

  ipcMain.handle(IpcChannels.FolderList, async (event): Promise<FolderListing | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? listFolder(win) : null;
  });

  ipcMain.on(IpcChannels.FolderClose, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) closeFolder(win);
  });

  ipcMain.on(IpcChannels.RecoverySave, (event, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const snapshot = value === null ? null : parseSnapshot(value);
    if (!win || (value !== null && !snapshot)) return;
    recordSnapshot(win, snapshot);
  });

  ipcMain.handle(
    IpcChannels.RecoveryGet,
    async (event): Promise<RecoveredDocument | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return win ? recoveredDocument(win) : null;
    },
  );

  ipcMain.handle(
    IpcChannels.PdfExport,
    async (event, args: ExportPdfArgs): Promise<SaveResult | null> => {
      if (typeof args?.html !== 'string') return null;
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export to PDF',
        defaultPath: args.suggestedName ?? 'Untitled.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return null;
      let target = result.filePath;
      if (!/\.pdf$/i.test(target)) target += '.pdf';

      // Render the document in a throwaway offscreen window and print it. Its
      // fonts come embedded and its local images load through mditor: (the
      // default session's); a temp file (rather than a data: URL) has no
      // length limit.
      const tmpFile = join(
        app.getPath('temp'),
        `mditor-export-${Date.now()}-${process.pid}.html`,
      );
      await fs.writeFile(tmpFile, PDF_PAGE_PREFIX + args.html, 'utf8');

      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      // Nothing in the document may take the window elsewhere, open another,
      // or load a page into a frame (the policy blocks frames too).
      pdfWin.webContents.on('will-navigate', (e) => e.preventDefault());
      pdfWin.webContents.on('will-frame-navigate', (e) => {
        if (!e.isMainFrame) e.preventDefault();
      });
      pdfWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      try {
        await pdfWin.loadFile(tmpFile);
        // Give fonts and images (web ones too) a chance to settle so they
        // aren't missing from the printed output. Capped so a broken asset
        // can't stall the export. Script run from here isn't held to the
        // page's policy.
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

  ipcMain.handle(
    IpcChannels.HtmlExport,
    async (event, args: ExportHtmlArgs): Promise<SaveResult | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof args?.html !== 'string') return null;
      // Offer the document's own folder; the renderer only names the file.
      const name =
        (typeof args.suggestedName === 'string' && basename(args.suggestedName)) ||
        'Untitled.html';
      const docPath = getDocumentPath(win);
      const result = await dialog.showSaveDialog(win, {
        title: 'Export to HTML',
        defaultPath: docPath ? join(dirname(docPath), name) : name,
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      });
      if (result.canceled || !result.filePath) return null;
      let target = result.filePath;
      if (!/\.html?$/i.test(target)) target += '.html';
      await fs.writeFile(target, args.html, 'utf8');
      return { path: target };
    },
  );

  ipcMain.handle(IpcChannels.AssetDataUrl, (event, url: unknown) =>
    readAssetDataUrl(event.sender, url),
  );

  ipcMain.handle(IpcChannels.AssetImport, (event, args: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('No window.');
    return importAssets(win, args);
  });

  // Links are resolved against the document main has open in the window; a
  // renderer naming another one (it is switching documents) gets no answer.
  ipcMain.handle(
    IpcChannels.PathsExist,
    async (event, args: Partial<PathsExistArgs> | undefined): Promise<boolean[] | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const docPath = win && getDocumentPath(win);
      if (!docPath || args?.documentPath !== docPath) return null;
      return pathsExist(dirname(docPath), args.paths);
    },
  );

  // Following and completing the document's links. What the OS may open is
  // decided here, never by the (untrusted) document.
  ipcMain.handle(IpcChannels.LinkOpenExternal, (_event, url: unknown): boolean =>
    openExternalLink(url),
  );

  ipcMain.handle(
    IpcChannels.LinkOpenFile,
    (event, args: Partial<LinkFileArgs> | undefined): Promise<LinkFileResult> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('No window.');
      return openLinkedFile(win, args);
    },
  );

  ipcMain.handle(
    IpcChannels.LinkListDirectory,
    async (
      event,
      args: Partial<LinkDirectoryArgs> | undefined,
    ): Promise<LinkDirEntry[] | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return win ? listLinkDirectory(win, args) : null;
    },
  );

  // The sandboxed renderer can't reach Electron's clipboard, which writes the
  // HTML and plain-text flavors together.
  ipcMain.handle(IpcChannels.ClipboardWrite, (_event, content: RichClipboard): void => {
    if (typeof content?.html !== 'string' || typeof content.text !== 'string') {
      throw new Error('Invalid clipboard content.');
    }
    clipboard.write({ html: content.html, text: content.text });
  });
}
