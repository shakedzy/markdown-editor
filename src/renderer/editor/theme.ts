import { EditorView } from '@codemirror/view';

export const mditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    fontFamily:
      '"SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    color: '#1f2328',
    backgroundColor: '#ffffff',
  },
  '.cm-content': {
    padding: '12px 16px',
    caretColor: '#1f2328',
    lineHeight: '1.55',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    overflow: 'auto',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-line': {
    padding: '0 2px',
  },
  '.cm-cursor': {
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#cce5ff',
  },
});
