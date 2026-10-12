import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

export interface TaskMarker {
  /** Position of the `[`; the state character sits at `from + 1`. */
  from: number;
  checked: boolean;
}

// Every GFM task-list marker (`[ ]` / `[x]`) in the source, in document order.
// The Nth entry corresponds to the Nth checkbox in the rendered preview, which
// is how a click in the preview is mapped back to the source.
export function findTaskMarkers(state: EditorState): TaskMarker[] {
  const markers: TaskMarker[] = [];
  // Force a full parse; see extractHeadings for why the lazy tree isn't enough.
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name !== 'TaskMarker') return;
      // Lezer also accepts a tab after the marker, but marked only treats
      // `[ ] ` (with a space) as a task. Skip the rest so the two sides line up.
      if (state.doc.sliceString(node.to, node.to + 1) !== ' ') return;
      const mark = state.doc.sliceString(node.from + 1, node.from + 2);
      markers.push({ from: node.from, checked: mark !== ' ' });
    },
  });
  return markers;
}
