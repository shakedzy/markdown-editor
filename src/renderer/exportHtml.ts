// String-level helpers for the exports (PDF, standalone HTML, rich-text
// clipboard): the document template, file names, and the CSS rewriting that
// makes collected app styles self-contained.

import { stripMarkdownExtension } from '../shared/fileTypes';
import { displayName } from './fileName';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The document's name without its markdown extension ("notes" for notes.md). */
export function documentName(filePath: string | null): string {
  return stripMarkdownExtension(displayName(filePath)) || 'Untitled';
}

/** The default file name for exporting the document as `ext` (e.g. "notes.html"). */
export function exportFileName(filePath: string | null, ext: string): string {
  return `${documentName(filePath)}.${ext}`;
}

export interface ExportDocument {
  title: string;
  css: string;
  /** Rendered markdown, placed inside a `.preview` wrapper so the preview styles apply. */
  body: string;
  /** More Content-Security-Policy directives for the page, on top of the script ban. */
  policy?: string;
}

// The exports are static pages: no script the document carries may run in
// them (the PDF is rendered from a local file that could read others).
const EXPORT_CSP = "script-src 'none'; object-src 'none'";

/**
 * `css` made safe to place in a <style> element: CSSOM turns escapes such as
 * `\3c/style\3e` back into plain text, and a `</` could end the element
 * early. In a string, which is where CSSOM writes one, `<\/` means the same.
 * (Escaping every `<` instead would break `@media (width < 600px)`.)
 */
export function styleElementText(css: string): string {
  return css.replace(/<\//g, '<\\/');
}

/** The light-themed page the PDF and HTML exports are built from. */
export function buildExportDocument({ title, css, body, policy }: ExportDocument): string {
  const csp = policy ? `${EXPORT_CSP}; ${policy}` : EXPORT_CSP;
  return `<!doctype html>
<html class="light" lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${styleElementText(css)}
</style>
</head>
<body>
<div class="preview">${body}</div>
</body>
</html>`;
}

/**
 * Split `text` at `separator`, ignoring separators inside quotes, parentheses
 * and brackets (`:is(a, b)`, `url("a,b")`, `[title="a;b"]`).
 */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const DOCUMENT_SELECTOR = /\.preview(?![\w-])|\.hljs/;
const MATH_SELECTOR = /\.katex/;
const GLOBAL_SELECTOR = /^(?::root|\*)$/;
const DARK_SELECTOR = /\.dark(?![\w-])/;

/**
 * Whether a style rule is needed to render the document on its own: preview
 * and syntax-highlighting rules, KaTeX's when the document has math, and the
 * `:root` variables. App chrome (toolbar, dialogs, the scroll-locked
 * html/body) and dark-theme variants are left out.
 */
export function isDocumentSelector(selectorText: string, opts: { math: boolean }): boolean {
  return splitTopLevel(selectorText, ',').some((raw) => {
    const sel = raw.trim();
    if (DARK_SELECTOR.test(sel)) return false;
    return (
      GLOBAL_SELECTOR.test(sel) ||
      DOCUMENT_SELECTOR.test(sel) ||
      (opts.math && MATH_SELECTOR.test(sel))
    );
  });
}

// url(...) with a double-quoted, single-quoted or bare target.
const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"'()\s]*))\s*\)/gi;

function mapCssUrls(css: string, fn: (url: string) => string | null): string {
  return css.replace(CSS_URL, (match, dq?: string, sq?: string, bare?: string) => {
    const quoted = dq ?? sq;
    const url = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : (bare ?? '');
    const next = fn(url);
    return next === null ? match : `url("${next.replace(/["\\]/g, '\\$&')}")`;
  });
}

// Leave alone: already-inlined data, and fragment references (`url(#clip)`).
const KEEP_URL = /^(?:data:|#)|^$/i;

/**
 * Resolve the relative url()s in `css` against `base` (the stylesheet's own
 * URL), so the rules still find their fonts once moved into another document.
 */
export function absolutizeCssUrls(css: string, base: string): string {
  return mapCssUrls(css, (url) => {
    if (KEEP_URL.test(url)) return null;
    try {
      return new URL(url, base).href;
    } catch {
      return null;
    }
  });
}

/** The distinct url() targets in `css` that still point somewhere (not data: or #fragment). */
export function cssUrls(css: string): string[] {
  const urls = new Set<string>();
  mapCssUrls(css, (url) => {
    if (!KEEP_URL.test(url)) urls.add(url);
    return null;
  });
  return Array.from(urls);
}

/** Point each url() found in `replacements` at its replacement (e.g. a data: URI). */
export function replaceCssUrls(css: string, replacements: ReadonlyMap<string, string>): string {
  return mapCssUrls(css, (url) => replacements.get(url) ?? null);
}

const WOFF2_SOURCE = /format\(\s*["']?woff2["']?\s*\)|\.woff2(?:[?#][^"')]*)?["']?\s*\)/i;

/**
 * Trim each @font-face `src` list to its woff2 entries, when it has any.
 * Every browser that opens the export reads woff2, so the woff/ttf fallbacks
 * would only add size once inlined.
 */
export function preferWoff2Sources(css: string): string {
  return css.replace(/@font-face\s*\{([^{}]*)\}/gi, (rule, body: string) => {
    const declarations = splitTopLevel(body, ';').map((decl) => {
      const colon = decl.indexOf(':');
      if (colon < 0 || decl.slice(0, colon).trim().toLowerCase() !== 'src') return decl;
      const sources = splitTopLevel(decl.slice(colon + 1), ',');
      const woff2 = sources.filter((s) => WOFF2_SOURCE.test(s));
      if (woff2.length === 0 || woff2.length === sources.length) return decl;
      return `${decl.slice(0, colon + 1)} ${woff2.map((s) => s.trim()).join(', ')}`;
    });
    return `${rule.slice(0, rule.indexOf('{') + 1)}${declarations.join(';')}}`;
  });
}

/**
 * Whether `url`, in a page opened from disk or a pasted document, loads from
 * another computer, which Windows reaches through its network share, signing
 * in with the user's credentials: a URL starting with two slashes or
 * backslashes (//host/…, \\host\share\…), which takes the page's file:, or a
 * file: URL naming a host or a network path (file://host/…, file:////host/…,
 * file:///%5C%5Chost/…). Read as Windows would, not as this platform's URL
 * parser does (which makes file:////host/… a local path).
 */
export function reachesOtherHost(url: string): boolean {
  // As a browser reads a URL: no spaces or control characters before it, no
  // tabs or newlines in it, and a backslash is a slash.
  const value = url
    .replace(/^[\0-\x20]+/, '')
    .replace(/[\t\n\r]/g, '')
    .replace(/\\/g, '/');
  if (value.startsWith('//')) return true;
  const file = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i.exec(value);
  if (!file) return false;
  // Each %-escape decoded on its own, so a literal "%" elsewhere hides none.
  const decode = (s: string) =>
    s.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const host = decode(file[1] ?? '').toLowerCase();
  return (host !== '' && host !== 'localhost') || /^[\\/]{2}/.test(decode(file[2] ?? ''));
}

// After CSS's own preprocessing, a newline is "\n" alone.
const CSS_WHITESPACE = /[ \t\n]/;
// Letters, digits, "_", "-", and anything beyond ASCII.
const CSS_NAME_CHAR = /[\w\-\u0080-\uffff]/;

/**
 * The url() targets in CSS text (a sheet, a declaration's value, a
 * presentation attribute), read as the browser's tokenizer reads them:
 * comments and strings skipped, escapes resolved (`u\72l(\2f\2f host/x)`
 * loads //host/x), and an unquoted url() one token, so a quote or a `/*`
 * inside it starts nothing.
 */
function cssReferences(css: string): string[] {
  const text = css.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\ufffd');
  const urls: string[] = [];
  let i = 0;
  const at = (offset = 0) => text[i + offset] ?? '';
  const isEscape = () => at() === '\\' && at(1) !== '\n';

  // The character the escape at `i` stands for, moving past it.
  const escape = (): string => {
    i++; // the backslash
    const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(i, i + 6))?.[0];
    if (hex === undefined) {
      const code = text.codePointAt(i);
      if (code === undefined) return '\ufffd';
      i += code > 0xffff ? 2 : 1;
      return String.fromCodePoint(code);
    }
    i += hex.length;
    if (CSS_WHITESPACE.test(at())) i++;
    const code = parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : '\ufffd';
  };
  const name = (): string => {
    let value = '';
    while (CSS_NAME_CHAR.test(at()) || isEscape()) value += isEscape() ? escape() : text[i++];
    return value;
  };
  // To its closing quote, or the end of its line when it has none.
  const string = (): string => {
    const quote = text[i++];
    let value = '';
    while (i < text.length && at() !== quote && at() !== '\n') {
      if (at() !== '\\') value += text[i++];
      else if (at(1) === '\n' || at(1) === '') i += 2; // a line continuation, or the end
      else value += escape();
    }
    if (at() === quote) i++;
    return value;
  };
  // An unquoted url(), to its ")". One with a space, quote or "(" inside
  // loads nothing; it ends at the same ")".
  const unquotedUrl = (): string => {
    let value = '';
    while (i < text.length && at() !== ')') value += isEscape() ? escape() : text[i++];
    i++;
    return value.replace(/[ \t\n]+$/, '');
  };

  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (at() === '"' || at() === "'") {
      string();
    } else if (CSS_NAME_CHAR.test(at()) || isEscape()) {
      if (!/^url$/i.test(name()) || at() !== '(') continue;
      i++;
      while (CSS_WHITESPACE.test(at())) i++;
      urls.push(at() === '"' || at() === "'" ? string() : unquotedUrl());
    } else {
      i++;
    }
  }
  return urls;
}

/**
 * Whether an export keeps a url() target: a data: URL, an https: one (as it
 * keeps web images), or a reference within the document (`url(#clip)`).
 * Anything else goes: a relative URL means another file once the export is
 * opened from disk, file: and mditor: ones name the user's files, and some
 * reach another computer (see reachesOtherHost).
 */
function isExportableCssUrl(url: string): boolean {
  // As a browser reads a URL: no spaces or control characters before it, no
  // tabs or newlines in it.
  const value = url.replace(/^[\0-\x20]+/, '').replace(/[\t\n\r]/g, '');
  return value === '' || /^(?:#|data:|https:)/i.test(value);
}

// The functions besides url() that load what they're given, a string
// included, and var(), which can hand them anything (a custom property's
// string to image-set(), say). Prefixed ones (-webkit-image-set()…) end the
// same.
const CSS_LOADING_FUNCTION = /(?:var|src|image|image-set|cross-fade|element|paint)\(/i;

/**
 * Whether an export keeps CSS text (a declaration's value, a presentation
 * attribute, a rule with no declarations): only url()s it keeps (see
 * isExportableCssUrl), none of the functions above, and, in text with a
 * "(", no escape, which could spell a function's name (CSSOM writes a value
 * holding a var() as given, `v\61r(…)` included). With no "(" nothing is
 * called, and an escape is only text: CSSOM writes `content: '"'` as
 * `content: "\""`. Rather than follow what a var() or a string may lead to,
 * an export goes without.
 */
export function isExportableCss(css: string): boolean {
  return (
    !(css.includes('\\') && css.includes('(')) &&
    !CSS_LOADING_FUNCTION.test(css) &&
    cssReferences(css).every(isExportableCssUrl)
  );
}

/** Whether `url` is the user's local media, as the preview serves it (mditor://). */
export function isLocalMediaUrl(url: string): boolean {
  return /^mditor:/i.test(url);
}

/**
 * The file: URL for a preview mditor://local URL: the next best thing when a
 * file can't be embedded, and works when the export is opened on this
 * machine. Null for a network path (\\host\share\…), which main won't read
 * and which opening the export would have Windows sign in to.
 */
export function localFileUrl(url: string): string | null {
  const fileUrl = url.replace(/^mditor:\/\/[^/]*\//i, 'file:///');
  return reachesOtherHost(fileUrl) ? null : fileUrl;
}

/** The width and height a viewBox ("minX minY width height") gives an SVG, if valid. */
export function viewBoxSize(viewBox: string | null): { width: number; height: number } | null {
  const parts = viewBox?.trim().split(/[\s,]+/).map(Number);
  if (!parts || parts.length !== 4) return null;
  const [, , width, height] = parts as [number, number, number, number];
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
    ? { width, height }
    : null;
}

const MONOSPACE = '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const BORDER = '#d1d9e0';
const SOFT_BG = '#f6f8fa';

/**
 * Inline styles for rich-text pastes. Mail clients, Docs, Slack, Notion and
 * Confluence drop <style> blocks, so the formatting that carries meaning is
 * written onto the elements, in the light theme, in this order.
 */
export const RICH_TEXT_STYLES: ReadonlyArray<readonly [selector: string, style: string]> = [
  ['code', `font-family: ${MONOSPACE}; font-size: 0.9em; background-color: ${SOFT_BG}; border-radius: 4px; padding: 0.15em 0.35em;`],
  ['pre', `font-family: ${MONOSPACE}; font-size: 0.9em; line-height: 1.45; background-color: ${SOFT_BG}; border-radius: 6px; padding: 12px 16px; white-space: pre-wrap; overflow-wrap: anywhere;`],
  ['pre code', 'font-size: 1em; background-color: transparent; border-radius: 0; padding: 0;'],
  ['blockquote', `margin: 0.8em 0; padding: 0 1em; border-left: 4px solid ${BORDER}; color: #59636e;`],
  ['table', 'border-collapse: collapse;'],
  ['th, td', `border: 1px solid ${BORDER}; padding: 6px 12px;`],
  ['th', `background-color: ${SOFT_BG}; font-weight: 600;`],
  ['hr', `border: none; border-top: 1px solid ${BORDER};`],
  ['img', 'max-width: 100%; height: auto;'],
  ['.markdown-alert', `margin: 1em 0; padding: 8px 16px; border-left: 4px solid ${BORDER}; background-color: ${SOFT_BG};`],
  ['.markdown-alert-title', 'font-weight: 600;'],
  ...(
    [
      ['note', '#1f6feb'],
      ['tip', '#1a7f37'],
      ['important', '#8250df'],
      ['warning', '#9a6700'],
      ['caution', '#cf222e'],
    ] as const
  ).flatMap(([kind, color]) => [
    [`.markdown-alert-${kind}`, `border-left-color: ${color};`] as const,
    [`.markdown-alert-${kind} .markdown-alert-title`, `color: ${color};`] as const,
  ]),
];

/** Properties copied from the light syntax-highlighting rules onto code tokens. */
export const SYNTAX_PROPERTIES = ['color', 'background-color', 'font-weight', 'font-style'] as const;
