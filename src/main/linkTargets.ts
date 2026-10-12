import path from 'node:path';
import type { LinkDirEntry } from '../shared/types';
import { compareNames } from './folderWalk';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * `url` normalized, if it is a web page or e-mail address for the browser or
 * mail app; null for anything else (file:, other apps' schemes, junk), which
 * the document must never get the OS to open.
 */
export function externalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Whether `url` is on the site of the app's page `appUrl` (any file: when
 * packaged, the dev server in development), where a relative link resolved
 * against the page lands.
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(appUrl);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

// Files a link may open in their default app: documents and media. Anything
// else (programs and scripts above all, but also unknown types) is only shown
// in its folder, so clicking a link can't run something.
const OPENS_DIRECTLY = new Set([
  // Images
  'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg',
  'tif', 'tiff', 'webp',
  // Audio and video
  'aac', 'avi', 'flac', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'oga', 'ogg', 'ogv',
  'opus', 'wav', 'webm',
  // Documents and data
  'csv', 'doc', 'docx', 'epub', 'htm', 'html', 'json', 'key', 'log', 'numbers', 'odp',
  'ods', 'odt', 'pages', 'pdf', 'ppt', 'pptx', 'rtf', 'toml', 'tsv', 'txt', 'xls', 'xlsx',
  'xml', 'yaml', 'yml',
]);

/** Whether a linked file named `name` opens in its default app rather than only being shown in its folder. */
export function opensDirectly(name: string): boolean {
  return OPENS_DIRECTLY.has(path.extname(name).slice(1).toLowerCase());
}

/**
 * Where a link's local `target` (relative to the document's folder `docDir`,
 * or absolute) is; null if it can't be a path, is relative with no document
 * folder (untitled) to resolve it against, or is on another computer.
 */
export function linkedPath(
  docDir: string | null,
  target: unknown,
  pathModule: path.PlatformPath = path,
): string | null {
  if (typeof target !== 'string' || !target || target.length > 4096 || target.includes('\0')) {
    return null;
  }
  const windows = pathModule.sep === '\\';
  // "C:file" is relative to the drive's current folder, which isn't the document's.
  if (/^[a-z]:(?![\\/])/i.test(target) && windows) return null;
  // On Windows "\file" is on the document's drive.
  let resolved: string;
  if (docDir !== null) resolved = pathModule.resolve(docDir, target);
  else if (pathModule.isAbsolute(target)) resolved = pathModule.resolve(target);
  else return null;
  // Touching a network path (\\host\share, or a \\?\ or \\.\ device path) has
  // Windows connect to that host and sign in to it. Only the document's own
  // share is trusted.
  if (windows && resolved.startsWith('\\\\')) {
    if (docDir === null || windowsRoot(resolved) !== windowsRoot(docDir)) return null;
  }
  return resolved;
}

/**
 * The root a Windows path is under, lower-cased: its drive (c:\) or share
 * (\\server\share\). A device path counts as the path it stands for, so
 * \\?\UNC\server\share\… (or \\.\UNC\…) is on \\server\share\, not on "\\?\UNC\"
 * along with every other server.
 */
export function windowsRoot(p: string): string {
  const plain = p.replace(/^[\\/]{2}[?.][\\/]unc(?=[\\/])/i, '\\').replace(/\//g, '\\');
  // A trailing separator gives a share named without one (the folder of a
  // document right at the share, \\server\share) the root its files have.
  return path.win32.parse(plain + '\\').root.toLowerCase();
}

/**
 * Whether loading the file: URL `url` reaches another computer, other than
 * one of the `trusted` shares (as windowsRoot gives them). Windows opens
 * file://host/… as \\host\… and signs in to that host with the user's
 * credentials. A file: URL whose path is itself a network or device path
 * (file:////host/…, file:///%5C%5Chost…) is never one a page needs. On
 * other systems any host counts: such a URL names nothing on this computer.
 */
export function reachesNetwork(
  url: string,
  trusted: readonly string[] = [],
  pathModule: path.PlatformPath = path,
): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return true;
  }
  if (target.protocol !== 'file:') return false;
  let filePath = target.pathname;
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // A literal "%" isn't an escape.
  }
  const windows = pathModule.sep === '\\';
  const host = target.hostname.toLowerCase();
  if (host === '' || host === 'localhost') return windows && /^[\\/]{2}/.test(filePath);
  return !windows || !trusted.includes(windowsRoot(`\\\\${host}${filePath}`));
}

/**
 * The folder a link being typed names (`dir`, e.g. "", "images/", "../"),
 * relative to the document's folder `docDir`; null when `dir` isn't a
 * relative path. Completion only ever lists folders next to the document.
 */
export function linkDirectory(
  docDir: string,
  dir: unknown,
  pathModule: path.PlatformPath = path,
): string | null {
  if (typeof dir !== 'string' || dir.length > 4096 || dir.includes('\0')) return null;
  if (pathModule.isAbsolute(dir) || /^[a-z]:/i.test(dir)) return null;
  return pathModule.resolve(docDir, dir);
}

/** Folders first, then files, sorted as the Files panel sorts them. */
export function compareLinkEntries(a: LinkDirEntry, b: LinkDirEntry): number {
  return compareNames(a.isDir, a.name, b.isDir, b.name);
}
