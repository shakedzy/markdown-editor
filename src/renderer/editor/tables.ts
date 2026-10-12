import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Extension,
  Line,
  Prec,
  StateCommand,
  Text,
  TransactionSpec,
} from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { minimalChange } from './minimalChange';

// GFM table editing: Format Table, Insert Table, and Tab / Shift-Tab / Enter
// moving between cells. Every edit lays the whole table out afresh and
// applies the difference as one undoable change.

export type Align = 'none' | 'left' | 'center' | 'right';

export interface RowCell {
  /** The cell's content, without the whitespace around it. */
  text: string;
  /** Where the content starts in the row (for an empty cell, where it would). */
  from: number;
  /** Where the cell starts: just past the pipe in front of it. */
  start: number;
}

/**
 * The cells of a table row (its line without container markup), split as
 * lezer's GFM parser splits them: unescaped pipes separate cells, a leading
 * or trailing pipe doesn't add an empty one, and a backslash escapes the
 * character after it (so `\|` is content, even inside code spans).
 */
export function splitRow(row: string): RowCell[] {
  const cells: RowCell[] = [];
  let start = 0;
  let from = -1;
  let to = -1;
  let first = true;
  let escaped = false;
  const push = () =>
    cells.push(from < 0 ? { text: '', from: start, start } : { text: row.slice(from, to), from, start });
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '|' && !escaped) {
      if (!first || from >= 0) push();
      first = false;
      start = i + 1;
      from = to = -1;
    } else if (escaped || (ch !== ' ' && ch !== '\t' && ch !== '\r')) {
      if (from < 0) from = i;
      to = i + 1;
    }
    escaped = !escaped && ch === '\\';
  }
  if (from >= 0) push();
  return cells;
}

/** The index of the cell (of `splitRow`'s result) that offset `pos` of the row falls in. */
export function cellIndexAt(cells: readonly RowCell[], pos: number): number {
  let index = 0;
  while (index + 1 < cells.length && cells[index + 1]!.start <= pos) index++;
  return index;
}

// East Asian Wide and Fullwidth code points, by block. Emoji are matched
// per grapheme instead, since their width depends on the whole sequence.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo leading consonants
  [0x2e80, 0x303e], // CJK radicals .. CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x16fff], // ideographic symbols
  [0x17000, 0x18cff], // Tangut, Khitan
  [0x1aff0, 0x1b2ff], // kana supplements, Nushu
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x3fffd], // CJK extension B onwards
];

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Regional_Indicator}|\u20E3/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
let graphemes: Intl.Segmenter | undefined;

/** Columns `text` takes in a monospace font: wide East Asian characters and emoji take two. */
export function displayWidth(text: string): number {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (EMOJI.test(segment)) width += 2;
    else if (!ZERO_WIDTH.test(segment)) {
      const code = segment.codePointAt(0)!;
      width += WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
    }
  }
  return width;
}

export interface TableRow {
  /** Container markup and indentation in front of the row (`> `, list indentation). */
  prefix: string;
  /** The cells' contents; for the delimiter row (the second), its `:---:` markers. */
  cells: readonly string[];
}

export interface TableLayout {
  /** The rows, separated by "\n". */
  text: string;
  /** For each row, where each cell's content sits in `text`. */
  cells: { from: number; to: number }[][];
}

function alignment(marker = ''): Align {
  const left = marker.startsWith(':');
  const right = marker.length > 1 && marker.endsWith(':');
  return left && right ? 'center' : left ? 'left' : right ? 'right' : 'none';
}

function delimiterCell(align: Align, width: number): string {
  const dashes = '-'.repeat(width - (align === 'center' ? 2 : align === 'none' ? 0 : 1));
  if (align === 'left') return ':' + dashes;
  if (align === 'right') return dashes + ':';
  return align === 'center' ? ':' + dashes + ':' : dashes;
}

/**
 * Lay out `rows` (header, delimiter, then body rows) with leading and trailing
 * pipes and one space of padding, each column as wide as its widest cell (at
 * least 3) and its cells aligned as the delimiter row says. Short rows get
 * empty cells; cells beyond the header's columns are kept (GFM doesn't show
 * them, but they're the author's text).
 */
export function layoutTable(rows: readonly TableRow[]): TableLayout {
  const header = rows[0]?.cells ?? [];
  const delimiter = rows[1]?.cells ?? [];
  const columns = Math.max(header.length, delimiter.length, 1);
  const aligns = Array.from({ length: columns }, (_, c) => alignment(delimiter[c]));
  const measured = rows.map((row, r) => (r === 1 ? [] : row.cells.map(displayWidth)));
  const widths: number[] = [];
  for (const row of measured) row.forEach((w, c) => (widths[c] = Math.max(widths[c] ?? 0, w)));
  for (let c = 0; c < columns; c++) widths[c] = Math.max(widths[c] ?? 0, 3);

  let text = '';
  const cells = rows.map((row, r) => {
    if (r > 0) text += '\n';
    text += row.prefix + '|';
    const values =
      r === 1
        ? aligns.map((align, c) => delimiterCell(align, widths[c]!))
        : [...row.cells, ...Array<string>(Math.max(0, columns - row.cells.length)).fill('')];
    return values.map((value, c) => {
      const space = r === 1 ? 0 : widths[c]! - (measured[r]![c] ?? 0);
      const align = aligns[c] ?? 'none';
      const before = align === 'right' ? space : align === 'center' ? space >> 1 : 0;
      text += ' ' + ' '.repeat(before);
      const from = text.length;
      text += value + ' '.repeat(space - before) + ' |';
      return { from, to: from + value.length };
    });
  });
  return { text, cells };
}

interface TableLine {
  from: number;
  to: number;
  prefix: string;
  cells: RowCell[];
}

interface CellPosition {
  row: number;
  cell: number;
  /** Offset into the cell's content. */
  offset: number;
}

// Blockquote markers and indentation in front of a line's content. Within a
// table they can't be anything else: a line starting with `>` would end it.
const LINE_PREFIX = /^(?:[ \t]*>)*[ \t]*/;
// lezer's test for a delimiter row.
const DELIMITER_ROW = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
const UNESCAPED_PIPE = /(?<!\\)(?:\\\\)*\|/;

function prefixLength(text: string): number {
  return LINE_PREFIX.exec(text)![0].length;
}

// A table whose header and delimiter rows disagree on the column count is
// only a paragraph to the parser, but it's still a table being edited (say,
// a column was just added to the header), and laying it out repairs it.
function looksLikeTable(state: EditorState, node: SyntaxNode): boolean {
  const first = state.doc.lineAt(node.from);
  if (first.to >= node.to) return false;
  const second = state.doc.line(first.number + 1).text;
  return (
    UNESCAPED_PIPE.test(state.doc.sliceString(node.from, first.to)) &&
    DELIMITER_ROW.test(second.slice(prefixLength(second)).trimEnd())
  );
}

function tableNode(state: EditorState, tree: Tree, pos: number): SyntaxNode | null {
  let block: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    // A markdown sample inside a code block isn't the document's table.
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return null;
    if (!block && (node.name === 'Table' || node.name === 'Paragraph')) block = node;
  }
  return block && (block.name === 'Table' || looksLikeTable(state, block)) ? block : null;
}

// The syntax tree, parsed at least to the end of the block `line` is in. The
// parser adds a block to the tree only once it has seen where the block ends,
// and runs only a little past the viewport. A table or paragraph ends at a
// blank line at the latest, so make sure the parse got that far.
function treeThroughBlock(state: EditorState, line: Line): Tree {
  const { doc } = state;
  let end = line;
  while (end.number < doc.lines && /\S/.test(end.text)) end = doc.line(end.number + 1);
  // ensureSyntaxTree's tree also has what an earlier call parsed, which
  // syntaxTree(state) doesn't.
  return ensureSyntaxTree(state, end.to, 100) ?? syntaxTree(state);
}

/** The lines of the table the line at `pos` belongs to, or null if it's not in one. */
function findTable(state: EditorState, pos: number): TableLine[] | null {
  const { doc } = state;
  const line = doc.lineAt(pos);
  const tree = syntaxTreeAvailable(state) ? syntaxTree(state) : treeThroughBlock(state, line);
  const node = tableNode(state, tree, line.to);
  if (!node) return null;

  const lines: TableLine[] = [];
  for (let n = doc.lineAt(node.from).number, end = doc.lineAt(node.to).number; n <= end; n++) {
    const { from, to, text } = doc.line(n);
    // Only the parse knows where the first row starts after a list marker (`- | a |`).
    const prefix = lines.length ? prefixLength(text) : node.from - from;
    lines.push({ from, to, prefix: text.slice(0, prefix), cells: splitRow(text.slice(prefix)) });
  }
  return lines;
}

function cellAt(lines: readonly TableLine[], pos: number): CellPosition {
  let row = lines.findIndex((line) => pos <= line.to);
  if (row < 0) row = lines.length - 1;
  const line = lines[row]!;
  const at = pos - line.from - line.prefix.length;
  const cell = cellIndexAt(line.cells, at);
  const content = line.cells[cell];
  const offset = content ? Math.min(Math.max(at - content.from, 0), content.text.length) : 0;
  return { row, cell, offset };
}

function rowsOf(lines: readonly TableLine[]): TableRow[] {
  return lines.map((line) => ({ prefix: line.prefix, cells: line.cells.map((c) => c.text) }));
}

// Positions count a line break as one character, whatever the document's
// line separator, so tables are built with "\n" and inserted as lines.
function asText(text: string): Text {
  return Text.of(text.split('\n'));
}

/** The change putting `text` in place of the table's lines. */
function replaceTable(
  state: EditorState,
  lines: readonly TableLine[],
  text: string,
): { from: number; changes: ChangeSet } {
  const from = lines[0]!.from;
  const change = minimalChange(state.doc.sliceString(from, lines[lines.length - 1]!.to), text);
  const changes = state.changes(
    change ? { from: from + change.from, to: from + change.to, insert: asText(change.insert) } : [],
  );
  return { from, changes };
}

/** Replace the table with `text` and select `anchor`..`head` (offsets into `text`). */
function rewrite(
  state: EditorState,
  lines: readonly TableLine[],
  text: string,
  anchor: number,
  head = anchor,
): TransactionSpec {
  const { from, changes } = replaceTable(state, lines, text);
  return {
    changes,
    selection: EditorSelection.single(from + anchor, from + head),
    scrollIntoView: true,
    userEvent: 'input',
  };
}

/**
 * Lay out the table at the cursor. Every cursor and selection end in it stays
 * in its cell, at the same place in the cell's content.
 */
export const formatTable: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = findTable(state, state.selection.main.head);
  if (!lines) return false;
  const layout = layoutTable(rowsOf(lines));
  const { from, changes } = replaceTable(state, lines, layout.text);
  const to = lines[lines.length - 1]!.to;
  const map = (pos: number) => {
    if (pos < from || pos > to) return changes.mapPos(pos);
    const { row, cell, offset } = cellAt(lines, pos);
    const target = layout.cells[row]![cell]!;
    return from + Math.min(target.from + offset, target.to);
  };
  const ranges = state.selection.ranges.map((r) => EditorSelection.range(map(r.anchor), map(r.head)));
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/**
 * The table and cell under a lone cursor (or a selection within one line,
 * such as a cell Tab selected). Multi-line and multiple selections are left
 * to the keys' usual commands.
 */
function cursorInTable(state: EditorState): { lines: TableLine[]; at: CellPosition } | null {
  const { ranges, main } = state.selection;
  if (state.readOnly || ranges.length > 1) return null;
  if (state.doc.lineAt(main.anchor).number !== state.doc.lineAt(main.head).number) return null;
  const lines = findTable(state, main.head);
  return lines && { lines, at: cellAt(lines, main.head) };
}

// Tab / Shift-Tab: lay the table out and select the next (previous) cell's
// content, skipping the delimiter row (from inside it too: to the first body
// cell, or the last header cell). Tab in the last cell adds a row.
function moveCell(dir: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const table = cursorInTable(state);
    if (!table) return false;
    const { lines, at } = table;
    const rows = rowsOf(lines);
    let layout = layoutTable(rows);
    let { row, cell } = at;
    if (dir > 0) {
      if (row !== 1 && cell + 1 < layout.cells[row]!.length) {
        cell++;
      } else {
        row = Math.max(row + 1, 2);
        cell = 0;
        if (row === rows.length) {
          rows.push({ prefix: lines[lines.length - 1]!.prefix, cells: [] });
          layout = layoutTable(rows);
        }
      }
    } else if (row !== 1 && cell > 0) {
      cell--;
    } else if (row > 0) {
      row = row <= 2 ? 0 : row - 1;
      cell = layout.cells[row]!.length - 1;
    }
    const target = layout.cells[row]![cell]!;
    dispatch(state.update(rewrite(state, lines, layout.text, target.from, target.to)));
    return true;
  };
}

export const nextCell = moveCell(1);
export const previousCell = moveCell(-1);

/**
 * Enter: lay the table out and start an empty row below the cursor's (below
 * the delimiter, from the header). On an empty last row, remove it and leave
 * the table instead, like Enter on an empty list item.
 */
export const insertRowBelow: StateCommand = ({ state, dispatch }) => {
  const table = cursorInTable(state);
  if (!table) return false;
  const { lines, at } = table;
  // At the very start of the table, Enter stays a newline that moves it down.
  if (at.row === 0 && state.selection.main.head <= lines[0]!.from + lines[0]!.prefix.length) {
    return false;
  }
  const rows = rowsOf(lines);
  const last = rows.length - 1;
  if (at.row === last && last > 1 && rows[last]!.cells.every((c) => !c)) {
    // Past a blank line: text on the line right below a table is another row.
    const { prefix } = rows.pop()!;
    const text = `${layoutTable(rows).text}\n${prefix.trimEnd()}\n${prefix}`;
    dispatch(state.update(rewrite(state, lines, text, text.length)));
    return true;
  }
  const row = Math.max(at.row + 1, 2);
  rows.splice(row, 0, { prefix: rows[row - 1]!.prefix, cells: [] });
  const layout = layoutTable(rows);
  dispatch(state.update(rewrite(state, lines, layout.text, layout.cells[row]![0]!.from)));
  return true;
};

// The top-level block `line` is in (a whole list or blockquote, a paragraph,
// a code block, the front matter): its outermost node but the Documents (the
// front matter and the markdown below it each have one, and so may a code
// block's language). A blank line goes with the line above it, which marked
// may still read as a list's. The parser closes the blocks still open where
// it stops, and lists and quotes can go on for long, so parse to the end (the
// TOC has the editor do that anyway).
function topLevelBlock(state: EditorState, line: Line): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
  const at = /[^ \t]/.test(line.text) || line.number === 1 ? line : state.doc.line(line.number - 1);
  let block: SyntaxNode | null = null;
  // From the end of the text, which is in its block.
  let node: SyntaxNode | null = tree.resolve(at.from + at.text.trimEnd().length, -1);
  for (; node; node = node.parent) if (node.name !== 'Document') block = node;
  return block;
}

// marked-footnote's definition: its first line, then every line indented 4+
// spaces below it, blank lines between them too. The editor has no footnotes.
const FOOTNOTE_DEFINITION = /^\[\^[^\]\n]+\]:/;

// The top-level block's last line. Below a list, marked (the preview) reads
// more lines into its last item than the editor (CommonMark) does: lines right
// below it that start with a space, a tab, a `>` or a `|`, and indented ones
// after blank lines (it wants less indentation after a tab); below a footnote
// definition, its indented lines. Then it's the last line of their blocks.
function blockEnd(state: EditorState, block: SyntaxNode): Line {
  const { doc } = state;
  // The line of its last character (a fence left open in it takes the line break).
  let end = doc.lineAt(block.to - 1);
  const footnote = FOOTNOTE_DEFINITION.test(doc.lineAt(block.from).text);
  if (!footnote && !/List$/.test(block.name)) return end;
  for (;;) {
    let next = end.number + 1;
    while (next <= doc.lines && !/[^ \t]/.test(doc.line(next).text)) next++;
    if (next > doc.lines) break;
    const below = footnote ? /^ {4}/ : next > end.number + 1 ? /^[ \t]/ : /^[ \t>|]/;
    if (!below.test(doc.line(next).text)) break;
    const last = topLevelBlock(state, doc.line(next));
    if (!last) break;
    end = doc.lineAt(last.to - 1);
  }
  return end;
}

/**
 * Insert an empty table (3 columns, header and two body rows) and put the
 * cursor in its first cell. In a table, it goes below that table, in the same
 * blockquote or indentation. Elsewhere it goes outside every container: on a
 * blank line between blocks, right there; otherwise below the top-level block
 * the cursor is in (the whole list or blockquote, the paragraph, code block
 * or front matter). The preview (marked) and the editor read container
 * markup differently, so in one the table could become code or move to
 * another container. Declines in a fence that's never closed.
 */
export const insertTable: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const { doc } = state;
  const head = state.selection.main.head;
  const table = findTable(state, head);
  const block = table ? null : topLevelBlock(state, doc.lineAt(head));
  const line = table
    ? doc.lineAt(table[table.length - 1]!.to)
    : block
      ? blockEnd(state, block)
      : doc.lineAt(head);
  // Below an unclosed fence would still be inside it.
  const last = block && topLevelBlock(state, line);
  if (last?.name === 'FencedCode' && last.getChildren('CodeMark').length < 2) return false;
  const prefix = table ? line.text.slice(0, prefixLength(line.text)) : '';
  const empty = ['', '', ''];
  const layout = layoutTable(
    [empty, ['---', '---', '---'], empty, empty].map((cells) => ({ prefix, cells })),
  );
  // Blank (next to a table, but for its container markup).
  const blank = (n: number) => {
    const { text } = doc.line(n);
    return !/[^ \t]/.test(table ? text.slice(prefixLength(text)) : text);
  };
  const separator = prefix.trimEnd() + '\n';
  let from = line.to;
  let before = '\n' + separator;
  if (blank(line.number)) {
    from = line.from;
    before = line.number > 1 && !blank(line.number - 1) ? separator : '';
  }
  const after = line.number < doc.lines && !blank(line.number + 1) ? '\n' + prefix.trimEnd() : '';
  const cursor = from + before.length + layout.cells[0]![0]!.from;
  dispatch(
    state.update({
      changes: { from, to: line.to, insert: asText(before + layout.text + after) },
      selection: { anchor: cursor },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/**
 * Tab / Shift-Tab / Enter in tables, and Format Table. Outside a table each
 * declines, so Tab still indents and Enter still continues lists. Must come
 * before the markdown language in the extensions: its Enter (list
 * continuation) has the same high precedence. An autocompletion popup's
 * keys (highest) still win.
 */
export const tableKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Tab', run: nextCell, shift: previousCell },
    { key: 'Enter', run: insertRowBelow },
    { key: 'Mod-Alt-t', run: formatTable },
  ]),
);
