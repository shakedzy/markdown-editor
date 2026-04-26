import { promises as fs } from 'node:fs';
import { BrowserWindow } from 'electron';
import { IpcChannels, FileResult } from '../shared/types';

const queued: string[] = [];
let target: BrowserWindow | null = null;

export function queuePath(filePath: string): void {
  if (!filePath) return;
  if (target) {
    void deliver(target, filePath);
  } else {
    queued.push(filePath);
  }
}

export function attachWindow(win: BrowserWindow): void {
  target = win;
  const drain = queued.splice(0);
  for (const p of drain) void deliver(win, p);
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
