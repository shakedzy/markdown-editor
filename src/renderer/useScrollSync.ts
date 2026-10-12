import { RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import type { EditorHandle } from './components/Editor';
import type { PreviewHandle } from './components/Preview';
import { useLatest } from './useLatest';
import {
  alignPoint,
  editorToPreview,
  previewToEditor,
  scrollTopForAlignPoint,
} from './scrollSync';

export type Pane = 'editor' | 'preview';

// A hold lasts until neither pane has scrolled for this long.
const HOLD_QUIET_MS = 200;
const LISTENER_OPTIONS = { capture: true, passive: true };

export interface ScrollSync {
  /** For Preview's onLayoutChange: the blocks moved, so line the panes up again. */
  onPreviewLayout(): void;
  /**
   * For Editor's onScrollIntoView: an edit or command brought the cursor into
   * view (undo or paste from the menu bar, Insert Table), so the editor drives.
   */
  onEditorScrollIntoView(): void;
  /**
   * Leave both panes alone until they stop moving, for a jump that positions
   * each pane itself (TOC, Take me there).
   */
  hold(): void;
}

/**
 * Keeps the editor's and the preview's scroll positions in step while
 * `enabled`. The pane the user last scrolled, clicked or typed in drives and
 * the other follows, so scrolling the follower programmatically (or the
 * preview reflowing under it) never pulls the driver along. `shownPane` is the
 * only pane on screen (Tabs view), which drives once both are.
 */
export function useScrollSync(
  editorRef: RefObject<EditorHandle>,
  previewRef: RefObject<PreviewHandle>,
  enabled: boolean,
  shownPane: Pane | null,
): ScrollSync {
  const driverRef = useRef<Pane>('editor');
  const controlsRef = useRef<Pick<ScrollSync, 'onPreviewLayout' | 'hold'> | null>(null);
  const shownPaneRef = useLatest(shownPane);

  useEffect(() => {
    if (shownPane) driverRef.current = shownPane;
  }, [shownPane]);

  // Tracked even while sync is off, so turning it on keeps the pane the user
  // was working in where it is.
  useEffect(() => {
    const view = editorRef.current?.view();
    const host = previewRef.current?.element();
    if (!view || !host) return;
    const panes: [Pane, HTMLElement][] = [
      ['editor', view.dom],
      // The whole preview, its search bar included.
      ['preview', host.closest<HTMLElement>('.preview-container') ?? host],
    ];
    const types = ['pointerdown', 'wheel', 'keydown'];
    const drivers = panes.map(([pane, el]) => {
      const drive = () => {
        driverRef.current = pane;
      };
      for (const type of types) el.addEventListener(type, drive, LISTENER_OPTIONS);
      return () => {
        for (const type of types) el.removeEventListener(type, drive, LISTENER_OPTIONS);
      };
    });
    return () => drivers.forEach((off) => off());
  }, [editorRef, previewRef]);

  useEffect(() => {
    if (!enabled) return;
    const editorEl = editorRef.current?.view()?.scrollDOM;
    const previewEl = previewRef.current?.element();
    if (!editorEl || !previewEl) return;
    const scrollers: Record<Pane, HTMLElement> = { editor: editorEl, preview: previewEl };

    let frame = 0;
    let holdTimer = 0;

    const align = () => {
      const editor = editorRef.current;
      const preview = previewRef.current;
      const driver = driverRef.current;
      const from = scrollers[driver];
      // A pane that can't scroll has no position to follow (a short document
      // next to a long preview, say).
      if (!editor || !preview || from.scrollHeight <= from.clientHeight) return;
      const anchors = preview.sourceAnchors();
      const lineTop = (line: number) => editor.lineTop(line);
      const offset = alignPoint(from);
      const heights = [editorEl.scrollHeight, previewEl.scrollHeight] as const;
      const [to, target] =
        driver === 'editor'
          ? [previewEl, editorToPreview(offset, anchors, lineTop, ...heights)]
          : [editorEl, previewToEditor(offset, anchors, lineTop, ...heights)];
      const top = scrollTopForAlignPoint(target, to);
      if (Math.abs(to.scrollTop - top) >= 1) to.scrollTop = top;
    };

    const schedule = () => {
      if (holdTimer || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        align();
      });
    };

    const hold = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      window.clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
      }, HOLD_QUIET_MS);
    };

    // Either pane scrolling re-aligns the follower: the driver moved, or the
    // follower shifted on its own (the editor measuring lines it had only
    // estimated, the preview clamping after a re-render). Aligning the
    // follower to where it already is ends the echo of setting it.
    const onScroll = () => {
      if (holdTimer) hold();
      else schedule();
    };
    for (const el of [editorEl, previewEl]) el.addEventListener('scroll', onScroll, LISTENER_OPTIONS);

    // Reflowing either pane (window or divider resized, TOC toggled) moves
    // lines. This also fires once right away, lining the panes up as sync starts.
    const resize = new ResizeObserver(() => schedule());
    resize.observe(editorEl);
    resize.observe(previewEl);

    controlsRef.current = { onPreviewLayout: schedule, hold };
    return () => {
      controlsRef.current = null;
      cancelAnimationFrame(frame);
      window.clearTimeout(holdTimer);
      resize.disconnect();
      for (const el of [editorEl, previewEl]) {
        el.removeEventListener('scroll', onScroll, LISTENER_OPTIONS);
      }
    };
  }, [enabled, editorRef, previewRef]);

  const onPreviewLayout = useCallback(() => controlsRef.current?.onPreviewLayout(), []);
  const hold = useCallback(() => controlsRef.current?.hold(), []);
  // Edits from the menu bar fire no input in the editor's DOM. A hidden editor
  // (the Preview tab) doesn't take over.
  const onEditorScrollIntoView = useCallback(() => {
    if (shownPaneRef.current !== 'preview') driverRef.current = 'editor';
  }, []);
  return useMemo(
    () => ({ onPreviewLayout, onEditorScrollIntoView, hold }),
    [onPreviewLayout, onEditorScrollIntoView, hold],
  );
}
