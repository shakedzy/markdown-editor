import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import { IpcChannels, FileResult } from '../shared/types';
import { isMarkdownPath } from '../shared/fileTypes';
import { readDocument } from './watcher';
import { noteRecent } from './recent';

interface QueuedFile {
  path: string;
  /** The window's own document, back after a reload: not an open, so not a recent file. */
  reopen: boolean;
}

const queuedByWindow = new WeakMap<BrowserWindow, QueuedFile[]>();
// The file each window's page is about to be sent, while main reads it.
const deliveringByWindow = new WeakMap<BrowserWindow, string>();

export function queuePathForWindow(
  win: BrowserWindow,
  filePath: string,
  { reopen = false }: { reopen?: boolean } = {},
): void {
  if (!filePath) return;
  let q = queuedByWindow.get(win);
  if (!q) {
    q = [];
    queuedByWindow.set(win, q);
  }
  q.push({ path: filePath, reopen });
}

export function attachWindow(win: BrowserWindow): void {
  const q = queuedByWindow.get(win);
  if (!q) return;
  for (const file of q.splice(0)) void deliver(win, file);
}

export function detachWindow(win: BrowserWindow): void {
  queuedByWindow.delete(win);
}

/**
 * The file being read for the window's page, if any. It becomes the window's
 * document only once read, but a page that is left meanwhile was to show it.
 */
export function deliveringPath(win: BrowserWindow): string | null {
  return deliveringByWindow.get(win) ?? null;
}

async function deliver(win: BrowserWindow, file: QueuedFile): Promise<void> {
  // argv paths may be relative; the window tracks (and watches) an absolute one.
  const filePath = path.resolve(file.path);
  deliveringByWindow.set(win, filePath);
  try {
    const content = await readDocument(win, filePath);
    if (!file.reopen) noteRecent(filePath);
    const payload: FileResult = { path: filePath, content };
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannels.FileFromOS, payload);
    }
  } catch (err) {
    console.error('Failed to read file from OS:', filePath, err);
    // The window was opened for this file; say why it stays empty.
    if (!win.isDestroyed()) {
      void dialog.showMessageBox(win, {
        type: 'warning',
        message: `Couldn’t open “${path.basename(filePath)}”.`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    deliveringByWindow.delete(win);
  }
}

export function pickPathFromArgv(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) continue;
    if (isMarkdownPath(a)) return a;
  }
  return null;
}
