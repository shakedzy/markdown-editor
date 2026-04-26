import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
  IpcChannels,
  FileResult,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
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
}
