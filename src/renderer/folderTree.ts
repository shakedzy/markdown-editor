import type { FolderEntry } from '../shared/types';

/** A line of the Files panel: an entry all of whose folders are expanded. */
export interface TreeRow {
  entry: FolderEntry;
  /** Nesting depth; the folder's own entries are at 1 (aria-level). */
  level: number;
  /** The folder the entry is in; null at the top. */
  parent: string | null;
  /** 1-based position among its siblings, and how many there are (aria-posinset, aria-setsize). */
  position: number;
  siblings: number;
}

/** The rows on screen, in order, given which folders (by path) are expanded. */
export function visibleRows(
  entries: readonly FolderEntry[],
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const add = (list: readonly FolderEntry[], level: number, parent: string | null) => {
    list.forEach((entry, i) => {
      rows.push({ entry, level, parent, position: i + 1, siblings: list.length });
      if (entry.kind === 'folder' && expanded.has(entry.path)) {
        add(entry.children, level + 1, entry.path);
      }
    });
  };
  add(entries, 1, null);
  return rows;
}

/**
 * The folders, outermost first, that contain the file whose key is `key`
 * (as `toKey` makes them, e.g. pathKey); null if the file isn't listed.
 */
export function foldersLeadingTo(
  entries: readonly FolderEntry[],
  key: string,
  toKey: (path: string) => string,
): string[] | null {
  for (const entry of entries) {
    const entryKey = toKey(entry.path);
    if (entry.kind === 'file') {
      if (entryKey === key) return [];
      continue;
    }
    // Only the folder whose path starts the file's can hold it.
    const sep = key[entryKey.length];
    if (!key.startsWith(entryKey) || (sep !== '/' && sep !== '\\')) continue;
    const inner = foldersLeadingTo(entry.children, key, toKey);
    if (inner) return [entry.path, ...inner];
  }
  return null;
}
