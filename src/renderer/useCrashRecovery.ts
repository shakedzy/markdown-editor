import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecoveredDocument } from '../shared/types';
import { useLatest } from './useLatest';

// How often, at most, main's copy of a dirty document is refreshed; large
// documents proportionally less often.
const SNAPSHOT_INTERVAL_MS = 2000;
const SNAPSHOT_CHARS_PER_INTERVAL = 1_000_000;

export interface RecoverableDocument {
  buffer: string;
  /** What the file held when the buffer was last loaded from or saved to it. */
  savedContent: string;
  filePath: string | null;
  dirty: boolean;
}

/**
 * Crash recovery for this window. On startup, hands `restore` whatever unsaved
 * work main kept for the window (from a crashed session, or from before the
 * page reloaded). Afterwards keeps main's copy current while the document is
 * dirty, and drops it once the document is clean.
 */
export function useCrashRecovery(
  doc: RecoverableDocument,
  restore: (recovered: RecoveredDocument) => void,
): void {
  const latest = useLatest(doc);
  const restoreRef = useLatest(restore);

  // Nothing is sent until main has answered: a reloaded page starts out clean
  // and would otherwise drop the copy it is about to restore.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.api
      .getRecovery()
      .then((recovered) => {
        if (!cancelled && recovered) restoreRef.current(recovered);
      })
      .catch((err) => console.warn('Could not check for unsaved work to recover:', err))
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const timer = useRef(0);
  const lastSent = useRef(0);
  // Main may still hold a copy from before a reload.
  const mainHasCopy = useRef(true);

  const send = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const { buffer, savedContent, filePath, dirty } = latest.current;
    lastSent.current = Date.now();
    mainHasCopy.current = dirty;
    window.api.saveRecovery(dirty ? { path: filePath, content: buffer, base: savedContent } : null);
  }, []);

  const { buffer, savedContent, filePath, dirty } = doc;
  useEffect(() => {
    if (!checked) return;
    if (!dirty) {
      window.clearTimeout(timer.current);
      timer.current = 0;
      if (mainHasCopy.current) send();
      return;
    }
    // Already scheduled: that snapshot will include this change.
    if (timer.current) return;
    const interval =
      SNAPSHOT_INTERVAL_MS * Math.max(1, buffer.length / SNAPSHOT_CHARS_PER_INTERVAL);
    // The first change after a save is kept right away: saves rewrite the
    // file in place, so one cut short by a crash must find a copy to restore.
    const wait = mainHasCopy.current ? lastSent.current + interval - Date.now() : 0;
    timer.current = window.setTimeout(send, Math.max(0, wait));
  }, [checked, dirty, buffer, savedContent, filePath, send]);

  useEffect(() => {
    // Don't wait out the interval when the user leaves the window or the page
    // goes away (a reload).
    const flush = () => {
      if (timer.current) send();
    };
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      window.clearTimeout(timer.current);
      timer.current = 0;
    };
  }, [send]);
}
