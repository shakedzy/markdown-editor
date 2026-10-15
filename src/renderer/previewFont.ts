// The preview's text size, as a factor of its normal size. Unlike zoom it
// scales only the rendered document, not the editor or the app's chrome.

export const PREVIEW_FONT_STEPS: readonly number[] = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
const MIN = PREVIEW_FONT_STEPS[0]!;
const MAX = PREVIEW_FONT_STEPS[PREVIEW_FONT_STEPS.length - 1]!;
const EPSILON = 0.005;

/** A usable factor: clamped to the supported range (1 for anything unreadable). */
export function normalizePreviewFont(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(MAX, Math.max(MIN, factor));
}

/** The next step above (1) or below (-1) `current`, stopping at the ends. */
export function stepPreviewFont(current: number, direction: 1 | -1): number {
  const f = normalizePreviewFont(current);
  if (direction > 0) return PREVIEW_FONT_STEPS.find((s) => s > f + EPSILON) ?? MAX;
  for (let i = PREVIEW_FONT_STEPS.length - 1; i >= 0; i--) {
    if (PREVIEW_FONT_STEPS[i]! < f - EPSILON) return PREVIEW_FONT_STEPS[i]!;
  }
  return MIN;
}

export function isDefaultPreviewFont(factor: number): boolean {
  return Math.abs(factor - 1) < EPSILON;
}
