import { promises as fs } from 'node:fs';
import { BrowserWindow } from 'electron';
import { IpcChannels, FileResult } from '../shared/types';

const queuedByWindow = new WeakMap<BrowserWindow, string[]>();

export function queuePathForWindow(win: BrowserWindow, filePath: string): void {
  if (!filePath) return;
  let q = queuedByWindow.get(win);
  if (!q) {
    q = [];
    queuedByWindow.set(win, q);
  }
  q.push(filePath);
}

export function attachWindow(win: BrowserWindow): void {
  const q = queuedByWindow.get(win);
  if (!q) return;
  for (const p of q.splice(0)) void deliver(win, p);
}

export function detachWindow(win: BrowserWindow): void {
  queuedByWindow.delete(win);
}

async function deliver(win: BrowserWindow, filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const payload: FileResult = { path: filePath, content };
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannels.FileFromOS, payload);
    }
  } catch (err) {
    console.error('Failed to read file from OS:', filePath, err);
  }
}

export function pickPathFromArgv(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) continue;
    if (a.toLowerCase().endsWith('.md') || a.toLowerCase().endsWith('.markdown')) {
      return a;
    }
  }
  return null;
}
