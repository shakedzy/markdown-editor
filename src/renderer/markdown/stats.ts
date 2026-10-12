import { splitFrontMatter } from './frontmatter';

// Word / character counts and reading time for the status bar: plain string
// work, no DOM or CodeMirror.

export interface TextStats {
  words: number;
  characters: number;
}

export interface TextStatsOptions {
  /**
   * Skip a leading YAML front matter block when counting words. Off for text
   * that doesn't start at the top of the document (e.g. a selection).
   */
  frontMatter?: boolean;
  /**
   * Where the body starts in text that begins inside the front matter (a
   * selection from there): words before it aren't counted.
   */
  bodyFrom?: number;
}

export const WORDS_PER_MINUTE = 238;

export function textStats(text: string, opts: TextStatsOptions = {}): TextStats {
  const prose = opts.bodyFrom ? text.slice(opts.bodyFrom) : text;
  return { words: countWords(prose, opts), characters: countCharacters(text) };
}

/** "< 1 min read" / "6 min read", or null for an empty text. */
export function readingTime(words: number): string | null {
  if (words <= 0) return null;
  if (words < WORDS_PER_MINUTE) return '< 1 min read';
  return `${Math.ceil(words / WORDS_PER_MINUTE)} min read`;
}

const numberFormat = new Intl.NumberFormat();

export function formatCount(n: number): string {
  return numberFormat.format(n);
}

/** `n` and its noun, plural unless one: "1 word", "1,024 words". */
export function counted(n: number, noun: string): string {
  return `${formatCount(n)} ${noun}${n === 1 ? '' : 's'}`;
}

// --- Words ------------------------------------------------------------------

// Fences are matched at any indentation (and inside blockquotes) so code in
// list items is skipped too.
const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/;
const INDENTED = /^(?: {4}| {0,3}\t)/;
const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
// `[label]: url "title"` renders nothing. Footnote definitions (`[^1]: …`) do.
const REF_DEFINITION =
  /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
// Ordered-list numbers and task checkboxes would otherwise count as words.
const BLOCK_PREFIX = /^(\s*(?:>\s*)*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
// Inline code, which can show `<!--` without starting a comment.
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
// A comment that starts its line, or its list item, is an HTML block: it runs
// on to later lines, past blank ones.
const COMMENT_BLOCK = /^ {0,3}(?:>\s*)*<!--$/;
// A line that ends a paragraph, and with it any inline comment left open.
const PARAGRAPH_END = /^[\s>]*$/;
// A line that starts another block, which also ends the paragraph: a fence,
// ATX heading, list item, thematic break or setext underline. Matched at any
// indentation, like FENCE: stopping early only keeps a few words, while
// running past a fence would swap code and prose after it.
const BLOCK_START =
  /^\s*(?:>\s*)*(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|(?:[-*+]|\d{1,9}[.)])(?:\s|$)|(?:[-*_][ \t]*){3,}$|(?:=+|-+)[ \t]*$)/;
// An ordered item numbered past 1, which can't start a list mid-paragraph.
const LATER_ITEM = /^\s*(?:>\s*)*(?!1[.)])\d{1,9}[.)]/;
// A table's delimiter row (`| --- | :-: |`). It and the header row above it
// end a paragraph; a lone `|` line doesn't.
const TABLE_DELIMITER =
  /^(?=.*[|:])\s*(?:>\s*)*(?:\|[ \t]*)?:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// The HTML blocks that can interrupt a paragraph in marked: a comment or one
// of these tags (CommonMark types 1, 2 and 6). An inline tag like `<b>` can't.
const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|' +
  'details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|' +
  'h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|' +
  'ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|' +
  'textarea|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_START = new RegExp(
  `^\\s*(?:>\\s*)*<(?:!--|/?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$))`,
  'i',
);
// Headings and table rows are one line each, so a comment can't run on.
const ONE_LINE_BLOCK = /^\s*(?:>\s*)*(?:#{1,6}(?:\s|$)|\|)/;
const QUOTE_PREFIX = /^\s*(?:>\s*)*/;

// Inline syntax, applied to the prose that survives the block scan. Link
// destinations stay on one line and allow one level of nested parentheses.
const FOOTNOTE_REF = /\[\^[^\]\s]+\]:?/g;
const IMAGE = /!\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^[\]]*\])/g;
const LINK = /\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^[\]]*\])/g;
const AUTOLINK = /<(?:[a-z][a-z\d+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/gi;
// A scheme is read for at most 32 characters, and an address only where its
// name starts (not inside a run of name characters), so a long run with no
// `://` or `@` (a hex or base64 blob) isn't read to its end again from each
// of its characters.
const BARE_URL =
  /\b(?:[a-z][a-z\d+.-]{0,31}:\/\/|www\.)[^\s<>]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
const HTML_TAG = /<\/?[a-z][a-z\d-]*(?:\s[^<>]*)?\/?>/gi;
const ENTITY = /&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/gi;

// Scripts written without spaces between words: each ideograph, kana or
// hangul syllable counts as one word. U+30FC/U+FF70 (the kana length mark) are
// Common script, so they're listed explicitly.
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\uFF70]+/gu;
// Letters/numbers, joined by internal apostrophes, hyphens and underscores
// ("don't", "well-known", "snake_case"), and digit groups ("3.14", "1,000").
const WORD =
  /[\p{L}\p{M}\p{N}]+(?:(?:['\u2019\u2010\u2011_-]|(?<=\p{N})[.,:](?=\p{N}))[\p{L}\p{M}\p{N}]+)*/gu;

/**
 * Words as a reader of the rendered document would count them: front matter,
 * code blocks, HTML comments and tags, link/image URLs and markdown syntax are
 * left out; link text and image alt text are kept. A bare URL counts as one.
 */
export function countWords(text: string, opts: TextStatsOptions = {}): number {
  const body = opts.frontMatter ? splitFrontMatter(text).body : text;
  const prose = proseLines(body)
    .join('\n')
    .replace(FOOTNOTE_REF, ' ')
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(AUTOLINK, ' url ')
    .replace(BARE_URL, ' url ')
    .replace(HTML_TAG, ' ')
    .replace(ENTITY, ' ');

  let words = 0;
  const rest = prose.replace(CJK_RUN, (run) => {
    words += codePointLength(run);
    return ' ';
  });
  WORD.lastIndex = 0;
  while (WORD.exec(rest)) words++;
  return words;
}

// The lines that render as prose, with block-level markers stripped. A line
// scan rather than a full markdown parse keeps this fast on huge documents.
function proseLines(text: string): string[] {
  const out: string[] = [];
  let fenceChar = '';
  let fenceLen = 0;
  let inComment = false;
  let inIndentedCode = false;
  let inList = false;
  let prevBlank = true;
  // Openers before this line have no `-->` left in their paragraph (a
  // lookahead found none), so they needn't look again.
  let paragraphEnd = 0;

  const lines = text.split(/\r\n?|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (fenceLen) {
      const close = FENCE.exec(line);
      const marker = close?.[1] ?? '';
      if (marker[0] === fenceChar && marker.length >= fenceLen && !close![2]!.trim()) {
        fenceLen = 0;
      }
      continue;
    }

    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    let visible = line.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
    for (let start = visible.indexOf('<!--'); start >= 0; start = visible.indexOf('<!--', start)) {
      const end = visible.indexOf('-->', start + 4);
      if (end < 0) {
        const opener = visible.slice(0, start + 4);
        // Test what follows a list marker, so nested items at any indent
        // count. An indented line outside a list is code, not an item.
        const item = (inList || !INDENTED.test(opener)) && BLOCK_PREFIX.exec(opener);
        inComment = COMMENT_BLOCK.test(item ? opener.slice(item[0].length) : opener);
        // Mid-paragraph, it's a comment only if `-->` comes before the
        // paragraph ends; otherwise just the rest of this line is left out.
        // In indented code, `<!--` is just code.
        const code = !inList && INDENTED.test(opener) && (prevBlank || inIndentedCode);
        if (!inComment && !code && i >= paragraphEnd && !ONE_LINE_BLOCK.test(lines[i]!)) {
          const depth = quoteDepth(lines[i]!);
          const topLevel = depth === 0 && !inList && !LIST_ITEM.test(lines[i]!);
          let k = i + 1;
          while (
            k < lines.length &&
            !endsParagraph(lines, k, depth, topLevel) &&
            !lines[k]!.includes('-->')
          ) {
            k++;
          }
          inComment = k < lines.length && !endsParagraph(lines, k, depth, topLevel);
          if (!inComment) paragraphEnd = k;
        }
        line = line.slice(0, start);
        break;
      }
      line = `${line.slice(0, start)} ${line.slice(end + 3)}`;
      visible = `${visible.slice(0, start)} ${visible.slice(end + 3)}`;
    }

    if (!line.trim()) {
      prevBlank = true;
      continue;
    }

    const indented = INDENTED.test(line);
    // Indented lines are code after a blank line (or more code), except inside
    // a list, where they continue the item.
    if (indented && !inList && (prevBlank || inIndentedCode)) {
      inIndentedCode = true;
      prevBlank = false;
      continue;
    }
    inIndentedCode = false;
    // Otherwise an indented line outside a list continues a paragraph, so
    // it can't open a fence.
    const continuesParagraph = indented && !inList;

    if (LIST_ITEM.test(line)) inList = true;
    else if (!indented && prevBlank) inList = false;
    prevBlank = false;

    const fence = continuesParagraph ? null : FENCE.exec(line);
    // A backtick "fence" whose info string has a backtick is inline code.
    if (fence && !(fence[1]![0] === '`' && fence[2]!.includes('`'))) {
      fenceChar = fence[1]![0]!;
      fenceLen = fence[1]!.length;
      continue;
    }

    if (REF_DEFINITION.test(line)) continue;
    out.push(line.replace(BLOCK_PREFIX, '$1'));
  }
  return out;
}

// Whether `lines[k]` ends a paragraph that sits `depth` blockquotes deep: a
// blank line, another block, or a deeper blockquote. A shallower one is a lazy
// continuation, and so, after a top-level paragraph, is a line indented 4+
// spaces (the main scan opens no fence there either) or a "2." item. In a list
// or blockquote, either may be a nested or sibling item.
function endsParagraph(lines: string[], k: number, depth: number, topLevel: boolean): boolean {
  const line = lines[k]!;
  if (PARAGRAPH_END.test(line) || quoteDepth(line) > depth) return true;
  if (TABLE_DELIMITER.test(line) || TABLE_DELIMITER.test(lines[k + 1] ?? '')) return true;
  if (topLevel && (INDENTED.test(line) || LATER_ITEM.test(line))) return false;
  return BLOCK_START.test(line) || HTML_BLOCK_START.test(line);
}

function quoteDepth(line: string): number {
  return QUOTE_PREFIX.exec(line)![0].split('>').length - 1;
}

function codePointLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) n--;
  }
  return n;
}

// --- Characters -------------------------------------------------------------

// Code units that may join a neighbour into one grapheme cluster: combining
// marks, joiners, prepend characters, conjoining jamo, astral code points
// (emoji, flags, modifiers) and the abugida scripts whose clusters span
// several letters. Everything else is one character per code unit.
const CLUSTERING =
  /[\p{M}\u200C\u200D\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u0900-\u0FFF\u1000-\u109F\u1100-\u11FF\u1780-\u17FF\uA960-\uA97F\uD7B0-\uD7FF\uFF9E\uFF9F\u{10000}-\u{10FFFF}\uD800-\uDFFF]+/gu;

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function countGraphemes(s: string): number {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (!graphemeSegmenter) return codePointLength(s);
  let n = 0;
  const it = graphemeSegmenter.segment(s)[Symbol.iterator]();
  while (!it.next().done) n++;
  return n;
}

/**
 * User-perceived characters (grapheme clusters), excluding line breaks. Every
 * code unit counts as one, then each run of clustering code units is
 * re-counted with Intl.Segmenter, which is far too slow to run over a whole
 * large document.
 */
export function countCharacters(text: string): number {
  let count = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) count--;
  }
  CLUSTERING.lastIndex = 0;
  for (let m = CLUSTERING.exec(text); m; m = CLUSTERING.exec(text)) {
    // Segment the run together with its neighbours, which it may join ("e" +
    // U+0301, a prepend mark + its base); they're already counted once each.
    // A neighbouring line break segments on its own, so it nets out to zero.
    const from = Math.max(0, m.index - 1);
    const to = Math.min(text.length, CLUSTERING.lastIndex + 1);
    count += countGraphemes(text.slice(from, to)) - (to - from);
  }
  return count;
}
