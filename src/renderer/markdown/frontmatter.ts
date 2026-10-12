import { parseDocument, stringify } from 'yaml';
import { escapeHtml } from '../exportHtml';

// YAML front matter: a block at the very start of the document, opened by a
// `---` line and closed by a `---` or `...` line (the Jekyll/Hugo/GitHub
// convention). The editor's parser and the preview both use these rules, so
// they agree on where the markdown body starts; the TOC and task-checkbox
// mappings depend on the Nth heading/checkbox being the same on both sides.

export interface FrontMatterBounds {
  /** End of the opening `---` and any trailing blanks, before the line break. */
  openTo: number;
  /** Start of the YAML: the line after the opening `---`. */
  contentFrom: number;
  /** Start of the closing line (so the YAML ends with its line break). */
  closeFrom: number;
  /** End of the closing delimiter and any trailing blanks, before the line break. */
  closeTo: number;
  /** Where the body starts: after the closing line's line break. */
  end: number;
}

export interface SplitFrontMatter {
  /** Raw YAML between the delimiters, or null when there is no front matter. */
  data: string | null;
  body: string;
  /** Source lines consumed before the body (body line N is source line N + this). */
  bodyLineOffset: number;
}

// A leading BOM is tolerated since Windows editors like to add one.
const OPENER = /^\uFEFF?---[ \t]*(\r\n|\r|\n|$)/;
const CLOSER = /(?:\r\n|\r|\n)((?:---|\.\.\.)[ \t]*)(\r\n|\r|\n|$)/g;
const LINE_BREAK = /\r\n|\r|\n/g;

/** Whether `src` starts with a front-matter opening line (closed or not). */
export function opensFrontMatter(src: string): boolean {
  return OPENER.test(src);
}

/** Locate the front matter at the start of `src`; null if there is none or it's never closed. */
export function findFrontMatter(src: string): FrontMatterBounds | null {
  const open = OPENER.exec(src);
  if (!open || !open[1]) return null;
  const openTo = open[0].length - open[1].length;
  // Start the search on the opener's line break so an empty block (`---` right
  // after the opener) is found too.
  CLOSER.lastIndex = openTo;
  const close = CLOSER.exec(src);
  if (!close) return null;
  const closeFrom = close.index + close[0].length - close[1].length - close[2].length;
  const closeTo = closeFrom + close[1].length;
  return {
    openTo,
    contentFrom: open[0].length,
    closeFrom,
    closeTo,
    end: closeTo + close[2].length,
  };
}

export function splitFrontMatter(src: string): SplitFrontMatter {
  const fm = findFrontMatter(src);
  if (!fm) return { data: null, body: src, bodyLineOffset: 0 };
  const consumed = src.slice(0, fm.end);
  let lines = consumed.match(LINE_BREAK)?.length ?? 0;
  // A closing line at the very end of the file has no line break of its own.
  if (fm.end === fm.closeTo) lines++;
  return {
    data: src.slice(fm.contentFrom, fm.closeFrom),
    body: src.slice(fm.end),
    bodyLineOffset: lines,
  };
}

type Scalar = string | number | boolean | bigint | Date | null | undefined;

function isScalar(value: unknown): value is Scalar {
  return value === null || value instanceof Date || typeof value !== 'object';
}

function scalarText(value: Scalar): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function renderValue(value: unknown): string {
  if (isScalar(value)) return escapeHtml(scalarText(value));
  if (Array.isArray(value) && value.every(isScalar)) {
    return value
      .map((v) => `<span class="frontmatter-chip">${escapeHtml(scalarText(v))}</span>`)
      .join('');
  }
  const compact = stringify(value, { collectionStyle: 'flow', lineWidth: 0 }).trim();
  return `<code>${escapeHtml(compact)}</code>`;
}

function details(inner: string): string {
  // No headings in here: the preview maps the Nth rendered h1-h6 to the Nth
  // heading in the editor's TOC.
  return `<details class="frontmatter" open><summary>Front matter</summary>${inner}</details>\n`;
}

/**
 * The preview block for a front matter's raw YAML: a key/value table for a
 * mapping, the raw text (with the parser's message) when it isn't valid YAML,
 * and nothing when it's empty.
 */
export function renderFrontMatter(yaml: string): string {
  const raw = `<pre><code>${escapeHtml(yaml)}</code></pre>`;
  let value: unknown;
  try {
    const doc = parseDocument(yaml);
    const error = doc.errors[0];
    if (error) {
      const message = error.message.split('\n')[0] ?? '';
      return details(`<p class="frontmatter-error">Invalid YAML: ${escapeHtml(message)}</p>${raw}`);
    }
    value = doc.toJS();
  } catch (err) {
    // toJS() throws on e.g. excessive alias expansion.
    return details(`<p class="frontmatter-error">${escapeHtml((err as Error).message)}</p>${raw}`);
  }

  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return details(raw);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '';
  const rows = entries
    .map(([key, v]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${renderValue(v)}</td></tr>`)
    .join('');
  return details(`<table><tbody>${rows}</tbody></table>`);
}
