import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { normalizeRecent, pathKey, recentLabels, withRecent, withoutRecent } from './recentList';

// Files for File > Open Recent, most recent first, kept in
// <userData>/recent.json. Also mirrored to the OS list (macOS Dock menu,
// Windows jump list).

export interface RecentEntry {
  path: string;
  /** File name plus a shortened parent directory, unique within the list. */
  label: string;
}

let files: string[] | null = null;
const listeners = new Set<() => void>();
let writing: Promise<void> = Promise.resolve();

function storeFile(): string {
  return path.join(app.getPath('userData'), 'recent.json');
}

function list(): string[] {
  if (files) return files;
  files = [];
  try {
    const stored: unknown = JSON.parse(readFileSync(storeFile(), 'utf8'));
    if (Array.isArray(stored)) {
      files = normalizeRecent(
        stored.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)),
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Ignoring unreadable recent files list:', err);
    }
  }
  return files;
}

export function getRecentEntries(): RecentEntry[] {
  const paths = list();
  const labels = recentLabels(paths, os.homedir(), path);
  return paths.map((p, i) => ({ path: p, label: labels[i]! }));
}

/** Whether `filePath` is in the list, i.e. the user opened or saved it here before. */
export function isRecent(filePath: string): boolean {
  const key = pathKey(filePath);
  return list().some((p) => pathKey(p) === key);
}

/** Move `filePath` to the top. Call whenever the user opens a file or saves one under a new name. */
export function noteRecent(filePath: string): void {
  const absolute = path.resolve(filePath);
  app.addRecentDocument(absolute);
  update(withRecent(list(), absolute));
}

/** Drop `filePath`, e.g. because it no longer exists. */
export function forgetRecent(filePath: string): void {
  update(withoutRecent(list(), filePath));
}

export function clearRecent(): void {
  app.clearRecentDocuments();
  update([]);
}

/** Run `listener` after every change to the list (e.g. to rebuild the menu). */
export function onRecentChange(listener: () => void): void {
  listeners.add(listener);
}

function update(next: string[]): void {
  const prev = list();
  if (next.length === prev.length && next.every((p, i) => p === prev[i])) return;
  files = next;
  persist(next);
  for (const listener of listeners) listener();
}

function persist(paths: string[]): void {
  const target = storeFile();
  const data = JSON.stringify(paths, null, 2);
  // Chained so writes land in order, and written aside then renamed over the
  // old list so a crash mid-write can't leave it truncated.
  writing = writing
    .then(async () => {
      const tmp = `${target}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, target);
    })
    .catch((err) => console.warn('Could not save the recent files list:', err));
}
