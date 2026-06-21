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
