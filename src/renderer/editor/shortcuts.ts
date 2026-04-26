import { EditorView, KeyBinding } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

interface FormatMarkers {
  bold: '**' | '__';
  italic: '_' | '*';
  strike: '~' | '~~';
  underline: 'ins' | 'u';
}

let currentMarkers: FormatMarkers = {
  bold: '**',
  italic: '_',
  strike: '~',
  underline: 'ins',
};

export function setFormatMarkers(m: FormatMarkers): void {
  currentMarkers = { ...m };
}

function wrapSelection(
  view: EditorView,
  before: string,
  after: string = before,
): boolean {
  const changes = view.state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: [{ from: range.from, insert: before + after }],
        range: EditorSelection.cursor(range.from + before.length),
      };
    }
    const text = view.state.doc.sliceString(range.from, range.to);
    return {
      changes: [{ from: range.from, to: range.to, insert: before + text + after }],
      range: EditorSelection.range(
        range.from + before.length,
        range.to + before.length,
      ),
    };
  });
  view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
}

export const wrapBold = (view: EditorView): boolean =>
  wrapSelection(view, currentMarkers.bold);

export const wrapItalic = (view: EditorView): boolean =>
  wrapSelection(view, currentMarkers.italic);

export const wrapStrike = (view: EditorView): boolean =>
  wrapSelection(view, currentMarkers.strike);

export const wrapUnderline = (view: EditorView): boolean => {
  if (currentMarkers.underline === 'u') {
    return wrapSelection(view, '<u>', '</u>');
  }
  return wrapSelection(view, '<ins>', '</ins>');
};

export const formattingKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: wrapBold, preventDefault: true },
  { key: 'Mod-i', run: wrapItalic, preventDefault: true },
  { key: 'Mod-u', run: wrapUnderline, preventDefault: true },
];
