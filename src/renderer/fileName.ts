// Names of files and folders, for display. Paths may be Windows ones.

/** The last part of `path`: a file's or folder's name. */
export function fileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/** The document's name as the window shows it: its file's name, or "Untitled". */
export function displayName(path: string | null): string {
  return (path && fileName(path)) || 'Untitled';
}
