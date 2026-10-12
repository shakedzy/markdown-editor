// Scroll sync between the editor and the preview (split view). The panes are
// paired through anchors: preview blocks tagged with the source line they
// start on (`data-line`), matched with where that line sits in the editor.
// Offsets between two anchors are interpolated linearly, and the contents'
// starts and ends pair up as well, so a document without blocks still maps
// proportionally. Offsets are in px from the top of a pane's scrolled content.

export interface SourceAnchor {
  /** 1-based source line the preview block starts on. */
  line: number;
  /** The block's offset in the preview's scrolled content. */
  top: number;
}

export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

interface Pair {
  editor: number;
  preview: number;
}

/**
 * Keep only anchors that move strictly down in both line and offset (blocks
 * nested in raw HTML can share their parent's top), and below the content's
 * start, which pairs up on its own.
 */
export function increasingAnchors(anchors: Iterable<SourceAnchor>): SourceAnchor[] {
  const kept: SourceAnchor[] = [];
  let last: SourceAnchor = { line: 0, top: 0 };
  for (const anchor of anchors) {
    if (anchor.line > last.line && anchor.top > last.top) {
      kept.push(anchor);
      last = anchor;
    }
  }
  return kept;
}

/**
 * The offset in a pane's content that lines up with the other pane: the top
 * of the viewport, except over the last screenful of scrolling, where it
 * slides down to the viewport's bottom so both panes reach their ends together.
 */
export function alignPoint({ scrollTop, clientHeight, scrollHeight }: ScrollBox): number {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return 0;
  const top = clamp(scrollTop, 0, max);
  const slideFrom = Math.max(0, max - clientHeight);
  if (top <= slideFrom) return top;
  return top + (clientHeight * (top - slideFrom)) / (max - slideFrom);
}

/** The scrollTop that puts a pane's align point at `offset` (the inverse of alignPoint). */
export function scrollTopForAlignPoint(
  offset: number,
  { clientHeight, scrollHeight }: Omit<ScrollBox, 'scrollTop'>,
): number {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return 0;
  const slideFrom = Math.max(0, max - clientHeight);
  if (offset <= slideFrom) return Math.max(0, offset);
  const span = max - slideFrom;
  return clamp((offset * span + clientHeight * slideFrom) / (span + clientHeight), 0, max);
}

/**
 * The preview offset matching editor offset `offset`. `anchors` come from
 * increasingAnchors; `editorTop(line)` is where a source line starts in the
 * editor's content.
 */
export function editorToPreview(
  offset: number,
  anchors: readonly SourceAnchor[],
  editorTop: (line: number) => number,
  editorHeight: number,
  previewHeight: number,
): number {
  // Searching by offset rather than by the line at `offset` keeps the
  // editor's top padding (above line 1) paired with the preview's.
  const i = lastIndexAtOrBefore(anchors, offset, (a) => editorTop(a.line));
  const [from, to] = bracket(anchors, i, editorTop, editorHeight, previewHeight);
  return interpolate(offset, from.editor, to.editor, from.preview, to.preview);
}

/** The editor offset matching preview offset `offset` (the inverse of editorToPreview). */
export function previewToEditor(
  offset: number,
  anchors: readonly SourceAnchor[],
  editorTop: (line: number) => number,
  editorHeight: number,
  previewHeight: number,
): number {
  const i = lastIndexAtOrBefore(anchors, offset, (a) => a.top);
  const [from, to] = bracket(anchors, i, editorTop, editorHeight, previewHeight);
  return interpolate(offset, from.preview, to.preview, from.editor, to.editor);
}

/** Anchor `i` and the one after it, with the contents' starts and ends standing in past either end. */
function bracket(
  anchors: readonly SourceAnchor[],
  i: number,
  editorTop: (line: number) => number,
  editorHeight: number,
  previewHeight: number,
): [Pair, Pair] {
  const pair = (j: number): Pair => {
    const anchor = anchors[j];
    if (anchor) return { editor: editorTop(anchor.line), preview: anchor.top };
    return j < 0 ? { editor: 0, preview: 0 } : { editor: editorHeight, preview: previewHeight };
  };
  return [pair(i), pair(i + 1)];
}

/** Binary search: the last index whose key is <= `value`, or -1. Keys must increase. */
function lastIndexAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]!) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function interpolate(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 <= x0) return y0;
  return y0 + (y1 - y0) * clamp((x - x0) / (x1 - x0), 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
