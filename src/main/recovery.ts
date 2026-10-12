import { promises as fs, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog } from 'electron';
import { RecoveredDocument, RecoverySnapshot } from '../shared/types';
import {
  adoptMissingDocument,
  adoptUnreadableDocument,
  getDocumentPath,
  readDocument,
} from './watcher';

// Crash recovery. While a window's document has unsaved changes its renderer
// sends snapshots, and the latest one is kept in <userData>/recovery/<key>.json.
// A window that closes normally (changes saved or deliberately discarded)
// removes its file, so a file still there at startup was left by a session
// that crashed or was killed. The app is single-instance, so no running
// window owns it.

interface Entry {
  file: string;
  snapshot: RecoverySnapshot | null;
  /** `snapshot` came from a crashed session and the window hasn't sent one of its own yet. */
  afterCrash: boolean;
  /** A write of the latest snapshot is queued and hasn't started. */
  queued: boolean;
  writing: Promise<void>;
  closed: boolean;
  /** Closing leaves the file for the next launch to offer (the window's page crashed). */
  keep: boolean;
}

/** A snapshot a previous session left behind. */
export interface Orphan {
  file: string;
  snapshot: RecoverySnapshot;
}

const MAX_LISTED = 8;

const entries = new WeakMap<BrowserWindow, Entry>();

function recoveryDir(): string {
  return path.join(app.getPath('userData'), 'recovery');
}

function entryFor(win: BrowserWindow, file?: string): Entry {
  let entry = entries.get(win);
  if (!entry) {
    const e: Entry = {
      file: file ?? path.join(recoveryDir(), `${randomUUID()}.json`),
      snapshot: null,
      afterCrash: false,
      queued: false,
      writing: Promise.resolve(),
      closed: false,
      keep: false,
    };
    entries.set(win, e);
    // A window only closes once its changes are saved or the user chose not
    // to keep them. Removed synchronously because the app may be quitting.
    win.once('closed', () => {
      e.closed = true;
      if (e.keep) return;
      try {
        rmSync(e.file, { force: true });
      } catch (err) {
        console.warn('Could not remove the recovery copy of a closed window:', err);
      }
    });
    entry = e;
  }
  return entry;
}

/**
 * `win` is closing although its page crashed with unsaved changes it can no
 * longer save: keep their copy, which the next launch offers to restore.
 */
export function keepRecoveryOnClose(win: BrowserWindow): void {
  const entry = entries.get(win);
  if (entry) entry.keep = true;
}

/** Whether unsaved work of `win` is kept, for its page to get back after a reload. */
export function hasRecoveryCopy(win: BrowserWindow): boolean {
  return Boolean(entries.get(win)?.snapshot);
}

/** A snapshot as read from disk or sent by a renderer, or null if it isn't one. */
export function parseSnapshot(value: unknown): RecoverySnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const { path: filePath, content, base } = value as Record<string, unknown>;
  if (typeof content !== 'string') return null;
  if (filePath !== null && (typeof filePath !== 'string' || !path.isAbsolute(filePath))) {
    return null;
  }
  return typeof base === 'string' ? { path: filePath, content, base } : { path: filePath, content };
}

/** Keep the unsaved state of the document in `win` (null: it has none any more). */
export function recordSnapshot(win: BrowserWindow, snapshot: RecoverySnapshot | null): void {
  const entry = snapshot ? entryFor(win) : entries.get(win);
  if (!entry || entry.closed) return;
  entry.afterCrash = false;
  // The page is back (reloaded) and looks after its unsaved work again.
  entry.keep = false;
  if (!snapshot && !entry.snapshot) return;
  entry.snapshot = snapshot && {
    // Only the file main itself opened or saved for this window is restored
    // into it later, never one a renderer names.
    path: snapshot.path !== null && snapshot.path === getDocumentPath(win) ? snapshot.path : null,
    content: snapshot.content,
    base: snapshot.base,
  };
  persist(entry);
}

function persist(entry: Entry): void {
  // Snapshots arriving while one is written collapse into one more write.
  if (entry.queued) return;
  entry.queued = true;
  entry.writing = entry.writing
    .then(async () => {
      entry.queued = false;
      if (entry.closed) return;
      const { snapshot } = entry;
      if (!snapshot) return fs.rm(entry.file, { force: true });
      // Written aside and renamed over the old copy, so a crash mid-write
      // leaves the previous snapshot intact.
      const tmp = `${entry.file}.tmp`;
      await fs.mkdir(path.dirname(entry.file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      // Renamed synchronously so it can't land after the window closed and
      // removed its copy.
      if (entry.closed) return fs.rm(tmp, { force: true });
      renameSync(tmp, entry.file);
    })
    .catch((err) => console.warn('Could not update the recovery copy of unsaved changes:', err));
}

/**
 * The unsaved work a window that just loaded should show: what a crashed
 * session left for it, or what it held before its page reloaded. A file-backed
 * document's file becomes the window's document again so it can be saved.
 */
export async function recoveredDocument(win: BrowserWindow): Promise<RecoveredDocument | null> {
  const entry = entries.get(win);
  const snapshot = entry?.snapshot;
  if (!entry || !snapshot) return null;
  // Never into a window that has since opened a file.
  const current = getDocumentPath(win);
  if (current !== null && current !== snapshot.path) return null;
  let diskContent: string | null = null;
  let diskUnreadable: string | undefined;
  if (snapshot.path !== null) {
    try {
      diskContent = await readDocument(win, snapshot.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        adoptMissingDocument(win, snapshot.path);
      } else {
        // There but unreadable (rewritten in another encoding, say): a save
        // must not overwrite what nobody has seen, and the page says why.
        adoptUnreadableDocument(win, snapshot.path);
        diskUnreadable = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { ...snapshot, diskContent, diskUnreadable, afterCrash: entry.afterCrash };
}

async function findOrphans(): Promise<Orphan[]> {
  const dir = recoveryDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Cannot read the recovery folder:', err);
    }
    return [];
  }
  const orphans: Orphan[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    // A .tmp is a write cut short; the snapshot it was replacing is intact.
    if (name.endsWith('.json.tmp')) await fs.rm(file, { force: true }).catch(() => undefined);
    if (!name.endsWith('.json')) continue;
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      // Likely passing (EBUSY while a virus scanner has it, EMFILE...): it
      // may hold the only copy of someone's work, so the next launch retries.
      console.warn('Cannot read recovery file now; keeping it:', file, err);
      continue;
    }
    try {
      const snapshot = parseSnapshot(JSON.parse(text));
      if (snapshot) {
        orphans.push({ file, snapshot });
        continue;
      }
    } catch (err) {
      console.warn('Discarding unreadable recovery file:', file, err);
    }
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
  return orphans;
}

/**
 * Call at startup before opening any window: offers to restore what a session
 * that didn't close properly left unsaved. Returns the snapshots to restore
 * (pass each to restoreInto with a new window); declined ones are deleted.
 */
export async function offerRecovery(): Promise<Orphan[]> {
  const orphans = await findOrphans();
  if (orphans.length === 0) return [];
  const n = orphans.length;
  const names = orphans.map(({ snapshot }) =>
    snapshot.path === null ? 'Untitled' : path.basename(snapshot.path),
  );
  if (n > MAX_LISTED) names.splice(MAX_LISTED, n, `and ${n - MAX_LISTED} more`);
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Restore', 'Discard'],
    defaultId: 0,
    // Escape keeps the work.
    cancelId: 0,
    message: `MDitor didn’t close properly. Restore ${n} unsaved document${n === 1 ? '' : 's'}?`,
    detail: names.join('\n'),
  });
  if (response === 0) return orphans;
  await Promise.all(orphans.map(({ file }) => fs.rm(file, { force: true }).catch(() => undefined)));
  return [];
}

/**
 * Give `orphan` to the new window `win`: its page picks it up through
 * recoveredDocument, and the file now belongs to the window (removed once the
 * window has no unsaved changes or closes).
 */
export function restoreInto(win: BrowserWindow, orphan: Orphan): void {
  const entry = entryFor(win, orphan.file);
  entry.snapshot = orphan.snapshot;
  entry.afterCrash = true;
}
