import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions, reconfigureHighlight } from '../editor/extensions';
import { wrapBold, wrapItalic, wrapStrike, wrapUnderline } from '../editor/shortcuts';

export interface EditorHandle {
  focus(): void;
  setContent(text: string): void;
  getContent(): string;
  format(action: 'bold' | 'italic' | 'underline' | 'strike'): void;
  scrollToLine(line: number): void;
  currentLine(): number;
  view(): EditorView | null;
}

interface Props {
  initialDoc: string;
  onChange: (doc: string) => void;
}

const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { initialDoc, onChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;

    const startState = EditorState.create({
      doc: initialDoc,
      extensions: [
        ...buildExtensions(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: hostRef.current,
    });
    viewRef.current = view;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => reconfigureHighlight(view);
    mq.addEventListener('change', onSchemeChange);

    return () => {
      mq.removeEventListener('change', onSchemeChange);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    setContent(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === text) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
      });
    },
    getContent() {
      return viewRef.current?.state.doc.toString() ?? '';
    },
    format(action) {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      if (action === 'bold') wrapBold(view);
      else if (action === 'italic') wrapItalic(view);
      else if (action === 'underline') wrapUnderline(view);
      else if (action === 'strike') wrapStrike(view);
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
    currentLine() {
      const view = viewRef.current;
      if (!view) return 1;
      const head = view.state.selection.main.head;
      return view.state.doc.lineAt(head).number;
    },
    view() {
      return viewRef.current;
    },
  }));

  return <div ref={hostRef} className="editor-host" />;
});

export default Editor;
