import { Parser } from 'marked';
import type { MarkedExtension, Token } from 'marked';

// Scroll sync lines the preview up with the editor by source line: each
// top-level block the preview renders carries the 1-based line it starts on
// as `data-line`.

// The footnotes section is rendered at the end of the document, wherever its
// definitions are, and its `raw` is the section title rather than source.
const NOT_SOURCE = 'footnotes';

/**
 * The 1-based line of `src` each top-level token starts on, or null for a
 * token that can't be placed (or isn't source text).
 */
export function tokenLines(tokens: readonly Token[], src: string): (number | null)[] {
  // marked's lexer normalizes line breaks the same way; raws are slices of this.
  const text = src.includes('\r') ? src.replace(/\r\n?/g, '\n') : src;
  let pos = 0; // where the next token's source can start
  let line = 1; // the line `counted` is on
  let counted = 0;

  // Offsets only move forward, so line breaks are counted once overall.
  const lineAt = (offset: number): number => {
    let nl = text.indexOf('\n', counted);
    while (nl !== -1 && nl < offset) {
      line++;
      nl = text.indexOf('\n', nl + 1);
    }
    counted = offset;
    return line;
  };

  return tokens.map((token) => {
    const raw = token.raw;
    if (!raw || token.type === NOT_SOURCE) return null;
    if (token.type === 'space') {
      if (text.startsWith(raw, pos)) pos += raw.length;
      return null;
    }
    let at = pos;
    let length = raw.length;
    if (!text.startsWith(raw, pos)) {
      // Source the lexer drops (link reference definitions) can sit in
      // between, and marked joins some raws with a line break of its own (a
      // paragraph that swallowed the definition after it), so look for the
      // token's first line.
      const nl = raw.indexOf('\n');
      const firstLine = nl === -1 ? raw : raw.slice(0, nl);
      at = indexOfLine(text, firstLine, pos);
      if (at === -1) return null;
      if (!text.startsWith(raw, at)) length = firstLine.length;
    }
    const start = lineAt(at);
    pos = at + length;
    return start;
  });
}

/** Where `line` next occurs at the start of a line of `text`, from `from` on; -1 if nowhere. */
function indexOfLine(text: string, line: string, from: number): number {
  if (!line) return -1;
  for (let at = text.indexOf(line, from); at !== -1; at = text.indexOf(line, at + 1)) {
    if (at === 0 || text[at - 1] === '\n') return at;
  }
  return -1;
}

const FIRST_TAG = /^(\s*<[a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])/;

/** Add `data-line` to the element `html` opens with; output that doesn't start with a tag is returned as is. */
export function tagFirstElement(html: string, line: number): string {
  return html.replace(FIRST_TAG, `$1 data-line="${line}"`);
}

/**
 * Renders top-level blocks with `data-line`. `src` is the markdown being
 * parsed and `lineOffset` the document lines before it (front matter). Blocks
 * go through one parser one at a time, so heading slugs, footnote numbers and
 * reference links come out exactly as in a single pass: those are settled by
 * the lexer or by state shared across the parse.
 */
export function sourceLines(src: string, lineOffset: number): MarkedExtension {
  return {
    hooks: {
      provideParser() {
        if (!this.block) return Parser.parseInline;
        return (tokens, options) => {
          const lines = tokenLines(tokens, src);
          const parser = new Parser(options);
          let out = '';
          for (let i = 0; i < tokens.length; ) {
            // marked renders a run of top-level text tokens as one paragraph.
            let end = i + 1;
            if (tokens[i]!.type === 'text') {
              while (end < tokens.length && tokens[end]!.type === 'text') end++;
            }
            const html = parser.parse(tokens.slice(i, end));
            const line = lines[i];
            out += line == null ? html : tagFirstElement(html, line + lineOffset);
            i = end;
          }
          return out;
        };
      },
    },
  };
}
