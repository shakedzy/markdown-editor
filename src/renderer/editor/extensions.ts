import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  HighlightStyle,
} from '@codemirror/language';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { formattingKeymap } from './shortcuts';
import { mditorTheme } from './theme';

const headingOverrides = HighlightStyle.define([
  { tag: t.heading, fontWeight: 'bold' },
  { tag: t.heading1, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading2, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading3, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading4, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading5, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading6, fontWeight: 'bold', textDecoration: 'underline' },
]);

// GitHub-Dark inspired palette for dark mode. Built so every default
// highlight tag from @codemirror/language has a high-contrast counterpart
// against #0d1117.
const darkSyntax = HighlightStyle.define([
  { tag: t.heading, fontWeight: 'bold' },
  { tag: t.heading1, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading2, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading3, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading4, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading5, fontWeight: 'bold', textDecoration: 'underline' },
  { tag: t.heading6, fontWeight: 'bold', textDecoration: 'underline' },

  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },

  { tag: t.processingInstruction, color: '#8b949e' },
  { tag: t.contentSeparator, color: '#8b949e' },
  { tag: t.list, color: '#8b949e' },
  { tag: t.quote, color: '#8b949e', fontStyle: 'italic' },

  { tag: t.link, color: '#58a6ff', textDecoration: 'underline' },
  { tag: t.url, color: '#58a6ff' },
  { tag: t.monospace, color: '#a5d6ff', fontFamily: 'inherit' },

  { tag: t.meta, color: '#8b949e' },
  { tag: t.comment, color: '#8b949e', fontStyle: 'italic' },

  { tag: t.keyword, color: '#ff7b72' },
  { tag: [t.atom, t.bool, t.labelName], color: '#79c0ff' },
  { tag: [t.literal, t.inserted], color: '#a5d6ff' },
  { tag: [t.string, t.deleted], color: '#a5d6ff' },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: '#79c0ff' },
  { tag: t.definition(t.variableName), color: '#ffa657' },
  { tag: t.local(t.variableName), color: '#ffa657' },
  { tag: [t.typeName, t.namespace], color: '#7ee787' },
  { tag: t.className, color: '#7ee787' },
  { tag: [t.special(t.variableName), t.macroName], color: '#79c0ff' },
  { tag: t.definition(t.propertyName), color: '#79c0ff' },
  { tag: t.invalid, color: '#ff7b72' },
]);

const highlightCompartment = new Compartment();

function isDarkMode(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function pickHighlight(): Extension {
  return isDarkMode()
    ? syntaxHighlighting(darkSyntax)
    : [
        syntaxHighlighting(headingOverrides),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ];
}

export function reconfigureHighlight(view: EditorView): void {
  view.dispatch({
    effects: highlightCompartment.reconfigure(pickHighlight()),
  });
}

export function buildExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    bracketMatching(),
    search({ top: true }),
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    highlightCompartment.of(pickHighlight()),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on' }),
    keymap.of([
      ...formattingKeymap,
      ...searchKeymap,
      ...markdownKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    mditorTheme,
    EditorState.tabSize.of(2),
  ];
}
