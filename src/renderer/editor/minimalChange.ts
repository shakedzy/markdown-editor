export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The single replacement turning `prev` into `next`: everything between their
 * common prefix and common suffix. Applying only that span (rather than the
 * whole text) lets the editor map the cursor, selection and scroll position
 * through it. Returns null when the texts are equal.
 */
export function minimalChange(prev: string, next: string): TextChange | null {
  if (prev === next) return null;
  const shorter = Math.min(prev.length, next.length);

  let start = 0;
  while (start < shorter && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  // Never split a surrogate pair between the kept and replaced text.
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start--;

  let end = 0;
  const maxEnd = shorter - start;
  while (
    end < maxEnd &&
    prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  if (end > 0 && isLowSurrogate(prev.charCodeAt(prev.length - end))) end--;

  return { from: start, to: prev.length - end, insert: next.slice(start, next.length - end) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
