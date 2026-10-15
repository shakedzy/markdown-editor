// Helpers for matching a piece of text between the raw source and the
// rendered preview ("Take me there").
//
// Markdown markup makes the two sides differ character-for-character: a source
// line `**DEV_AUTH_BYPASS**` renders as `DEV_AUTH_BYPASS`, and emphasis/code
// markers (`*`, `_`, `` ` ``) are literal inside code yet syntactic in prose.
// Reducing both sides to alphanumerics only sidesteps all of that: any literal
// character survives on both sides, any markup character is dropped on both.
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Below this normalized length a match is too ambiguous to trust (e.g. a bare
// `# SBOM` heading), so callers fall back to section-level navigation.
export const MIN_MATCH_LEN = 5;

// "Take me there" lands on the exact spot clicked: the text just before and
// just after the click, reduced as above, is looked up on the other side and
// the point between the two is the spot. Markup in between (a link's URL, a
// `**`) can break the full context, so shorter and one-sided contexts are
// tried after it.

/** How much text around a click to send to the other pane, in raw characters. */
export const CONTEXT_CHARS = 400;

const CONTEXT_TRIES: readonly [before: number, after: number][] = [
  [32, 32],
  [16, 16],
  [8, 8],
  [0, 16],
  [16, 0],
  [0, 8],
  [8, 0],
];

// Enough occurrences to find the nearest one; more means the context is
// too common to trust anyway.
const MAX_OCCURRENCES = 2000;

/** `s` reduced as normalizeForMatch does, with each kept character's offset in `s`. */
export function normalizeWithOffsets(s: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // ASCII letters and digits, the common case, without a lowercase call.
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) {
      text += s[i];
      offsets.push(i);
    } else if (c >= 65 && c <= 90) {
      text += String.fromCharCode(c + 32);
      offsets.push(i);
    } else if (c > 127) {
      for (const ch of s[i]!.toLowerCase()) {
        if (/[a-z0-9]/.test(ch)) {
          text += ch;
          offsets.push(i);
        }
      }
    }
  }
  return { text, offsets };
}

/**
 * The index in `haystack` (normalized) of the point between `before` and
 * `after` (raw text either side of a click), or null if no context of
 * theirs is found. Of several occurrences, the one `distance` scores lowest
 * wins.
 */
export function locatePoint(
  haystack: string,
  before: string,
  after: string,
  distance: (index: number) => number,
): number | null {
  const b = normalizeForMatch(before);
  const a = normalizeForMatch(after);
  for (const [bLen, aLen] of CONTEXT_TRIES) {
    const left = bLen === 0 ? '' : b.slice(-bLen);
    const right = a.slice(0, aLen);
    const pattern = left + right;
    if (pattern.length < MIN_MATCH_LEN) continue;
    let best: number | null = null;
    let bestScore = Infinity;
    let seen = 0;
    for (let at = haystack.indexOf(pattern); at !== -1; at = haystack.indexOf(pattern, at + 1)) {
      const point = at + left.length;
      const score = distance(point);
      if (score < bestScore) {
        bestScore = score;
        best = point;
      }
      if (++seen >= MAX_OCCURRENCES) break;
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * The offset in the original text of normalized index `point` (from
 * locatePoint), for a click that was followed by `after`. On a word, that's
 * where its next character is; between words, just after the one before (a
 * click on the space after "foo" stays there, not at the next word).
 */
export function offsetOfPoint(
  offsets: readonly number[],
  point: number,
  length: number,
  after: string,
): number {
  const onWord = /^[\p{L}\p{N}]/u.test(after);
  if (point > 0 && (!onWord || point >= offsets.length)) return offsets[point - 1]! + 1;
  return offsets[point] ?? length;
}
