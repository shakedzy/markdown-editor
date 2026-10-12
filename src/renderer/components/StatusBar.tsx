import {
  forwardRef,
  ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SelectionInfo } from './Editor';
import { TextStats, counted, formatCount, readingTime, textStats } from '../markdown/stats';
import { findFrontMatter } from '../markdown/frontmatter';
import { formatZoom, sameZoom } from '../zoom';
import { shortcut } from '../platform';

export interface StatusBarHandle {
  /** Show the editor's latest cursor position and selection. */
  setSelection(info: SelectionInfo): void;
}

interface Props {
  /** The whole document. */
  doc: string;
  zoomFactor: number;
  onResetZoom: () => void;
  /** Extra indicators (e.g. lint counts), shown on the right before the zoom level. */
  children?: ReactNode;
}

const FLASH_MS = 2000;
// Texts up to this size are counted while rendering; larger ones once edits
// pause, so typing in a huge document doesn't rescan it on every keystroke.
const SYNC_STATS_LIMIT = 20_000;
const DEFERRED_STATS_MS = 250;

const NO_SELECTION: SelectionInfo = { line: 1, col: 1, text: '', from: 0 };

let showFlash: ((message: string) => void) | null = null;

/** Briefly show `message` in the status bar, e.g. "Copied as rich text". */
export function flashStatus(message: string): void {
  showFlash?.(message);
}

function useTextStats(text: string, frontMatter: boolean, bodyFrom = 0): TextStats | null {
  const sync = text.length <= SYNC_STATS_LIMIT;
  const immediate = useMemo(
    () => (sync ? textStats(text, { frontMatter, bodyFrom }) : null),
    [sync, text, frontMatter, bodyFrom],
  );
  const [deferred, setDeferred] = useState<{
    text: string;
    frontMatter: boolean;
    bodyFrom: number;
    stats: TextStats;
  } | null>(null);

  useEffect(() => {
    if (sync) return;
    const id = window.setTimeout(() => {
      const stats = textStats(text, { frontMatter, bodyFrom });
      setDeferred({ text, frontMatter, bodyFrom, stats });
    }, DEFERRED_STATS_MS);
    return () => window.clearTimeout(id);
  }, [sync, text, frontMatter, bodyFrom]);

  if (immediate) return immediate;
  return deferred &&
    deferred.text === text &&
    deferred.frontMatter === frontMatter &&
    deferred.bodyFrom === bodyFrom
    ? deferred.stats
    : null;
}

const StatusBar = forwardRef<StatusBarHandle, Props>(function StatusBar(
  { doc, zoomFactor, onResetZoom, children },
  ref,
) {
  const [selection, setSelection] = useState<SelectionInfo>(NO_SELECTION);
  const [flash, setFlash] = useState<{ message: string; id: number } | null>(null);
  const flashTimerRef = useRef(0);

  useImperativeHandle(ref, () => ({
    setSelection(info) {
      setSelection((prev) =>
        prev.line === info.line &&
        prev.col === info.col &&
        prev.from === info.from &&
        prev.text === info.text
          ? prev
          : info,
      );
    },
  }));

  const flashMessage = useCallback((message: string) => {
    window.clearTimeout(flashTimerRef.current);
    // A new id restarts the fade-in even when the message repeats.
    setFlash((prev) => ({ message, id: (prev?.id ?? 0) + 1 }));
    flashTimerRef.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  useEffect(() => {
    showFlash = flashMessage;
    return () => {
      if (showFlash === flashMessage) showFlash = null;
      window.clearTimeout(flashTimerRef.current);
    };
  }, [flashMessage]);

  // While a large document is being recounted, keep showing the last counts
  // rather than blanking them on every keystroke.
  const liveDocStats = useTextStats(doc, true);
  const lastDocStatsRef = useRef(liveDocStats);
  if (liveDocStats) lastDocStatsRef.current = liveDocStats;
  const docStats = liveDocStats ?? lastDocStatsRef.current;
  // The document's words leave out its front matter, so a selection's leave
  // out the part of it they cover.
  const frontMatterEnd = useMemo(
    () => (selection.text ? (findFrontMatter(doc)?.end ?? 0) : 0),
    [doc, selection.text],
  );
  const selectionStats = useTextStats(
    selection.text,
    false,
    Math.max(0, frontMatterEnd - selection.from),
  );

  let stats = '';
  if (docStats && selection.text) {
    const words = selectionStats ? formatCount(selectionStats.words) : '…';
    const chars = selectionStats ? formatCount(selectionStats.characters) : '…';
    stats =
      `${words} of ${counted(docStats.words, 'word')} · ` +
      `${chars} of ${counted(docStats.characters, 'character')}`;
  } else if (docStats) {
    const reading = readingTime(docStats.words);
    stats = [
      counted(docStats.words, 'word'),
      counted(docStats.characters, 'character'),
      ...(reading ? [reading] : []),
    ].join(' · ');
  }

  return (
    <footer className="status-bar">
      <span className="status-bar-item">
        Ln {selection.line}, Col {selection.col}
      </span>
      <span
        className="status-bar-item status-bar-stats"
        title="The word count is an estimate that skips front matter, code blocks, link targets and markup. Characters exclude line breaks."
      >
        {stats}
      </span>
      <span className="status-bar-flash" role="status">
        {flash && (
          <span key={flash.id} className="status-bar-flash-message">
            {flash.message}
          </span>
        )}
      </span>
      {children}
      {!sameZoom(zoomFactor, 1) && (
        <button
          type="button"
          className="status-bar-zoom"
          onClick={onResetZoom}
          title={`Zoom ${formatZoom(zoomFactor)}. Click to reset to 100% (${shortcut('Mod+0')})`}
        >
          {formatZoom(zoomFactor)}
        </button>
      )}
    </footer>
  );
});

export default StatusBar;
