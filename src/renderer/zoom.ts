import { useCallback, useEffect, useState } from 'react';
import { useLatest } from './useLatest';

// The levels Zoom In / Zoom Out step through (Chromium's own presets).
export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
// Chromium stores zoom as a log-scale level, so a factor read back can be off
// by a hair (1.0999999…); compare and snap with some slack.
const EPSILON = 0.005;

export function sameZoom(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** A usable zoom factor: clamped to the supported range and snapped to a step. */
export function normalizeZoom(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
  return ZOOM_STEPS.find((s) => sameZoom(s, clamped)) ?? Math.round(clamped * 1000) / 1000;
}

/** The next step above (1) or below (-1) `current`, stopping at the ends. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const z = normalizeZoom(current);
  if (direction > 0) return ZOOM_STEPS.find((s) => s > z + EPSILON) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i]! < z - EPSILON) return ZOOM_STEPS[i]!;
  }
  return MIN_ZOOM;
}

export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** Apply a zoom factor to this window; returns the factor actually used. */
export function setWindowZoom(factor: number): number {
  const z = normalizeZoom(factor);
  window.api.setZoomFactor(z);
  return z;
}

function readWindowZoom(): number {
  return normalizeZoom(window.api.getZoomFactor());
}

/**
 * The window's zoom factor plus Zoom In / Out / Actual Size commands. `initial`
 * is the factor already applied at startup; `persist` stores a factor the
 * user picked so the next launch restores it.
 */
export function useZoom(
  initial: number,
  persist: (factor: number) => void,
): {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
} {
  const [zoom, setZoom] = useState(() => normalizeZoom(initial));
  const persistRef = useLatest(persist);

  const apply = useCallback((factor: number) => {
    const z = setWindowZoom(factor);
    setZoom(z);
    persistRef.current(z);
  }, []);

  // Step from the live level rather than state: another window may have
  // changed it (see below).
  const zoomIn = useCallback(() => apply(stepZoom(readWindowZoom(), 1)), [apply]);
  const zoomOut = useCallback(() => apply(stepZoom(readWindowZoom(), -1)), [apply]);
  const zoomReset = useCallback(() => apply(1), [apply]);

  // Chromium can share one zoom level between all windows on the same origin,
  // so zooming another window may zoom this one too. That resizes the
  // viewport, so re-read the level on resize and on focus to keep the status
  // bar honest. Only levels picked in this window are persisted.
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const live = readWindowZoom();
      setZoom((z) => (sameZoom(z, live) ? z : live));
    };
    const scheduleSync = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('focus', scheduleSync);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('focus', scheduleSync);
    };
  }, []);

  return { zoom, zoomIn, zoomOut, zoomReset };
}
