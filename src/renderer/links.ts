import type { Heading } from './markdown/headings';
import { isMarkdownPath } from '../shared/fileTypes';

/** Where a link in the document leads, which decides how following it works. */
export type LinkTarget =
  /** An element of this document (`#intro`, a footnote); '' is its top. */
  | { kind: 'anchor'; fragment: string }
  /** A web page or e-mail address, for the browser or mail app. */
  | { kind: 'external'; url: string }
  /** A Markdown file (absolute path) to show in the editor, then scroll to `fragment` ('' for none). */
  | { kind: 'document'; path: string; fragment: string }
  /** Another local file or folder, for main to open: as written, relative to the document or absolute. */
  | { kind: 'file'; target: string }
  /** A relative path in a document that has no folder yet. */
  | { kind: 'untitled' }
  /** Nothing the app follows: another app's scheme, a protocol-relative URL, another network share, an empty link. */
  | { kind: 'unsupported' };

const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// The prefix of a device path to a share (\\.\UNC\host\share or \\?\UNC\…).
const DEVICE_UNC = /^[\\/]{2}[?.][\\/]unc(?=[\\/])/i;

/** A link's path with its %-escapes decoded ("my%20notes.md" is "my notes.md"). */
export function decodeLinkPath(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A literal "%" (100%.md) isn't an escape.
    return text;
  }
}

/** Markdown text with its backslash escapes resolved (`\(` is "("; `\a` stays as is). */
export function unescapeLinkText(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** A link destination as the link means it: no <angle brackets>, backslash escapes resolved. */
export function linkDestination(raw: string): string {
  const inner = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  return unescapeLinkText(inner);
}

/** A link label compared the way marked matches references to definitions. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A #fragment without the "user-content-" prefix GitHub gives the ids it renders. */
export function stripUserContent(fragment: string): string {
  return fragment.replace(/^user-content-/, '');
}

interface Rooted {
  root: string;
  rest: string;
}

// The root of an absolute path ("/", "C:\", "\\server\share\") and the rest.
function splitRoot(p: string, windows: boolean): Rooted | null {
  if (!windows) return p.startsWith('/') ? { root: '/', rest: p } : null;
  const unc = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.exec(p);
  if (unc) return { root: `${unc[0].replace(/\//g, '\\')}\\`, rest: p.slice(unc[0].length) };
  const drive = /^[a-z]:(?=[\\/])/i.exec(p);
  return drive ? { root: `${drive[0]}\\`, rest: p.slice(2) } : null;
}

/**
 * The absolute path a link's `target` (decoded; relative to the document at
 * `docPath`, or absolute) names, with "." and ".." resolved; null when it is
 * relative and the document has no folder.
 */
export function resolveLinkPath(
  docPath: string | null,
  target: string,
  windows: boolean,
): string | null {
  const parts = (p: string) => p.split(windows ? /[\\/]/ : '/');
  const doc = docPath === null ? null : splitRoot(docPath, windows);
  const own = splitRoot(target, windows);
  let root: string;
  let segments: string[];
  if (own) {
    root = own.root;
    segments = parts(own.rest);
  } else if (windows && /^[\\/]/.test(target)) {
    // "\file": the root of the document's drive.
    if (!doc) return null;
    root = doc.root;
    segments = parts(target);
  } else {
    if (!doc) return null;
    root = doc.root;
    segments = [...parts(doc.rest).slice(0, -1), ...parts(target)];
  }
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '..') resolved.pop();
    else if (segment !== '' && segment !== '.') resolved.push(segment);
  }
  return root + resolved.join(windows ? '\\' : '/');
}

/**
 * What following `href` (a link destination as the link means it: no angle
 * brackets, backslash escapes resolved) does from the document at `docPath`
 * (null: untitled). Paths may be percent-encoded ("my%20notes.md"), as on
 * GitHub; a query ("?raw=1") is ignored.
 */
export function classifyLink(href: string, docPath: string | null, windows: boolean): LinkTarget {
  const link = href.trim();
  if (link.startsWith('#')) return { kind: 'anchor', fragment: decodeLinkPath(link.slice(1)) };
  // Protocol-relative ("//host/page"): there's no web page here to be relative to.
  if (!link || link.startsWith('//')) return { kind: 'unsupported' };
  // A scheme, unless it is a Windows drive ("C:\notes").
  const scheme = splitRoot(link, windows) ? null : SCHEME.exec(link)?.[1]?.toLowerCase();
  if (scheme) {
    return EXTERNAL_SCHEMES.has(scheme) ? { kind: 'external', url: link } : { kind: 'unsupported' };
  }
  const hash = link.indexOf('#');
  const fragment = hash < 0 ? '' : decodeLinkPath(link.slice(hash + 1));
  const target = decodeLinkPath(link.slice(0, hash < 0 ? undefined : hash).replace(/\?.*$/, ''));
  if (!target) return { kind: 'anchor', fragment };
  const path = resolveLinkPath(docPath, target, windows);
  if (path === null) return { kind: 'untitled' };
  // A Windows network path (\\host\share) has the OS connect to that host and
  // sign in to it. Only the document's own share is followed; a device path
  // to a share (\\.\UNC\host\share\…) is on that share, not on "\\.\UNC".
  if (windows && path.startsWith('\\\\')) {
    const share = (p: string | null) =>
      (p && splitRoot(p.replace(DEVICE_UNC, '\\'), true)?.root.toLowerCase()) ?? null;
    if (share(path) !== share(docPath)) return { kind: 'unsupported' };
  }
  return isMarkdownPath(target)
    ? { kind: 'document', path, fragment }
    : { kind: 'file', target };
}

/**
 * The index of the heading a link's #fragment names, by its GitHub-style
 * slug ("#user-content-…" and other letter cases too); -1 if none does.
 */
export function headingIndexForFragment(headings: readonly Heading[], fragment: string): number {
  const slug = stripUserContent(fragment);
  const exact = headings.findIndex((h) => h.slug === slug);
  if (exact >= 0) return exact;
  const lower = slug.toLowerCase();
  return headings.findIndex((h) => h.slug === lower);
}
