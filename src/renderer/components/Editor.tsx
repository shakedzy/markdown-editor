import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EditorState, countColumn } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import {
  buildExtensions,
  reconfigureHighlight,
  resetHistory,
  setEditorReadOnly,
} from '../editor/extensions';
import { wrapBold, wrapItalic, wrapStrike, wrapUnderline } from '../editor/shortcuts';
import { formatTable, insertTable } from '../editor/tables';
import {
  CONTEXT_CHARS,
  MIN_MATCH_LEN,
  locatePoint,
  normalizeForMatch,
  normalizeWithOffsets,
  offsetOfPoint,
} from '../markdown/locate';
import { flashExtension, flashRange } from '../editor/flash';
import { findTaskMarkers } from '../markdown/tasks';
import { minimalChange } from '../editor/minimalChange';
import { FileInserter, fileInsertion } from '../editor/imagePaste';
import { VimCommand, setVimKeybindings, vimKeybindings } from '../editor/vim';
import { focusDimming, setFocusDimming } from '../editor/focusMode';
import { setTypewriterScrolling, typewriterScrolling } from '../editor/typewriter';
import {
  LintCounts,
  lintCounts,
  lintCountsChanged,
  markdownLint,
  setMarkdownLint,
  toggleLintPanel,
} from '../editor/lint';
import { LinkFollower, linkFollowing } from '../editor/linkFollow';
import { DirectoryLister, linkCompletion } from '../editor/linkComplete';
import { useLatest } from '../useLatest';

export interface EditorHandle {
  focus(): void;
  /**
   * Show `text` as a different document: cursor and scroll position at the
   * top, and an undo history of its own, so undo can't bring back the text
   * of the document it replaced.
   */
  replaceDocument(text: string): void;
  /**
   * Bring the document to `text` (e.g. the file changed on disk) with one
   * undoable edit covering only the span that differs, so the cursor,
   * selection and scroll position survive.
   */
  applyExternalContent(text: string): void;
  /** Refuse the user's edits (e.g. while another document is on its way), or take them again. */
  setReadOnly(readOnly: boolean): void;
  getContent(): string;
  /** Undo the last change to the document, from the editor's own history. */
  undo(): void;
  /** Redo the last undone change. */
  redo(): void;
  format(action: 'bold' | 'italic' | 'underline' | 'strike'): void;
  /**
   * Insert an empty table below the cursor's line, with the cursor in its
   * first cell; false when it can't go there (inside a fence that's never
   * closed) or editing is refused.
   */
  insertTable(): boolean;
  /** Lay out the table at the cursor; false when the cursor isn't in one. */
  formatTable(): boolean;
  scrollToLine(line: number): void;
  /**
   * The source at a point on screen: its line, that line's text, and the
   * text just before and after the position there.
   */
  contextAtCoords(x: number, y: number): { line: number; text: string; before: string; after: string };
  /**
   * Put the cursor on the spot a click in the preview pointed at: the place
   * between `before` and `after` nearest `nearLine`. Failing that, select the
   * line matching `snippet`, or else `fallbackLine`.
   */
  revealSource(opts: {
    before: string;
    after: string;
    snippet: string;
    nearLine: number;
    fallbackLine: number;
  }): void;
  /**
   * Check or uncheck the `index`-th task-list item. `total` is how many task
   * checkboxes the preview shows; if the source disagrees, nothing changes and
   * false is returned rather than risk toggling the wrong item.
   */
  setTaskChecked(index: number, total: number, checked: boolean): boolean;
  /**
   * Where line `line` starts, in px from the top of the editor's scrolled
   * content (the scale of `view().scrollDOM.scrollTop`).
   */
  lineTop(line: number): number;
  /** Show the list of lint warnings below the editor, or hide it again (unless `open`). */
  toggleLintPanel(open?: boolean): void;
  view(): EditorView | null;
}

export interface SelectionInfo {
  /** 1-based line of the main cursor. */
  line: number;
  /** 1-based column of the main cursor, with tabs expanded. */
  col: number;
  /** The text of every non-empty selection range, newline-joined; '' if none. */
  text: string;
  /** Where the selected text starts in the document. */
  from: number;
}

function selectionInfo(state: EditorState): SelectionInfo {
  const { main, ranges } = state.selection;
  const line = state.doc.lineAt(main.head);
  const selected = ranges.filter((r) => !r.empty);
  return {
    line: line.number,
    col: countColumn(state.sliceDoc(line.from, main.head), state.tabSize) + 1,
    text: selected.map((r) => state.sliceDoc(r.from, r.to)).join('\n'),
    from: selected[0]?.from ?? main.head,
  };
}

interface Props {
  initialDoc: string;
  onChange: (doc: string) => void;
  /** The cursor or selection changed; called at most once per animation frame. */
  onSelectionChange?: (info: SelectionInfo) => void;
  /** Files pasted (images) or dropped into the editor; resolves the Markdown to insert. */
  onInsertFiles?: FileInserter;
  /** Vim keybindings; switching this reconfigures the running editor. */
  vimMode?: boolean;
  /** A Vim file command (:w, :q, :wq, :x, :q!) was typed. */
  onVimCommand?: (command: VimCommand) => void;
  /** Dim every paragraph but the caret's (focus mode); switching this reconfigures the running editor. */
  focusMode?: boolean;
  /** Keep the caret line vertically centered; switching this reconfigures the running editor. */
  typewriterMode?: boolean;
  /** Markdown lint warnings; switching this reconfigures the running editor. */
  lintEnabled?: boolean;
  /** The document's file, which lint checks relative links against; null while untitled. */
  documentPath?: string | null;
  /** The number of lint warnings shown changed. */
  onLintChange?: (counts: LintCounts) => void;
  /** A link was Cmd/Ctrl-clicked; gets its destination. */
  onFollowLink?: LinkFollower;
  /** Lists folders next to the document for link completion; none for an untitled document. */
  listLinkDirectory?: DirectoryLister;
  /** An edit or command scrolled the cursor into view (typing, undo, paste, Insert Table...). */
  onScrollIntoView?: () => void;
}

const Editor = forwardRef<EditorHandle, Props>(function Editor(
  {
    initialDoc,
    onChange,
    onSelectionChange,
    onInsertFiles,
    vimMode = false,
    onVimCommand,
    focusMode = false,
    typewriterMode = false,
    lintEnabled = false,
    documentPath = null,
    onLintChange,
    onFollowLink,
    listLinkDirectory,
    onScrollIntoView,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useLatest(onChange);
  const onSelectionChangeRef = useLatest(onSelectionChange);
  const onInsertFilesRef = useLatest(onInsertFiles);
  const onVimCommandRef = useLatest(onVimCommand);
  const onLintChangeRef = useLatest(onLintChange);
  const onFollowLinkRef = useLatest(onFollowLink);
  const listLinkDirectoryRef = useLatest(listLinkDirectory);
  const onScrollIntoViewRef = useLatest(onScrollIntoView);

  useEffect(() => {
    if (!hostRef.current) return;

    // Holding an arrow key or drag-selecting fires many updates per frame;
    // report the selection once per frame.
    let selectionFrame = 0;
    const reportSelection = () => {
      selectionFrame = 0;
      const v = viewRef.current;
      if (v) onSelectionChangeRef.current?.(selectionInfo(v.state));
    };
    const scheduleSelectionReport = () => {
      if (!selectionFrame) selectionFrame = requestAnimationFrame(reportSelection);
    };

    const startState = EditorState.create({
      doc: initialDoc,
      extensions: [
        // First: Vim must see keys before every other binding.
        vimKeybindings(vimMode, (command) => onVimCommandRef.current?.(command)),
        ...buildExtensions(),
        flashExtension,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) scheduleSelectionReport();
          if (lintCountsChanged(update)) onLintChangeRef.current?.(lintCounts(update.state));
          if (update.transactions.some((tr) => tr.scrollIntoView)) onScrollIntoViewRef.current?.();
        }),
        fileInsertion(() => onInsertFilesRef.current),
        focusDimming(focusMode),
        typewriterScrolling(typewriterMode),
        markdownLint(lintEnabled, documentPath),
        linkFollowing(() => onFollowLinkRef.current),
        linkCompletion(() => listLinkDirectoryRef.current),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: hostRef.current,
    });
    viewRef.current = view;
    scheduleSelectionReport();

    const observer = new MutationObserver(() => reconfigureHighlight(view));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      cancelAnimationFrame(selectionFrame);
      observer.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (viewRef.current) setVimKeybindings(viewRef.current, vimMode);
  }, [vimMode]);

  useEffect(() => {
    if (viewRef.current) setFocusDimming(viewRef.current, focusMode);
  }, [focusMode]);

  useEffect(() => {
    if (viewRef.current) setTypewriterScrolling(viewRef.current, typewriterMode);
  }, [typewriterMode]);

  useEffect(() => {
    if (viewRef.current) setMarkdownLint(viewRef.current, lintEnabled, documentPath);
  }, [lintEnabled, documentPath]);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    replaceDocument(text: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        effects: EditorView.scrollIntoView(0, { y: 'start' }),
      });
      resetHistory(view);
    },
    applyExternalContent(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const change = minimalChange(view.state.doc.toString(), text);
      if (!change) return;
      view.dispatch({
        changes: change,
        // Its own undo step, never merged into the user's adjacent typing.
        annotations: isolateHistory.of('full'),
      });
    },
    setReadOnly(readOnly) {
      if (viewRef.current) setEditorReadOnly(viewRef.current, readOnly);
    },
    getContent() {
      return viewRef.current?.state.doc.toString() ?? '';
    },
    undo() {
      if (viewRef.current) undo(viewRef.current);
    },
    redo() {
      if (viewRef.current) redo(viewRef.current);
    },
    format(action) {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      view.focus();
      if (action === 'bold') wrapBold(view);
      else if (action === 'italic') wrapItalic(view);
      else if (action === 'underline') wrapUnderline(view);
      else if (action === 'strike') wrapStrike(view);
    },
    insertTable() {
      const view = viewRef.current;
      if (!view) return false;
      view.focus();
      return insertTable(view);
    },
    formatTable() {
      const view = viewRef.current;
      if (!view) return false;
      view.focus();
      return formatTable(view);
    },
    scrollToLine(line: number) {
      const view = viewRef.current;
      if (!view) return;
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: 'start' }),
      });
      view.focus();
    },
    contextAtCoords(x: number, y: number) {
      const view = viewRef.current;
      if (!view) return { line: 1, text: '', before: '', after: '' };
      // `precise: false` snaps to the nearest position, so this always
      // resolves even when the click lands past the end of a line.
      const pos = view.posAtCoords({ x, y }, false);
      const { doc } = view.state;
      const line = doc.lineAt(pos);
      return {
        line: line.number,
        text: line.text,
        before: doc.sliceString(Math.max(0, pos - CONTEXT_CHARS), pos),
        after: doc.sliceString(pos, pos + CONTEXT_CHARS),
      };
    },
    revealSource({ before, after, snippet, nearLine, fallbackLine }) {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;

      // The exact spot: a caret there, and its word flashed.
      const source = normalizeWithOffsets(doc.toString());
      const point = locatePoint(source.text, before, after, (i) => {
        const line = doc.lineAt(source.offsets[i] ?? doc.length).number;
        // The click's block starts on `nearLine`, so the spot is at or below it.
        return line >= nearLine ? line - nearLine : (nearLine - line) * 4;
      });
      if (point !== null) {
        const pos = offsetOfPoint(source.offsets, point, doc.length, after);
        const word = view.state.wordAt(pos);
        view.dispatch({
          selection: { anchor: pos },
          effects: [
            EditorView.scrollIntoView(pos, { y: 'center' }),
            ...(word ? [flashRange(view, word.from, word.to)] : []),
          ],
        });
        view.focus();
        return;
      }

      const target = normalizeForMatch(snippet);

      // Find the source line whose text matches the clicked content, preferring
      // the occurrence nearest the section so duplicate text doesn't mislead.
      let matchLine: number | null = null;
      if (target.length >= MIN_MATCH_LEN) {
        let bestDist = Infinity;
        for (let n = 1; n <= doc.lines; n++) {
          const cleaned = normalizeForMatch(doc.line(n).text);
          if (
            cleaned.length >= MIN_MATCH_LEN &&
            (cleaned.includes(target) || target.includes(cleaned))
          ) {
            const dist = Math.abs(n - nearLine);
            if (dist < bestDist) {
              bestDist = dist;
              matchLine = n;
            }
          }
        }
      }

      const n = Math.min(Math.max(1, matchLine ?? fallbackLine), doc.lines);
      const line = doc.line(n);
      // Select the line so the actual text is highlighted, not just the heading.
      view.dispatch({
        selection: { anchor: line.from, head: line.to },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
      view.focus();
    },
    setTaskChecked(index, total, checked) {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return false;
      const markers = findTaskMarkers(view.state);
      const marker = markers[index];
      if (markers.length !== total || !marker) return false;
      if (marker.checked !== checked) {
        view.dispatch({
          changes: { from: marker.from + 1, to: marker.from + 2, insert: checked ? 'x' : ' ' },
          userEvent: 'input',
        });
      }
      return true;
    },
    lineTop(line) {
      const view = viewRef.current;
      if (!view) return 0;
      const { doc } = view.state;
      const n = Math.min(Math.max(1, Math.floor(line)), doc.lines);
      // Block positions are relative to the document, which starts below the
      // content's top padding; the scroller is the content's offsetParent.
      const documentStart = view.contentDOM.offsetTop + view.documentPadding.top;
      return documentStart + view.lineBlockAt(doc.line(n).from).top;
    },
    toggleLintPanel(open) {
      const view = viewRef.current;
      if (view) toggleLintPanel(view, open);
    },
    view() {
      return viewRef.current;
    },
  }));

  return <div ref={hostRef} className="editor-host" />;
});

export default Editor;
