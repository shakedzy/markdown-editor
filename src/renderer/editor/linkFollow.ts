import { EditorState, Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { linkDestination, normalizeLabel } from '../links';
import { IS_MAC } from '../platform';

/** A link in the document: the text it spans, and where it leads (its destination as the link means it). */
export interface LinkSpan {
  from: number;
  to: number;
  href: string;
}

/** Follows a link's destination (as the link means it). */
export type LinkFollower = (href: string) => void;

// Nodes whose URL child belongs to them rather than being a bare URL.
const URL_OWNERS = new Set(['Link', 'Image', 'Autolink', 'LinkReference']);
// Blocks that can't hold a reference definition, so the search skips their insides.
const NO_DEFINITIONS = new Set([
  'Paragraph',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'Table',
  'Frontmatter',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
]);
const EMAIL = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/;
// Web addresses outside Markdown links: in code, front matter, HTML.
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// How far around the pointer a line is searched for a bare URL.
const BARE_URL_REACH = 2000;

/** Where an autolink or bare URL leads: "www." addresses are web pages, plain addresses e-mail. */
function autolinkHref(text: string): string {
  if (/^www\./i.test(text)) return `http://${text}`;
  return EMAIL.test(text) ? `mailto:${text}` : text;
}

// Per syntax tree, not per document: a tree still being parsed may not have
// reached every definition yet.
const definitionCache = new WeakMap<Tree, Map<string, string>>();

/** The document's reference definitions (`[label]: destination`), by normalized label; the first one wins. */
function definitions(state: EditorState): Map<string, string> {
  const tree = syntaxTree(state);
  let found = definitionCache.get(tree);
  if (found) return found;
  const defs = new Map<string, string>();
  tree.iterate({
    enter(node) {
      if (NO_DEFINITIONS.has(node.name)) return false;
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel');
      const url = node.node.getChild('URL');
      if (label && url) {
        const name = state.sliceDoc(label.from + 1, label.to - 1);
        const key = normalizeLabel(name);
        // A footnote's (`[^1]: Ibid.`): its text isn't a destination.
        if (!name.startsWith('^') && !defs.has(key)) {
          defs.set(key, linkDestination(state.sliceDoc(url.from, url.to)));
        }
      }
      return false;
    },
  });
  found = defs;
  definitionCache.set(tree, found);
  return found;
}

// Where a Link or Image leads: its own destination, or its reference's
// ([text][label], [label][], [label]); null for brackets that aren't a link.
function linkHref(state: EditorState, node: SyntaxNode): string | null {
  const url = node.getChild('URL');
  if (url) return linkDestination(state.sliceDoc(url.from, url.to));
  const marks = node.getChildren('LinkMark');
  // An inline link with an empty destination, `[text]()`, goes nowhere.
  if (marks.some((m) => state.sliceDoc(m.from, m.to) === '(')) return null;
  const label = node.getChild('LinkLabel');
  let name = label ? state.sliceDoc(label.from + 1, label.to - 1) : '';
  if (!name.trim() && marks.length >= 2) name = state.sliceDoc(marks[0]!.to, marks[1]!.from);
  return definitions(state).get(normalizeLabel(name)) ?? null;
}

/** A web address in plain text around `pos` (not Markdown: code, front matter, HTML attributes). */
function bareUrlAt(state: EditorState, pos: number): LinkSpan | null {
  const line = state.doc.lineAt(pos);
  const start = Math.max(line.from, pos - BARE_URL_REACH);
  const text = state.sliceDoc(start, Math.min(line.to, pos + BARE_URL_REACH));
  for (const match of text.matchAll(BARE_URL)) {
    const from = start + match.index;
    if (from > pos) break;
    // As GFM does: trailing punctuation and unbalanced ")" end the address.
    let url = match[0];
    for (let prev = ''; prev !== url; ) {
      prev = url;
      url = url.replace(/[?!.,:*_~;]+$/, '');
      if (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
    }
    if (pos < from + url.length) return { from, to: from + url.length, href: autolinkHref(url) };
  }
  return null;
}

/** The link that the character at `pos` is part of, if any. */
export function linkAt(state: EditorState, pos: number): LinkSpan | null {
  if (pos < 0 || pos >= state.doc.length) return null;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    switch (node.name) {
      case 'URL':
        if (URL_OWNERS.has(node.parent?.name ?? '')) break;
        return { from: node.from, to: node.to, href: autolinkHref(state.sliceDoc(node.from, node.to)) };
      case 'Autolink': {
        const url = node.getChild('URL');
        if (!url) return null;
        return { from: node.from, to: node.to, href: autolinkHref(state.sliceDoc(url.from, url.to)) };
      }
      case 'Link':
      case 'Image': {
        const href = linkHref(state, node);
        // Brackets that aren't a link may still be inside one ([![img](a.png)]…).
        if (href !== null) return { from: node.from, to: node.to, href };
        break;
      }
      case 'LinkReference': {
        // A footnote's text isn't a link (but a web address in it still is).
        const label = node.getChild('LinkLabel');
        if (label && state.sliceDoc(label.from + 1, label.from + 2) === '^') break;
        // A definition's destination is a link; its label and title aren't.
        const url = node.getChild('URL');
        if (!url || pos < url.from || pos >= url.to) return null;
        return { from: url.from, to: url.to, href: linkDestination(state.sliceDoc(url.from, url.to)) };
      }
    }
  }
  return bareUrlAt(state, pos);
}

/** The link under the pointer at (x, y); nothing beside a line's text counts. */
function linkAtCoords(view: EditorView, x: number, y: number): LinkSpan | null {
  const hit = view.posAndSideAtCoords({ x, y });
  if (!hit) return null;
  const pos = hit.assoc < 0 ? hit.pos - 1 : hit.pos;
  // Past the end of a line the nearest position is still its last character.
  const box = pos >= 0 && pos < view.state.doc.length ? view.coordsForChar(pos) : null;
  if (!box || x < box.left - 1 || x > box.right + 1 || y < box.top || y > box.bottom) return null;
  return linkAt(view.state, pos);
}

/** Cmd on macOS, Ctrl elsewhere: the key that makes a click follow a link. */
function followKey(event: MouseEvent | KeyboardEvent): boolean {
  return (IS_MAC ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;
}

const setHover = StateEffect.define<{ from: number; to: number } | null>();
const hoverMark = Decoration.mark({ class: 'cm-followableLink' });

// The link a click would follow right now, underlined.
const hoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setHover)) continue;
      decorations = effect.value
        ? Decoration.set(hoverMark.range(effect.value.from, effect.value.to))
        : Decoration.none;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class LinkHover {
  private pointer: { x: number; y: number } | null = null;
  private held = false;
  private shown: { from: number; to: number } | null = null;

  constructor(private readonly view: EditorView) {
    // The key may be pressed or let go while the pointer rests on a link,
    // with the keyboard focus anywhere in the window.
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
    view.contentDOM.addEventListener('mousemove', this.onMove);
    view.contentDOM.addEventListener('mouseleave', this.onLeave);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    this.view.contentDOM.removeEventListener('mousemove', this.onMove);
    this.view.contentDOM.removeEventListener('mouseleave', this.onLeave);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (followKey(event) === this.held) return;
    this.held = followKey(event);
    this.refresh();
  };

  private readonly onBlur = (): void => {
    this.held = false;
    this.refresh();
  };

  private readonly onMove = (event: MouseEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.held = followKey(event);
    this.refresh();
  };

  private readonly onLeave = (): void => {
    this.pointer = null;
    this.refresh();
  };

  private readonly onScroll = (): void => {
    if (this.held) this.refresh();
  };

  private refresh(): void {
    const { pointer } = this;
    const link = this.held && pointer ? linkAtCoords(this.view, pointer.x, pointer.y) : null;
    const next = link && { from: link.from, to: link.to };
    if (next?.from === this.shown?.from && next?.to === this.shown?.to) return;
    this.shown = next;
    this.view.dispatch({ effects: setHover.of(next) });
  }
}

const hoverTheme = EditorView.baseTheme({
  '.cm-followableLink': { cursor: 'pointer', textDecoration: 'underline' },
});

/**
 * Cmd-click (Ctrl-click off macOS) on a link follows it: inline, reference
 * and autolinks, images, reference definitions, and bare web addresses
 * anywhere. While the key is held, the link under the pointer is underlined
 * with a pointing cursor. Plain clicks place the cursor as usual.
 */
export function linkFollowing(getFollower: () => LinkFollower | undefined): Extension {
  return [
    hoverField,
    hoverTheme,
    ViewPlugin.define((view) => new LinkHover(view)),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !followKey(event)) return false;
        const link = linkAtCoords(view, event.clientX, event.clientY);
        const follow = getFollower();
        if (!link || !follow) return false;
        event.preventDefault();
        follow(link.href);
        return true;
      },
    }),
  ];
}
