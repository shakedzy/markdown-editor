import { watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import { IpcChannels, FolderListing } from '../shared/types';
import { getDocumentPath } from './watcher';
import { isIgnoredChange, walkFolder } from './folderWalk';
import { pathKey } from './recentList';

// The folder each window's Files panel shows. The renderer never names a
// folder or a path to list: main lists the one the user picked in its dialog.

// Coalesces the burst of events a save, a checkout or a build produces.
const DEBOUNCE_MS = 300;
// Steady churn (a long build, a sync) still refreshes the panel this often.
const MAX_WAIT_MS = 2000;
// FSEvents (macOS) and ReadDirectoryChangesW (Windows) watch a whole tree
// natively. Elsewhere each folder read gets its own inotify watch, capped so
// a huge tree can't use up the system's supply.
const RECURSIVE_WATCH = process.platform === 'darwin' || process.platform === 'win32';
const MAX_FOLDER_WATCHES = 1000;

interface FolderState {
  /** The folder the panel shows; null when none is open. */
  root: string | null;
  /** By watched folder: the root's parent, and the root (recursively) or each folder read. */
  watchers: Map<string, FSWatcher>;
  timer: NodeJS.Timeout | null;
  /** When the pending relisting was first asked for. */
  waitingSince: number;
  /** Bumped per listing and when the root changes, so a superseded listing isn't used. */
  seq: number;
  /** The newest listing in progress or done; a superseded one resolves to it instead. */
  latest: Promise<FolderListing> | null;
  /** The listing the renderer last got, as JSON, so an unchanged one isn't sent again. */
  sent: string | null;
}

const states = new WeakMap<BrowserWindow, FolderState>();

function getState(win: BrowserWindow): FolderState {
  let state = states.get(win);
  if (!state) {
    const s: FolderState = {
      root: null,
      watchers: new Map(),
      timer: null,
      waitingSince: 0,
      seq: 0,
      latest: null,
      sent: null,
    };
    states.set(win, s);
    // Kept across a reload of the page, which asks for the listing again.
    win.once('closed', () => {
      stopWatching(s);
      states.delete(win);
    });
    state = s;
  }
  return state;
}

/** Ask the user for a folder to show in the Files panel of `win`; null if they cancel. */
export async function openFolder(win: BrowserWindow): Promise<FolderListing | null> {
  const state = getState(win);
  const doc = getDocumentPath(win);
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: state.root ?? (doc ? path.dirname(doc) : undefined),
  });
  const picked = result.filePaths[0];
  if (result.canceled || !picked || win.isDestroyed()) return null;
  stopWatching(state);
  state.root = path.resolve(picked);
  const listing = await list(win, state);
  state.sent = JSON.stringify(listing);
  return listing;
}

/** The folder open in `win`, listed afresh; null when none is. */
export async function listFolder(win: BrowserWindow): Promise<FolderListing | null> {
  const state = states.get(win);
  if (!state?.root) return null;
  const listing = await list(win, state);
  state.sent = JSON.stringify(listing);
  return listing;
}

export function closeFolder(win: BrowserWindow): void {
  const state = states.get(win);
  if (!state) return;
  stopWatching(state);
  state.root = null;
  state.sent = null;
}

function list(win: BrowserWindow, state: FolderState): Promise<FolderListing> {
  const listing = build(win, state, ++state.seq);
  state.latest = listing;
  return listing;
}

async function build(win: BrowserWindow, state: FolderState, seq: number): Promise<FolderListing> {
  const root = state.root!;
  const name = path.basename(root) || root;
  let listing: FolderListing;
  let folders: string[] | null = null;
  try {
    const walk = await walkFolder(root);
    listing = { root, name, entries: walk.entries, truncated: walk.truncated };
    folders = walk.folders;
  } catch (err) {
    listing = { root, name, entries: [], truncated: false, error: describeError(err) };
  }
  if (seq !== state.seq) return state.latest ?? listing;
  if (!win.isDestroyed()) watchFolders(win, state, root, folders);
  return listing;
}

function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'The folder no longer exists. It may have been moved, renamed or deleted.';
  }
  if (code === 'EACCES' || code === 'EPERM') return 'MDitor isn’t allowed to read this folder.';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Watch what the latest listing of `root` covers: the folders it read
 * (`folders`; null when the root couldn't be read), and the root itself from
 * its parent, which is where its removal or renaming is reported. Watches
 * of a root that went away are dropped, so a listing after it comes back
 * starts them afresh.
 */
function watchFolders(
  win: BrowserWindow,
  state: FolderState,
  root: string,
  folders: string[] | null,
): void {
  // By folder: the one entry name to watch it for, or null for all.
  const wanted = new Map<string, string | null>();
  const parent = path.dirname(root);
  if (parent !== root) wanted.set(parent, path.basename(root));
  if (folders && RECURSIVE_WATCH) wanted.set(root, null);
  else if (folders) for (const dir of folders.slice(0, MAX_FOLDER_WATCHES)) wanted.set(dir, null);

  for (const [dir, watcher] of state.watchers) {
    if (wanted.has(dir)) continue;
    watcher.close();
    state.watchers.delete(dir);
  }
  for (const [dir, only] of wanted) {
    if (!state.watchers.has(dir)) addWatcher(win, state, dir, only);
  }
}

function addWatcher(
  win: BrowserWindow,
  state: FolderState,
  dir: string,
  only: string | null,
): void {
  const recursive = RECURSIVE_WATCH && only === null;
  try {
    const watcher = watch(dir, { persistent: false, recursive }, (type, name) => {
      // Only entries appearing, vanishing or being renamed change the listing;
      // edits to a file's content ('change') don't.
      if (type !== 'rename') return;
      // Skipped folders (.git churns on every commit) are never listed, and
      // the root's parent matters only for the root.
      if (name && (only === null ? isIgnoredChange(dir, name) : pathKey(name) !== pathKey(only))) {
        return;
      }
      scheduleRelist(win, state);
    });
    watcher.on('error', () => {
      // Typically the folder was removed. Listing again reports that (or
      // drops the subfolder), and a later successful listing watches anew.
      watcher.close();
      if (state.watchers.get(dir) === watcher) state.watchers.delete(dir);
      scheduleRelist(win, state);
    });
    state.watchers.set(dir, watcher);
  } catch (err) {
    // The panel still works; it just needs its refresh button to catch up.
    console.warn('Cannot watch', dir, err);
  }
}

function stopWatching(state: FolderState): void {
  for (const watcher of state.watchers.values()) watcher.close();
  state.watchers.clear();
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  // A listing still in progress is for a folder no longer watched.
  state.seq++;
  state.latest = null;
}

function scheduleRelist(win: BrowserWindow, state: FolderState): void {
  const now = Date.now();
  if (!state.timer) state.waitingSince = now;
  else if (now - state.waitingSince >= MAX_WAIT_MS) return;
  else clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void relist(win, state);
  }, DEBOUNCE_MS);
}

async function relist(win: BrowserWindow, state: FolderState): Promise<void> {
  const root = state.root;
  if (!root || win.isDestroyed()) return;
  const listing = await list(win, state);
  if (state.root !== root || listing.root !== root || win.isDestroyed()) return;
  const json = JSON.stringify(listing);
  if (json === state.sent) return;
  state.sent = json;
  win.webContents.send(IpcChannels.FolderChanged, listing);
}
