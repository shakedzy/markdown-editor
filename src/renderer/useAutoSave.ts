import { MutableRefObject, useCallback, useEffect, useRef } from 'react';
import { useLatest } from './useLatest';

// How long typing has to pause before the document is written.
const AUTO_SAVE_DELAY_MS = 1000;

export interface AutoSaveOptions {
  /** Auto-save is on and may write the document now. */
  active: boolean;
  buffer: string;
  savedContent: string;
  filePath: string | null;
  /** Bumped (synchronously) whenever another document takes the window's place. */
  docGen: MutableRefObject<number>;
  /** `content` was written to `path`, which is still this window's document. */
  onSaved: (path: string, content: string) => void;
  /** A write failed; `retry` tries again even while auto-save is paused. */
  onError: (err: unknown, retry: () => void) => void;
}

/**
 * While `active`, saves the document to its file a moment after typing stops
 * and as soon as the window loses focus. Returns a function that saves any
 * unsaved changes right away, e.g. before another file replaces the
 * document; it resolves whether the buffer now matches what was last saved.
 */
export function useAutoSave(options: AutoSaveOptions): () => Promise<boolean> {
  const latest = useLatest(options);
  const inFlight = useRef<{ content: string; done: Promise<boolean> } | null>(null);

  const save = useCallback(async (force: boolean): Promise<boolean> => {
    // Content and path come from the same render, so a document that is
    // being swapped out is never written into the incoming one's file.
    const { active, buffer, savedContent, filePath, docGen } = latest.current;
    if (buffer === savedContent) return true;
    if (!filePath || !(active || force)) return false;
    if (inFlight.current?.content === buffer) return inFlight.current.done;

    const gen = docGen.current;
    const done = window.api.saveFile({ path: filePath, content: buffer }).then(
      (result) => {
        // A result for a document the window no longer shows changes nothing,
        // nor does a save main refused over an outside edit (shown as a disk
        // conflict, which holds auto-save).
        if (gen !== docGen.current || result.conflict) return false;
        latest.current.onSaved(filePath, buffer);
        return true;
      },
      (err: unknown) => {
        if (gen === docGen.current) latest.current.onError(err, () => void save(true));
        return false;
      },
    );
    inFlight.current = { content: buffer, done };
    try {
      return await done;
    } finally {
      if (inFlight.current?.done === done) inFlight.current = null;
    }
  }, []);

  const { active, buffer, savedContent, filePath } = options;
  const pending = active && filePath !== null && buffer !== savedContent;
  useEffect(() => {
    if (!pending) return;
    const id = window.setTimeout(() => void save(false), AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [pending, buffer, filePath, save]);

  useEffect(() => {
    const onBlur = () => void save(false);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [save]);

  return useCallback(() => save(false), [save]);
}
