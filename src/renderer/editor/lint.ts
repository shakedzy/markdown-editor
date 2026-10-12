import { Compartment, EditorState, Extension, Facet, StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  Diagnostic,
  closeLintPanel,
  diagnosticCount,
  forEachDiagnostic,
  forceLinting,
  lintGutter,
  lintKeymap,
  linter,
  openLintPanel,
  setDiagnosticsEffect,
} from '@codemirror/lint';
import type { SyntaxNode } from '@lezer/common';
import { slug } from 'github-slugger';
import { MAX_PATH_CHECKS } from '../../shared/types';
import { extractHeadings } from '../markdown/headings';
import { decodeLinkPath, linkDestination, normalizeLabel, stripUserContent } from '../links';

/** Whether a linked file exists: true or false once checked, undefined until then. */
export type FileStatus = (relativePath: string) => boolean | undefined;

export interface MarkdownLintResult {
  diagnostics: Diagnostic[];
  /** Relative link targets `fileStatus` didn't know yet: check them and lint again. */
  unknownPaths: string[];
}

export interface LintCounts {
  warnings: number;
  /** Suggestions (info), such as a missing alt text. */
  infos: number;
}

// The whole tree is needed to know every heading and link definition; a
// document too large to parse in this time is linted as far as it got.
const PARSE_BUDGET_MS = 1000;
// More would only bury the useful ones, and slow the list down.
const MAX_DIAGNOSTICS = 1000;

// Never part of the text a reader follows links in.
const SKIPPED_NODES = new Set([
  'Frontmatter',
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'Comment',
  'CommentBlock',
  'ProcessingInstructionBlock',
]);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
const HTML_TAG = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
const HTML_ID = /\s(id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
// GFM footnote definitions, which CommonMark parses as (part of) a paragraph.
const FOOTNOTE_DEFINITION = /^[\s>]*\[\^([^\]\s]+)\]:/gm;
// marked-footnote's ids (footnote-, footnote-ref-), and GitHub's.
const FOOTNOTE_ID = /^(?:footnote-(?:ref-)?|fnref-?|fn-?)(.+?)(?:-\d+)?$/;

/**
 * The relative file a link destination points at, to check for: decoded, as
 * the preview, link following and GitHub read it (`my%20file.png` is "my
 * file.png"). An image's is then read as the preview's resolveAsset reads it,
 * a backslash as a slash (`sub\x.png` is sub/x.png). Null when it isn't a
 * relative file link: a URL with a scheme, a fragment of this document, a
 * path from the root (for an image, once decoded: `%5C%5Chost\x.png`), or one
 * with an HTML entity this doesn't decode.
 */
export function relativeFilePath(destination: string, image = false): string | null {
  const path = destination.trim().replace(/[?#][^]*$/, '');
  if (!path || SCHEME.test(path) || /^[\\/]/.test(path) || ENTITY.test(path)) return null;
  if (!image) return decodeLinkPath(path);
  const file = decodeLinkPath(path).replace(/\\/g, '/');
  return file.startsWith('/') || /^[a-z]:/i.test(file) ? null : file;
}

/** Adds the ids raw HTML gives elements: `id` on any tag, and `name` on <a>. */
export function collectHtmlIds(html: string, ids: Set<string>): void {
  for (const [, tag, attributes] of html.matchAll(HTML_TAG)) {
    for (const [, attribute, ...values] of attributes.matchAll(HTML_ID)) {
      if (attribute.toLowerCase() === 'name' && tag.toLowerCase() !== 'a') continue;
      const value = values.find((v) => v !== undefined);
      if (value) ids.add(value);
    }
  }
}

interface PendingCheck {
  from: number;
  to: number;
  name: string;
}

/**
 * The document's lint warnings: broken in-document anchors, relative links
 * and images whose file is missing (only with `fileStatus`, i.e. once the
 * document is saved), empty link destinations, images without alt text,
 * undefined reference links, and skipped heading levels. Code, HTML
 * comments and front matter are left alone.
 */
export function lintMarkdown(
  state: EditorState,
  fileStatus: FileStatus | null,
): MarkdownLintResult {
  const { doc } = state;
  const text = (from: number, to: number) => doc.sliceString(from, to);
  const full = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS);
  const tree = full ?? syntaxTree(state);
  // Headings and definitions may lie in a part not parsed yet; the checks
  // that need all of them wait until the parse is complete. (The tree's
  // length doesn't tell: the front matter wrapper always spans the document.)
  const whole = full !== null;

  const diagnostics: Diagnostic[] = [];
  const unknownPaths = new Set<string>();
  const targets = new Set<string>();
  const definitions = new Set<string>();
  const footnotes = new Set<string>();
  const anchors: PendingCheck[] = [];
  const references: PendingCheck[] = [];

  const checkDestination = (url: SyntaxNode, image: boolean) => {
    const destination = linkDestination(text(url.from, url.to));
    if (destination.startsWith('#')) {
      anchors.push({ from: url.from, to: url.to, name: destination.slice(1) });
      return;
    }
    const file = fileStatus ? relativeFilePath(destination, image) : null;
    if (!fileStatus || file === null) return;
    const status = fileStatus(file);
    if (status === undefined) unknownPaths.add(file);
    if (status !== false) return;
    diagnostics.push({
      from: url.from,
      to: url.to,
      severity: 'warning',
      message: `${image ? 'Image' : 'File'} not found: ${file}`,
    });
  };

  const lintLink = (node: SyntaxNode) => {
    const image = node.name === 'Image';
    // [text] or ![alt], then (destination), [label], [] or nothing.
    const [open, close, paren] = node.getChildren('LinkMark');
    if (!open || !close) return;
    const content = text(open.to, close.from);
    const label = node.getChild('LinkLabel');
    if (paren && text(paren.from, paren.to) === '(') {
      const url = node.getChild('URL');
      if (!url || !linkDestination(text(url.from, url.to)).trim()) {
        diagnostics.push({
          from: paren.from,
          to: node.to,
          severity: 'warning',
          message: image ? 'Image has no source' : 'Link has no destination',
        });
        return;
      }
      checkDestination(url, image);
    } else if (label) {
      // [text][label], or [label][] whose text is the label.
      const collapsed = label.to - label.from <= 2;
      const name = collapsed ? content : text(label.from + 1, label.to - 1);
      // A footnote is GFM's, not a link reference.
      if (!name.startsWith('^')) {
        references.push({ from: collapsed ? open.from : label.from, to: label.to, name });
      }
    } else {
      // A shortcut [text]: also how task boxes, footnotes and plain brackets parse.
      return;
    }
    if (image && !content.trim()) {
      diagnostics.push({
        from: open.from,
        to: close.to,
        severity: 'info',
        message: 'Image has no alt text',
      });
    }
  };

  tree.iterate({
    enter(node) {
      if (SKIPPED_NODES.has(node.name)) return false;
      switch (node.name) {
        case 'HTMLBlock':
        case 'HTMLTag':
          collectHtmlIds(text(node.from, node.to), targets);
          return false;
        case 'Paragraph':
          for (const [, label] of text(node.from, node.to).matchAll(FOOTNOTE_DEFINITION)) {
            footnotes.add(label);
          }
          return;
        case 'LinkReference': {
          const label = node.node.getChild('LinkLabel');
          const name = label ? text(label.from + 1, label.to - 1) : '';
          if (name.startsWith('^')) {
            footnotes.add(name.slice(1));
            return false;
          }
          definitions.add(normalizeLabel(name));
          const url = node.node.getChild('URL');
          if (url) checkDestination(url, false);
          return false;
        }
        case 'Link':
        case 'Image':
          // Not done: a link may hold an image.
          lintLink(node.node);
          return;
      }
    },
  });

  if (whole) {
    let previousLevel = 0;
    for (const heading of extractHeadings(state)) {
      targets.add(heading.slug);
      if (previousLevel && heading.level > previousLevel + 1) {
        diagnostics.push({
          from: heading.pos,
          to: doc.lineAt(heading.pos).to,
          severity: 'info',
          message: `Heading level skipped (H${previousLevel} → H${heading.level})`,
        });
      }
      previousLevel = heading.level;
    }

    const isFootnoteTarget = (id: string) => {
      if (!footnotes.size) return false;
      if (id === 'footnote-label') return true;
      const match = FOOTNOTE_ID.exec(id);
      return !!match && (footnotes.has(match[1]) || footnotes.has(decodeLinkPath(match[1])));
    };
    for (const { from, to, name } of anchors) {
      const id = stripUserContent(decodeLinkPath(name));
      const found = targets.has(id) || targets.has(name) || isFootnoteTarget(id);
      if (!id || /^top$/i.test(id) || found) continue;
      const suggestion = slug(id);
      const fix = suggestion !== id && targets.has(suggestion) ? suggestion : null;
      diagnostics.push({
        from,
        to,
        severity: 'warning',
        message:
          `No heading or anchor “#${name}” in this document` +
          (fix ? `. Did you mean “#${fix}”?` : ''),
        actions: fix
          ? [
              {
                name: `Use #${fix}`,
                apply: (view, from, to) =>
                  view.dispatch({ changes: { from, to, insert: `#${fix}` }, userEvent: 'input' }),
              },
            ]
          : undefined,
      });
    }

    for (const { from, to, name } of references) {
      if (definitions.has(normalizeLabel(name))) continue;
      diagnostics.push({
        from,
        to,
        severity: 'warning',
        message: `No definition for the reference “${name.trim()}”`,
      });
    }
  }

  diagnostics.sort((a, b) => a.from - b.from);
  return {
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    unknownPaths: [...unknownPaths],
  };
}

const LINT_DELAY_MS = 500;
// How long a file check is trusted before lint asks again; the old answer
// shows meanwhile, so nothing flickers.
const FILE_CHECK_TTL_MS = 10_000;

/** The document's file, which relative links are checked against; null while untitled. */
const documentPath = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

const filesChecked = StateEffect.define<null>();

/**
 * Which linked files exist, as main last answered, for one editor. Main
 * resolves the paths against the document it has open in the window, and
 * answers nothing when that isn't `documentPath` (the two are switching).
 */
class LinkedFiles {
  private path: string | null;
  private readonly known = new Map<string, { exists: boolean; at: number }>();
  private readonly asking = new Set<string>();
  /** Paths the last lint looked up: what to check again when the window comes back. */
  private used = new Set<string>();
  private stale = new Set<string>();
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.path = view.state.facet(documentPath);
    window.addEventListener('focus', this.onFocus);
  }

  update(update: ViewUpdate): void {
    const path = update.state.facet(documentPath);
    if (path === this.path) return;
    this.path = path;
    this.known.clear();
    this.asking.clear();
    this.used.clear();
  }

  /** The status of linked files for one lint run; null while untitled. */
  lookup(): FileStatus | null {
    if (!this.path) return null;
    const now = Date.now();
    this.used = new Set();
    this.stale = new Set();
    return (relativePath) => {
      this.used.add(relativePath);
      const entry = this.known.get(relativePath);
      if (entry && now - entry.at > FILE_CHECK_TTL_MS) this.stale.add(relativePath);
      return entry?.exists;
    };
  }

  /** After a lint run: ask about the paths it didn't know, and the ones known a while. */
  verify(unknownPaths: readonly string[]): void {
    // Only the links the document has now (not every path typed on the way).
    for (const path of this.known.keys()) if (!this.used.has(path)) this.known.delete(path);
    this.ask([...unknownPaths, ...this.stale]);
  }

  // Files may have been added or removed while the user was in another app.
  private readonly onFocus = () => this.ask([...this.used]);

  private ask(paths: readonly string[]): void {
    const documentPath = this.path;
    const batch = [...new Set(paths)]
      .filter((p) => !this.asking.has(p))
      .slice(0, MAX_PATH_CHECKS);
    if (!documentPath || !batch.length) return;
    batch.forEach((p) => this.asking.add(p));
    const settle = (answer: boolean[] | null) => {
      if (this.destroyed || this.path !== documentPath) return;
      batch.forEach((p) => this.asking.delete(p));
      if (!answer) return;
      const now = Date.now();
      let changed = false;
      batch.forEach((p, i) => {
        const exists = answer[i] !== false;
        if (this.known.get(p)?.exists !== exists) changed = true;
        this.known.set(p, { exists, at: now });
      });
      if (changed) {
        this.view.dispatch({ effects: filesChecked.of(null) });
        forceLinting(this.view);
      }
    };
    window.api.pathsExist({ documentPath, paths: batch }).then(settle, () => settle(null));
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('focus', this.onFocus);
  }
}

const linkedFiles = ViewPlugin.fromClass(LinkedFiles);

function lintSource(view: EditorView): Diagnostic[] {
  const files = view.plugin(linkedFiles);
  const { diagnostics, unknownPaths } = lintMarkdown(view.state, files?.lookup() ?? null);
  files?.verify(unknownPaths);
  return diagnostics;
}

const markdownLinter: Extension = [
  linter(lintSource, {
    delay: LINT_DELAY_MS,
    // Edits relint anyway; so do a new file name and answers about files.
    needsRefresh: (update) =>
      update.startState.facet(documentPath) !== update.state.facet(documentPath) ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(filesChecked))),
  }),
  lintGutter(),
  // Mod-Shift-m lists the warnings, F8 goes to the next one. Escape closes
  // the list from the text too (its own Escape works only with focus in it).
  keymap.of([...lintKeymap, { key: 'Escape', run: closeLintPanel }]),
  linkedFiles,
];

const lintCompartment = new Compartment();
const pathCompartment = new Compartment();

/**
 * Markdown lint warnings, `enabled` to start with, with relative links
 * checked against `path` (null: untitled). Change either with
 * setMarkdownLint.
 */
export function markdownLint(enabled: boolean, path: string | null): Extension {
  return [
    lintCompartment.of(enabled ? markdownLinter : []),
    pathCompartment.of(documentPath.of(path)),
  ];
}

/** Turn lint on or off in a running editor, or point it at the document's new file. */
export function setMarkdownLint(view: EditorView, enabled: boolean, path: string | null): void {
  const effects: StateEffect<unknown>[] = [];
  if ((lintCompartment.get(view.state) === markdownLinter) !== enabled) {
    effects.push(lintCompartment.reconfigure(enabled ? markdownLinter : []));
  }
  if (view.state.facet(documentPath) !== path) {
    effects.push(pathCompartment.reconfigure(documentPath.of(path)));
  }
  if (effects.length) view.dispatch({ effects });
}

/** Show the list of lint warnings below the editor, or hide it again (unless `open`). */
export function toggleLintPanel(view: EditorView, open = false): void {
  if (!open && closeLintPanel(view)) view.focus();
  // Opening it with lint off would switch lint's display on for good.
  else if (view.plugin(linkedFiles)) openLintPanel(view);
}

/** How many warnings and suggestions the editor shows. */
export function lintCounts(state: EditorState): LintCounts {
  let warnings = 0;
  let infos = 0;
  forEachDiagnostic(state, (d) => {
    if (d.severity === 'warning' || d.severity === 'error') warnings++;
    else infos++;
  });
  return { warnings, infos };
}

/** Whether lintCounts may have changed: new results, edits that removed some, lint switched off. */
export function lintCountsChanged(update: ViewUpdate): boolean {
  return (
    update.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect))) ||
    diagnosticCount(update.startState) !== diagnosticCount(update.state)
  );
}
