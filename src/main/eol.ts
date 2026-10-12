// The renderer only ever sees "\n" line endings (CodeMirror joins lines with
// "\n" anyway), so main converts at the disk boundary and writes a document
// back with the line endings it was read with.

export type Eol = '\n' | '\r\n';

/** The line ending a file uses, judged by its first line break. */
export function detectEol(text: string): Eol {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function fromLf(text: string, eol: Eol): string {
  const lf = toLf(text);
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
