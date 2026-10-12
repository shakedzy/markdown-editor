// Path identity, shared so main and the renderer agree on when two paths
// name the same file.

/** Whether the default filesystems on `platform` (a process.platform value) ignore case. */
export function caseInsensitiveFs(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * Identity of a path: default macOS and Windows filesystems ignore case, and
 * macOS may hand back a different Unicode normalization of the same name.
 */
export function pathKey(p: string, caseInsensitive: boolean): string {
  const nfc = p.normalize('NFC');
  return caseInsensitive ? nfc.toLowerCase() : nfc;
}
