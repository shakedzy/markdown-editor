import { promises as fs, Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FolderEntry } from '../shared/types';
import { isMarkdownPath } from '../shared/fileTypes';

// ~/Library on macOS is hidden in Finder, huge, and reading other apps' data
// in it stalls on privacy prompts.
const MAC_LIBRARY = process.platform === 'darwin' ? path.join(os.homedir(), 'Library') : null;

/** Caps that keep listing a huge folder (a home directory, a drive) quick. */
export interface WalkLimits {
  /** Directory entries looked at, in all. */
  maxEntries: number;
  /** Folder levels listed below the root. */
  maxDepth: number;
  /** Time spent reading folders (a slow network drive), in ms. */
  maxMillis: number;
}

export const WALK_LIMITS: WalkLimits = { maxEntries: 20_000, maxDepth: 12, maxMillis: 5000 };

export interface FolderWalk {
  entries: FolderEntry[];
  /** A limit cut the walk short, so some files may be missing. */
  truncated: boolean;
  /** Every folder that was read, the root first, including those left out of `entries`. */
  folders: string[];
}

/** Hidden entries (.git) and dependency folders are never listed or watched. */
export function isSkippedName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Whether `full`, found below `root`, is inside a folder the walk leaves out. */
function isSkippedPath(root: string, full: string): boolean {
  return MAC_LIBRARY !== null && isWithin(full, MAC_LIBRARY) && !isWithin(root, MAC_LIBRARY);
}

function isWithin(full: string, dir: string): boolean {
  return full === dir || full.startsWith(dir + path.sep);
}

/**
 * Whether a change reported by a watcher on `dir` for `name` (relative to
 * it) can't affect the listing: it is inside something the walk skips.
 */
export function isIgnoredChange(dir: string, name: string): boolean {
  return name.split(/[\\/]/).some(isSkippedName) || isSkippedPath(dir, path.join(dir, name));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then files, each in natural ("file2" before "file10"), case-insensitive order. */
export function compareNames(
  aIsFolder: boolean,
  aName: string,
  bIsFolder: boolean,
  bName: string,
): number {
  if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
  // Names equal but for case or accents still get a stable order.
  return collator.compare(aName, bName) || (aName < bName ? -1 : aName > bName ? 1 : 0);
}

export function compareEntries(a: FolderEntry, b: FolderEntry): number {
  return compareNames(a.kind === 'folder', a.name, b.kind === 'folder', b.name);
}

/**
 * The Markdown files under `root` and the folders that lead to them, sorted.
 * Folders are read breadth-first, so when a limit cuts the walk short it is
 * the deepest levels that are missing. Throws if `root` itself can't be read;
 * an unreadable subfolder is just left out.
 */
export async function walkFolder(root: string, limits = WALK_LIMITS): Promise<FolderWalk> {
  const entries: FolderEntry[] = [];
  // `level` is how deep the folder's own entries sit (the root's are at 1).
  const queue: { dir: string; level: number; into: FolderEntry[] }[] = [
    { dir: root, level: 1, into: entries },
  ];
  const folders: string[] = [];
  const deadline = Date.now() + limits.maxMillis;
  let seen = 0;
  let truncated = false;

  walk: for (let i = 0; i < queue.length; i++) {
    const { dir, level, into } = queue[i]!;
    if (level > limits.maxDepth) {
      truncated = true;
      continue;
    }
    let dirents: Dirent[] | null;
    try {
      dirents = await beforeDeadline(fs.readdir(dir, { withFileTypes: true }), deadline);
    } catch (err) {
      if (i === 0) throw err;
      continue;
    }
    if (!dirents) {
      if (i === 0) throw new Error('Reading the folder took too long.');
      truncated = true;
      break;
    }
    folders.push(dir);
    for (const dirent of dirents) {
      if (++seen > limits.maxEntries) {
        truncated = true;
        break walk;
      }
      if (isSkippedName(dirent.name)) continue;
      const full = path.join(dir, dirent.name);
      const kind = await entryKind(dirent, full);
      if (kind === 'file' && isMarkdownPath(dirent.name)) {
        into.push({ kind: 'file', name: dirent.name, path: full });
      } else if (kind === 'folder' && !isSkippedPath(root, full)) {
        const folder: FolderEntry = { kind: 'folder', name: dirent.name, path: full, children: [] };
        into.push(folder);
        queue.push({ dir: full, level: level + 1, into: folder.children });
      }
    }
  }
  return { entries: prune(entries), truncated, folders };
}

/** `promise`'s value, or null if it hasn't settled by `deadline` (it is then left to finish unseen). */
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function entryKind(dirent: Dirent, full: string): Promise<'file' | 'folder' | null> {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'folder';
  const link = dirent.isSymbolicLink();
  // Only a link that could be listed is worth a stat. Links to folders aren't
  // followed, which also rules out cycles.
  if (link && !isMarkdownPath(dirent.name)) return null;
  // Besides links, entries of unknown type (some network filesystems) need a look.
  if (dirent.isFIFO() || dirent.isSocket() || dirent.isBlockDevice() || dirent.isCharacterDevice()) {
    return null;
  }
  try {
    const stat = await fs.stat(full);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory() && !link) return 'folder';
  } catch {
    // A dangling link, or gone already.
  }
  return null;
}

/** Drop folders with no Markdown file anywhere below them, and sort the rest. */
function prune(entries: FolderEntry[]): FolderEntry[] {
  const kept: FolderEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'folder') {
      entry.children = prune(entry.children);
      if (entry.children.length === 0) continue;
    }
    kept.push(entry);
  }
  return kept.sort(compareEntries);
}
