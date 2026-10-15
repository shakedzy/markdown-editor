import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';

// A brief highlight on a range of the source ("Take me there" landing on a
// word), like the preview's text flash.

const FLASH_MS = 1300;

const setFlash = StateEffect.define<{ from: number; to: number } | null>();

const flashMark = Decoration.mark({ class: 'cm-flash' });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(flash, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        return e.value && e.value.from < e.value.to
          ? Decoration.set(flashMark.range(e.value.from, e.value.to))
          : Decoration.none;
      }
    }
    return tr.docChanged ? flash.map(tr.changes) : flash;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const flashExtension = flashField;

const timers = new WeakMap<EditorView, number>();

/** Highlight `from`–`to` for a moment (replacing any highlight still showing). */
export function flashRange(view: EditorView, from: number, to: number): StateEffect<unknown> {
  window.clearTimeout(timers.get(view));
  timers.set(
    view,
    window.setTimeout(() => {
      timers.delete(view);
      view.dispatch({ effects: setFlash.of(null) });
    }, FLASH_MS),
  );
  return setFlash.of({ from, to });
}
