import { Compartment, EditorState, Extension, Line, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  showPanel,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { completionStatus } from '@codemirror/autocomplete';
import type { SyntaxNode } from '@lezer/common';

/** A run of whole lines, by 1-based line number, both ends included. */
export interface LineSpan {
  first: number;
  last: number;
}

// Separates paragraphs: only whitespace, or the bare `>` of a blockquote.
const BLANK = /^[\s>]*$/;

// Blocks that are one paragraph however they're laid out.
const WHOLE_BLOCKS = new Set(['FencedCode', 'Frontmatter']);

/**
 * A paragraph as far as it has been followed. An open end is where the walk
 * stopped short, so the paragraph may go on past it.
 */
export interface Paragraph extends LineSpan {
  openAbove: boolean;
  openBelow: boolean;
}

// The fenced code block (or front matter) a line belongs to. The line's end
// is inside the block for its fence lines and its content lines alike, blank
// ones included.
function blockAround(state: EditorState, line: Line): LineSpan | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.to, -1);
  for (; node; node = node.parent) {
    if (WHOLE_BLOCKS.has(node.name)) {
      return {
        first: state.doc.lineAt(node.from).number,
        last: state.doc.lineAt(node.to).number,
      };
    }
  }
  return null;
}

/**
 * Follow `p`'s open ends as far as `within` reaches: on through the run of
 * non-blank lines, stopping at a blank line or a fenced code block (or front
 * matter), which is never part of a neighbor's run.
 */
export function followParagraph(state: EditorState, p: Paragraph, within: LineSpan): Paragraph {
  const { doc } = state;
  const joins = (m: number) => {
    const next = doc.line(m);
    return !BLANK.test(next.text) && !blockAround(state, next);
  };
  let { first, last, openAbove, openBelow } = p;
  while (openAbove && first > within.first) {
    if (joins(first - 1)) first--;
    else openAbove = false;
  }
  while (openBelow && last < within.last) {
    if (joins(last + 1)) last++;
    else openBelow = false;
  }
  return { first, last, openAbove, openBelow };
}

/**
 * The paragraph line `n` is in: the run of non-blank lines around it, or the
 * whole fenced code block (or front matter) it belongs to, which is one
 * paragraph, blank lines and all. A blank line is a paragraph of its own.
 * Runs are followed no further than `within` (beyond `n` itself), as lines
 * outside it aren't drawn; followParagraph takes them further.
 */
export function paragraphAt(state: EditorState, n: number, within: LineSpan): Paragraph {
  const line = state.doc.line(n);
  const block = blockAround(state, line);
  if (block) return { ...block, openAbove: false, openBelow: false };
  if (BLANK.test(line.text)) return { first: n, last: n, openAbove: false, openBelow: false };
  return followParagraph(state, { first: n, last: n, openAbove: true, openBelow: true }, within);
}

/**
 * The lines kept at full strength: for each selection range, the paragraphs
 * it starts and ends in and everything between.
 */
export function activeSpans(state: EditorState, within: LineSpan): Paragraph[] {
  return state.selection.ranges.map((range) => {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    const start = paragraphAt(state, from, within);
    const end = to === from ? start : paragraphAt(state, to, within);
    return {
      first: start.first,
      last: end.last,
      openAbove: start.openAbove,
      openBelow: end.openBelow,
    };
  });
}

function viewportLines(view: EditorView): LineSpan {
  const { doc } = view.state;
  return {
    first: doc.lineAt(view.viewport.from).number,
    last: doc.lineAt(view.viewport.to).number,
  };
}

const dimmed = Decoration.line({ class: 'cm-focusDimmed' });

function dimmedLines(view: EditorView, active: LineSpan[]): DecorationSet {
  const { doc } = view.state;
  const within = viewportLines(view);
  const builder = new RangeSetBuilder<Decoration>();
  for (let n = within.first; n <= within.last; n++) {
    if (!active.some((span) => span.first <= n && n <= span.last)) {
      const { from } = doc.line(n);
      builder.add(from, from, dimmed);
    }
  }
  return builder.finish();
}

const dimInactiveParagraphs = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    // The lit paragraphs, followed as far as the viewport has reached since
    // the document, selection or parse last changed. Scrolling follows them
    // only over the lines it brings into view, never again from the caret,
    // which can be thousands of lines away in a long list or table.
    active: Paragraph[];

    constructor(view: EditorView) {
      this.active = activeSpans(view.state, viewportLines(view));
      this.decorations = dimmedLines(view, this.active);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        // Fences found as the parse catches up.
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.active = activeSpans(update.state, viewportLines(update.view));
      } else if (update.viewportChanged) {
        const within = viewportLines(update.view);
        this.active = this.active.map((p) => followParagraph(update.state, p, within));
      } else {
        return;
      }
      this.decorations = dimmedLines(update.view, this.active);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const focusCompartment = new Compartment();

/**
 * Focus mode's editor side: every line outside the paragraph being written
 * gets the `cm-focusDimmed` class, `enabled` to start with (switch it with
 * setFocusDimming). The styles live with the rest of focus mode's in app.css.
 */
export function focusDimming(enabled: boolean): Extension {
  return focusCompartment.of(enabled ? dimInactiveParagraphs : []);
}

/**
 * Turn focus dimming on or off in a running editor. Turning it on also
 * brings the caret to the middle, since the layout around it just changed.
 */
export function setFocusDimming(view: EditorView, enabled: boolean): void {
  if ((focusCompartment.get(view.state) === dimInactiveParagraphs) === enabled) return;
  view.dispatch({
    effects: [
      focusCompartment.reconfigure(enabled ? dimInactiveParagraphs : []),
      ...(enabled
        ? [EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' })]
        : []),
    ],
  });
}

/** Something open in the editor takes Escape first: a panel (search, say) or a completion list. */
export function editorClaimsEscape(state: EditorState): boolean {
  return state.facet(showPanel).some(Boolean) || completionStatus(state) !== null;
}
