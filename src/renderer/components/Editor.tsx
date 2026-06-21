import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions, reconfigureHighlight } from '../editor/extensions';
import { wrapBold, wrapItalic, wrapStrike, wrapUnderline } from '../editor/shortcuts';
import { MIN_MATCH_LEN, normalizeForMatch } from '../markdown/locate';

export interface EditorHandle {
  focus(): void;
  setContent(text: string): void;
  getContent(): string;
  format(action: 'bold' | 'italic' | 'underline' | 'strike'): void;
  scrollToLine(line: number): void;
  lineInfoAtCoords(x: number, y: number): { line: number; text: string };
  revealSource(opts: {
    snippet: string;
    nearLine: number;
    fallbackLine: number;
  }): void;
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

    const observer = new MutationObserver(() => reconfigureHighlight(view));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      observer.disconnect();
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
    lineInfoAtCoords(x: number, y: number) {
      const view = viewRef.current;
      if (!view) return { line: 1, text: '' };
      // `precise: false` snaps to the nearest position, so this always
      // resolves even when the click lands past the end of a line.
      const pos = view.posAtCoords({ x, y }, false);
      const line = view.state.doc.lineAt(pos);
      return { line: line.number, text: line.text };
    },
    revealSource({ snippet, nearLine, fallbackLine }) {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
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
    view() {
      return viewRef.current;
    },
  }));

  return <div ref={hostRef} className="editor-host" />;
});

export default Editor;
