import { Dirent, promises as fs } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, shell, type Session } from 'electron';
import type {
  LinkDirEntry,
  LinkDirectoryArgs,
  LinkFileArgs,
  LinkFileResult,
} from '../shared/types';
import { isMarkdownPath } from '../shared/fileTypes';
import { getDocumentPath } from './watcher';
import { isImageName } from './assetNames';
import {
  compareLinkEntries,
  externalUrl,
  isAppUrl,
  linkDirectory,
  linkedPath,
  opensDirectly,
  reachesNetwork,
  windowsRoot,
} from './linkTargets';

// Link completion lists no more of a folder than this.
const MAX_LINK_ENTRIES = 1000;

/** Open a web or mail link in the browser or mail app; anything else is refused (false). */
export function openExternalLink(url: unknown): boolean {
  const href = externalUrl(url);
  if (href) void shell.openExternal(href);
  return href !== null;
}

/**
 * Open a link that would take `win` off the app's page (a new window, a
 * navigation) in the browser or mail app. One into the app itself (a
 * relative link resolves against the app's page) is no web page: refused.
 */
export function openLeavingLink(win: BrowserWindow, url: string): void {
  if (!isAppUrl(url, win.webContents.getURL())) openExternalLink(url);
}

/**
 * Keep `win` on the app's own page. The page is the whole app, so a link,
 * form or script that would load anything else is stopped; web and mail
 * links open in the browser and mail app instead. Reloading the page itself
 * still works: menu reloads don't come here, and location.reload() comes
 * with the page's exact URL.
 */
export function guardNavigation(win: BrowserWindow): void {
  const guard = (event: { url: string; preventDefault(): void }) => {
    if (event.url === win.webContents.getURL()) return;
    event.preventDefault();
    openLeavingLink(win, event.url);
  };
  win.webContents.on('will-navigate', guard);
  // The app has no frames of its own, but none may leave either. Blank
  // frames are harmless. The main frame is will-navigate's.
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith('about:')) guard(event);
  });
}

/**
 * Cancel every load of a file: URL on another computer in `session`. A page
 * on file: (packaged builds, the PDF export) turns "//host/x.png" in the
 * document, or in its CSS, into file://host/x.png, which the page's policy
 * allows as 'self'; Windows reads that from \\host and signs in to it.
 * Pages main loads itself, the app's own files, and the share the window's
 * document is on are left alone.
 */
export function guardFileRequests(session: Session): void {
  const appRoot = windowsRoot(app.getAppPath());
  session.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') return callback({});
    const win = details.webContents && BrowserWindow.fromWebContents(details.webContents);
    const docPath = win ? getDocumentPath(win) : null;
    const trusted = docPath ? [appRoot, windowsRoot(docPath)] : [appRoot];
    callback({ cancel: reachesNetwork(details.url, trusted) });
  });
}

/**
 * Follow a link in the window's document to a local file or folder (relative
 * to the document, or absolute). Documents and media open in their default
 * app; folders and anything else are shown in their folder. Throws when
 * there is nothing there, or the link is from a document the window no
 * longer shows (it would resolve against the wrong folder).
 */
export async function openLinkedFile(
  win: BrowserWindow,
  args: Partial<LinkFileArgs> | undefined,
): Promise<LinkFileResult> {
  const docPath = getDocumentPath(win);
  if (args?.documentPath !== docPath) throw new Error('The document has changed.');
  const filePath = linkedPath(docPath ? path.dirname(docPath) : null, args.target);
  if (!filePath) throw new Error('It isn’t a file the document can link to.');
  // What a symlink points to is what would open, so its type is what counts.
  let realPath: string;
  let isFile: boolean;
  try {
    realPath = await fs.realpath(filePath);
    isFile = (await fs.stat(realPath)).isFile();
  } catch {
    throw new Error('There’s no such file.');
  }
  if (isFile && opensDirectly(realPath)) {
    const error = await shell.openPath(realPath);
    if (error) throw new Error(error);
    return 'opened';
  }
  shell.showItemInFolder(filePath);
  return 'revealed';
}

/**
 * What link completion offers in a folder relative to the window's document:
 * its folders, Markdown files and images, sorted. Names only, never
 * contents; hidden entries are left out. Null for an untitled document, one
 * the window no longer shows, or a folder that isn't relative; [] when the
 * folder can't be read.
 */
export async function listLinkDirectory(
  win: BrowserWindow,
  args: Partial<LinkDirectoryArgs> | undefined,
): Promise<LinkDirEntry[] | null> {
  const docPath = getDocumentPath(win);
  if (!docPath || args?.documentPath !== docPath) return null;
  const folder = linkDirectory(path.dirname(docPath), args.dir);
  if (!folder) return null;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: LinkDirEntry[] = [];
  for (const dirent of dirents) {
    if (entries.length >= MAX_LINK_ENTRIES) break;
    if (dirent.name.startsWith('.')) continue;
    let isDir = dirent.isDirectory();
    let isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) {
      try {
        const stat = await fs.stat(path.join(folder, dirent.name));
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }
    if (isDir || (isFile && (isMarkdownPath(dirent.name) || isImageName(dirent.name)))) {
      entries.push({ name: dirent.name, isDir });
    }
  }
  return entries.sort(compareLinkEntries);
}
