import { watch, FSWatcher, promises as fs } from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { IpcChannels, DiskChange } from '../shared/types';
import { Eol, detectEol, fromLf, toLf } from './eol';
import { pathKey } from './recentList';

// Coalesces the burst of events one save produces (truncate + write, or
// write-temp + rename), and is the grace period before a missing file is
// reported as deleted.
const DEBOUNCE_MS = 150;
// A file written to non-stop (a tool streaming into it) is still re-read this often.
const MAX_WAIT_MS = 1000;

interface DocState {
  /** The file this window's document lives in, as main last read or wrote it. */
  path: string | null;
  /**
   * Raw text main last read from or wrote to `path`. A disk event whose
   * content matches it is our own save (or a no-op touch) and is ignored.
   * Null when main has none: the file is missing or couldn't be read.
   */
  known: string | null;
  eol: Eol;
  /** The renderer reported `path` as the file it shows, so watch it. */
  watching: boolean;
  /** 'deleted' was reported and the file hasn't come back since. */
  missing: boolean;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  /** When the pending check was first scheduled; later events push it back only so far. */
  waitingSince: number;
  /** Saves in flight; reads wait for them so a half-written save isn't taken for an outside edit. */
  writes: number;
  /** The last save queued; each save waits for the one before it. */
  lastWrite: Promise<void>;
  /** Bumped per disk check (and on retarget) so only the newest check reports. */
  checkSeq: number;
  /** Bumped whenever another file (or none) becomes the document, so a save finishing late can tell. */
  docSeq: number;
  /** Bumped whenever a save is refused over an outside edit, so saves queued before that are refused too. */
  conflictSeq: number;
}

/** A save refused because the file changed on disk since main last read or wrote it. */
export class SaveConflictError extends Error {
  constructor() {
    super('The file changed on disk.');
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class NotUtf8Error extends Error {
  constructor() {
    super('It isn’t UTF-8 text.');
  }
}

/**
 * The text in `filePath`. Anything but UTF-8 is refused rather than decoded
 * lossily, which a save would then write back. A BOM is kept as text, so it
 * is written back too.
 */
export async function readText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  try {
    return utf8.decode(data);
  } catch {
    throw new NotUtf8Error();
  }
}

const states = new WeakMap<BrowserWindow, DocState>();

function getState(win: BrowserWindow): DocState {
  let state = states.get(win);
  if (!state) {
    const s: DocState = {
      path: null,
      known: null,
      eol: '\n',
      watching: false,
      missing: false,
      watcher: null,
      timer: null,
      waitingSince: 0,
      writes: 0,
      lastWrite: Promise.resolve(),
      checkSeq: 0,
      docSeq: 0,
      conflictSeq: 0,
    };
    states.set(win, s);
    win.once('closed', () => {
      stopWatching(s);
      states.delete(win);
    });
    // A reload starts the renderer over with an untitled document.
    win.webContents.on('did-navigate', () => resetDocument(s));
    state = s;
  }
  return state;
}

function resetDocument(state: DocState): void {
  stopWatching(state);
  state.docSeq++;
  state.path = null;
  state.known = null;
  state.eol = '\n';
  state.watching = false;
  state.missing = false;
}

/** Make `filePath` the window's document; a different file isn't watched until the renderer reports it. */
function adopt(state: DocState, filePath: string): void {
  state.missing = false;
  if (state.path === filePath) return;
  stopWatching(state);
  state.docSeq++;
  state.watching = false;
  state.path = filePath;
}

/** The file the document in `win` lives in (null while untitled). */
export function getDocumentPath(win: BrowserWindow): string | null {
  return states.get(win)?.path ?? null;
}

/** The window whose document is `filePath` (compared as the filesystem compares names), if any. */
export function windowShowing(filePath: string): BrowserWindow | undefined {
  const key = pathKey(filePath);
  return BrowserWindow.getAllWindows().find((w) => {
    const doc = getDocumentPath(w);
    return doc !== null && pathKey(doc) === key;
  });
}

/**
 * Read `filePath` as the document `win` is about to show. Returns its text
 * with "\n" line endings; the file's own are restored by writeDocument.
 */
export async function readDocument(win: BrowserWindow, filePath: string): Promise<string> {
  const raw = await readText(filePath);
  if (!win.isDestroyed()) {
    const state = getState(win);
    adopt(state, filePath);
    state.known = raw;
    state.eol = detectEol(raw);
  }
  return toLf(raw);
}

/**
 * Make `filePath` the document of `win` although it can't be read (e.g. it
 * was deleted), so unsaved work on it can still be saved back there.
 */
export function adoptMissingDocument(win: BrowserWindow, filePath: string): void {
  if (win.isDestroyed()) return;
  const state = getState(win);
  adopt(state, filePath);
  state.known = null;
  // The window already treats it as gone; don't report it as deleted.
  state.missing = true;
}

/**
 * Make `filePath` the document of `win` although it is there but couldn't be
 * read (it isn't UTF-8 text any more, say). What it holds is unknown, so a
 * save checks it first and won't overwrite anything it can't read back.
 */
export function adoptUnreadableDocument(win: BrowserWindow, filePath: string): void {
  if (win.isDestroyed()) return;
  const state = getState(win);
  adopt(state, filePath);
  state.known = null;
}

/**
 * Save `text` to `filePath` as the document of `win`, keeping the document's
 * line endings. Unless `overwrite` (the user picked the file to replace), it
 * throws SaveConflictError instead of overwriting an outside edit to the
 * document that the watcher hasn't reported yet.
 */
export async function writeDocument(
  win: BrowserWindow,
  filePath: string,
  text: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<void> {
  const state = getState(win);
  const raw = fromLf(text, state.eol);
  const seq = state.docSeq;
  const conflicts = state.conflictSeq;
  // One write at a time: overlapping writes to a file (an auto-save and a
  // Save, say) can land in either order or leave a mix of both. Each checks
  // the disk in turn, against what the one before it wrote.
  const write = state.lastWrite.then(async () => {
    if (!overwrite) {
      // A save queued before an outside edit was reported holds text made
      // without it: the check below would now pass and undo that edit.
      if (filePath === state.path && state.conflictSeq !== conflicts) {
        throw new SaveConflictError();
      }
      await refuseOutsideChange(win, state, filePath, raw);
    }
    await fs.writeFile(filePath, raw, 'utf8');
  });
  state.lastWrite = write.catch(() => undefined);
  state.writes++;
  try {
    await write;
  } finally {
    state.writes--;
  }
  // Another file (or none) became the document meanwhile, and stays it.
  if (win.isDestroyed() || state.docSeq !== seq) return;
  adopt(state, filePath);
  state.known = raw;
  // The watcher dies with a removed directory; a save that recreates the file re-arms it.
  if (state.watching && !state.watcher) startWatching(win, state);
}

/**
 * Report the document's file as changed and throw SaveConflictError if it no
 * longer holds what main last read or wrote: an outside edit landed too
 * recently for the watcher to have reported it, and saving would undo it.
 */
async function refuseOutsideChange(
  win: BrowserWindow,
  state: DocState,
  filePath: string,
  raw: string,
): Promise<void> {
  const { known, docSeq } = state;
  if (filePath !== state.path || state.missing) return;
  let disk: string;
  try {
    disk = await readText(filePath);
  } catch (err) {
    if (err instanceof NotUtf8Error) throw new Error('The file on disk isn’t UTF-8 text any more.');
    // Gone or unreadable: the write recreates it, or fails and says why.
    return;
  }
  if (disk === known || disk === raw) return;
  // Reported only if the file is still the document; refused either way.
  if (state.docSeq === docSeq) {
    state.known = disk;
    state.eol = detectEol(disk);
    state.conflictSeq++;
    send(win, { kind: 'changed', path: filePath, content: toLf(disk) });
  }
  throw new SaveConflictError();
}

/**
 * The renderer reports the file it now shows (null: untitled). Only the file
 * main itself last opened or saved for this window is accepted, so a
 * renderer can't use this to read arbitrary files.
 */
export function watchDocument(win: BrowserWindow, filePath: string | null): void {
  const state = getState(win);
  if (filePath === null) {
    resetDocument(state);
    return;
  }
  if (filePath !== state.path) {
    console.warn('Ignoring watch request for a file this window did not open:', filePath);
    return;
  }
  if (state.watching && state.watcher) return;
  state.watching = true;
  startWatching(win, state);
  // Catch anything that changed between reading the file and watching it.
  scheduleCheck(win, state);
}

function startWatching(win: BrowserWindow, state: DocState): void {
  stopWatching(state);
  const filePath = state.path;
  if (!filePath) return;
  const dir = path.dirname(filePath);
  // Event names may differ from the opened path in case or in Unicode
  // normalization, as pathKey allows for.
  const fileName = pathKey(path.basename(filePath));
  const dirName = pathKey(path.basename(dir));
  try {
    // Watch the directory, not the file: editors and git save atomically by
    // renaming a new file over the old one, which strands a file watcher on
    // the replaced inode.
    const watcher = watch(dir, { persistent: false }, (_type, name) => {
      if (name) {
        // The directory itself being removed or moved is reported under its
        // own name (Linux) or full path (macOS).
        const key = pathKey(path.basename(name));
        if (key !== fileName && key !== dirName) return;
      }
      scheduleCheck(win, state);
    });
    watcher.on('error', () => {
      // Typically the directory was removed (EPERM on Windows). Look once
      // more so the deletion is reported.
      watcher.close();
      if (state.watcher === watcher) state.watcher = null;
      scheduleCheck(win, state);
    });
    state.watcher = watcher;
  } catch (err) {
    // Missing directory, no permission or an unwatchable filesystem: the
    // document still works, it just won't pick up outside changes.
    console.warn('Cannot watch', dir, err);
  }
}

function stopWatching(state: DocState): void {
  state.watcher?.close();
  state.watcher = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.checkSeq++;
}

function scheduleCheck(win: BrowserWindow, state: DocState, confirmMissing = false): void {
  const now = Date.now();
  if (!state.timer) state.waitingSince = now;
  // Waited long enough: let the pending check run.
  else if (now - state.waitingSince >= MAX_WAIT_MS) return;
  else clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void checkDisk(win, state, confirmMissing);
  }, DEBOUNCE_MS);
}

async function checkDisk(
  win: BrowserWindow,
  state: DocState,
  confirmMissing: boolean,
): Promise<void> {
  const filePath = state.path;
  if (!filePath || !state.watching || win.isDestroyed()) return;
  // Our own save is mid-write; look again once it has landed.
  if (state.writes > 0) return scheduleCheck(win, state);

  const seq = ++state.checkSeq;
  let raw: string | null;
  try {
    raw = await readText(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Other errors (e.g. EBUSY while another program holds the file on
    // Windows) are transient; the event that ends them triggers a retry.
    // Text that isn't UTF-8 isn't loaded at all: it would be garbled, then
    // saved that way.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return;
    raw = null;
  }
  if (seq !== state.checkSeq || state.path !== filePath || win.isDestroyed()) return;
  if (state.writes > 0) return scheduleCheck(win, state);

  if (raw === null) {
    if (state.missing) return;
    // Atomic saves remove the file for a moment; report it only if it stays gone.
    if (!confirmMissing) return scheduleCheck(win, state, true);
    state.missing = true;
    send(win, { kind: 'deleted', path: filePath });
    return;
  }
  // A file that comes back is reported even if its content is unchanged, so
  // the renderer can drop its "deleted" state.
  if (raw === state.known && !state.missing) return;
  state.missing = false;
  state.known = raw;
  state.eol = detectEol(raw);
  send(win, { kind: 'changed', path: filePath, content: toLf(raw) });
}

function send(win: BrowserWindow, change: DiskChange): void {
  if (!win.isDestroyed()) win.webContents.send(IpcChannels.FileChanged, change);
}
