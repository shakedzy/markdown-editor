import {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSection,
  acceptCompletion,
  autocompletion,
  insertCompletionText,
  pickedCompletion,
} from '@codemirror/autocomplete';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { LinkDirEntry } from '../../shared/types';
import { extractHeadings } from '../markdown/headings';
import { decodeLinkPath, unescapeLinkText } from '../links';
import { vimNormalMode } from './vim';

/**
 * Lists a folder named by a link being typed, relative to the document
 * ("", "images/", "../"): its folders, Markdown files and images. Null
 * when it can't (the document has no folder).
 */
export type DirectoryLister = (dir: string) => Promise<LinkDirEntry[] | null>;

/** A link or image destination being typed. */
interface TypedDestination {
  /** Where it starts: after "](", "]: " or the "<" of an <angle-bracket> destination. */
  from: number;
  text: string;
  /** In <angle brackets>, where spaces are allowed. */
  angle: boolean;
  /** An image's, which only images (and the folders on the way) make sense for. */
  image: boolean;
}

// How far back on its line a destination being typed is looked for.
const REACH = 1000;
// "](" of an inline link or image, then the destination so far: bare (where
// parentheses must be backslash-escaped), or in <…>.
const INLINE = /\]\((?:<([^<>\n]*)|((?:[^\s()<>\\]|\\\S)*))$/;
// "[label]: " of a reference definition, then the destination so far. Not a
// footnote's "[^label]: ", which is followed by text.
const DEFINITION = /^ {0,3}\[(?!\^)(?:[^\\\]]|\\.)+\]:[ \t]*(?:<([^<>\n]*)|([^\s<>]*))$/;
// Where a "](" isn't a link: code, raw HTML, comments.
const NOT_MARKDOWN = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
]);
const IMAGE_NAME = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

const FILES: CompletionSection = { name: 'Files', rank: 0 };
const HEADINGS: CompletionSection = { name: 'Headings', rank: 1 };

// Whether the "[" that the "]" at `close` ends is an image's "![".
function opensImage(text: string, close: number): boolean {
  let depth = 0;
  for (let i = close - 1; i >= 0; i--) {
    if (text[i - 1] === '\\') continue;
    if (text[i] === ']') depth++;
    else if (text[i] === '[' && depth-- === 0) return text[i - 1] === '!';
  }
  return false;
}

function typedDestination(state: EditorState, pos: number): TypedDestination | null {
  const line = state.doc.lineAt(pos);
  const start = Math.max(line.from, pos - REACH);
  const before = state.sliceDoc(start, pos);
  const inline = INLINE.exec(before);
  const match = inline ?? (start === line.from ? DEFINITION.exec(before) : null);
  if (!match) return null;
  const angle = match[1] !== undefined;
  const text = match[1] ?? match[2] ?? '';
  return {
    from: pos - text.length,
    text,
    angle,
    image: inline !== null && opensImage(before, inline.index),
  };
}

function inMarkdownText(state: EditorState, pos: number): boolean {
  // False in front matter, and in fenced code in another language.
  if (!markdownLanguage.isActiveAt(state, pos, -1)) return false;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (NOT_MARKDOWN.has(node.name)) return false;
  }
  return true;
}

// Options keep the order they are listed in (headings as in the document,
// folders before files) wherever matching ranks them the same.
function order(index: number): string {
  return String(index).padStart(6, '0');
}

function anchorOptions(state: EditorState, section?: CompletionSection): Completion[] {
  return extractHeadings(state).map((heading, i) => ({
    label: `#${heading.slug}`,
    detail: heading.text,
    type: 'anchor',
    sortText: order(i),
    section,
  }));
}

/**
 * Inserting an entry's name, with any `%`, `?` or `#` in it %-encoded (links
 * decode escapes, and end their path at a query or fragment). Names with
 * spaces or parentheses need the whole destination in <angle brackets>,
 * which a file name then closes.
 */
function applyEntry(entry: LinkDirEntry, typed: TypedDestination, dir: string): Completion['apply'] {
  const encoded = entry.name.replace(/[%?#]/g, encodeURIComponent);
  const name = entry.isDir ? `${encoded}/` : encoded;
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    let insert = name;
    let start = from;
    if (!typed.angle && /[\s()]/.test(entry.name)) {
      start = from - dir.length;
      insert = `<${dir}${name}${entry.isDir ? '' : '>'}`;
    } else if (typed.angle && !entry.isDir && view.state.sliceDoc(to, to + 1) !== '>') {
      insert += '>';
    }
    view.dispatch({
      ...insertCompletionText(view.state, insert, start, to),
      annotations: pickedCompletion.of(completion),
    });
  };
}

async function linkSource(
  context: CompletionContext,
  lister: DirectoryLister | undefined,
): Promise<CompletionResult | null> {
  const { state, pos } = context;
  if (context.view && vimNormalMode(context.view)) return null;
  const typed = typedDestination(state, pos);
  if (!typed || !inMarkdownText(state, pos)) return null;
  // Editing inside a destination that goes on after the cursor isn't typing a
  // new one (and a pick would leave the rest of the old one behind).
  if (/^[^\s)>#]/.test(state.sliceDoc(pos, pos + 1))) return null;

  const { text } = typed;
  if (text.startsWith('#')) {
    if (typed.image) return null;
    return { from: typed.from, options: anchorOptions(state), validFor: /^#[^\s#()<>]*$/ };
  }
  // A web address; or another file's headings, which would mean reading it.
  if (/[#?]/.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) return null;

  const slash = text.lastIndexOf('/');
  const dir = text.slice(0, slash + 1);
  const entries = lister ? await lister(decodeLinkPath(unescapeLinkText(dir))) : null;
  // CodeMirror matches what's typed against the names as they are, which a
  // name typed with backslash escapes ("my\(no") never matches: those are
  // matched here instead, unescaped.
  const name = text.slice(slash + 1);
  const query = unescapeLinkText(name).toLowerCase();
  const escaped = name.includes('\\');
  const options: Completion[] = [];
  const withAnchors = text === '' && !typed.image;
  entries?.forEach((entry, i) => {
    // Can't be written as a destination, even in <angle brackets>.
    if (/[<>\n]/.test(entry.name)) return;
    if (typed.image && !entry.isDir && !IMAGE_NAME.test(entry.name)) return;
    if (escaped && !entry.name.toLowerCase().includes(query)) return;
    options.push({
      label: entry.isDir ? `${entry.name}/` : entry.name,
      type: entry.isDir ? 'folder' : IMAGE_NAME.test(entry.name) ? 'image' : 'file',
      sortText: order(i),
      section: withAnchors ? FILES : undefined,
      apply: applyEntry(entry, typed, dir),
    });
  });
  if (withAnchors) options.push(...anchorOptions(state, options.length ? HEADINGS : undefined));
  if (options.length === 0) return null;
  const from = typed.from + slash + 1;
  if (escaped) {
    // Unfiltered results can't have a validFor, so each key asks again.
    return {
      from,
      options,
      filter: false,
      getMatch: (option) => {
        const at = option.label.toLowerCase().indexOf(query);
        return at < 0 ? [] : [at, at + query.length];
      },
    };
  }
  return {
    from,
    options,
    // Typing "/" lists the next folder, "#" the headings, and "\" starts an
    // escape, matched above.
    validFor: typed.angle ? /^[^/#<>\\]*$/ : /^[^/#\s()<>\\]*$/,
  };
}

/**
 * Completion of link and image destinations, the editor's only
 * autocompletion: after "](" (or "]: " in a reference definition, though not
 * in a footnote's) it offers the document's headings as #anchors and, for a
 * saved document, the folders, Markdown files and images next to it
 * (`getLister`), a folder at a time. Picking a folder lists it in turn.
 * Nothing pops up anywhere else, nor in the middle of a destination.
 * Enter or Tab takes the selected option while the list is open; otherwise
 * they do what they always do.
 */
export function linkCompletion(getLister: () => DirectoryLister | undefined): Extension {
  return [
    autocompletion({
      override: [(context) => linkSource(context, getLister())],
      activateOnCompletion: (completion) => completion.type === 'folder',
    }),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ];
}
