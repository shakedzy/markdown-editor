import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import {
  IpcChannels,
  FileResult,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
  ExportPdfArgs,
} from '../shared/types';

const MARKDOWN_FILTER = {
  name: 'Markdown',
  extensions: ['md', 'markdown', 'mdown', 'mkd'],
};

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
