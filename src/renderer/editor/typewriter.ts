import { Compartment, EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

const centerOn = (head: number) => EditorView.scrollIntoView(head, { y: 'center' });

// The transactions that scroll the caret into view anyway (typing, deleting,
// pasting, keyboard motion, undo) center it instead. Pointer selections and
// wheel scrolling don't ask to scroll, so they're left where the user put
// them. An IME composition keeps the default scrolling while it lasts, as
// moving its line under the candidate window would fight the user; it's
// centered once it commits.
const centerOnScroll = EditorState.transactionExtender.of((tr) =>
  tr.scrollIntoView && !tr.isUserEvent('input.type.compose')
    ? { effects: centerOn(tr.newSelection.main.head) }
    : null,
);

const centerAfterComposition = ViewPlugin.fromClass(
  class {
    timer = 0;

    destroy() {
      window.clearTimeout(this.timer);
    }
  },
  {
    eventHandlers: {
      compositionend(_event, view) {
        // After the editor has applied the composed text (a microtask away).
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          if (view.composing) return;
          view.dispatch({ effects: centerOn(view.state.selection.main.head) });
        });
      },
    },
  },
);

const typewriter: Extension = [
  centerOnScroll,
  centerAfterComposition,
  // Room below the last line, so it too can come up to the middle.
  EditorView.contentAttributes.of({ style: 'padding-bottom: 50vh' }),
];

const typewriterCompartment = new Compartment();

/**
 * Typewriter scrolling: the caret line stays vertically centered while
 * typing or moving the caret with the keyboard. `enabled` to start with;
 * switch it with setTypewriterScrolling.
 */
export function typewriterScrolling(enabled: boolean): Extension {
  return typewriterCompartment.of(enabled ? typewriter : []);
}

/** Turn typewriter scrolling on or off in a running editor. */
export function setTypewriterScrolling(view: EditorView, enabled: boolean): void {
  if ((typewriterCompartment.get(view.state) === typewriter) === enabled) return;
  view.dispatch({
    effects: [
      typewriterCompartment.reconfigure(enabled ? typewriter : []),
      // Center now rather than at the next keystroke, unless the switch was
      // flipped from somewhere else (Settings) and the caret isn't in use.
      ...(enabled && view.hasFocus ? [centerOn(view.state.selection.main.head)] : []),
    ],
  });
}
