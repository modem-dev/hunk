/** Delay used to coalesce imperative ScrollBox viewport reads to roughly one frame. */
export const VIEWPORT_READ_COALESCE_MS = 16;

/**
 * Estimate render-only viewport bounds before OpenTUI publishes exact scrollbox geometry.
 * Subtracts the review pane's screen-top offset from the renderer height so the first paint
 * can window files without waiting for the scrollbox to report its laid-out height.
 */
export function estimateInitialRenderViewportHeight(rendererHeight: number, screenTop: number) {
  return Math.max(1, rendererHeight - Math.max(0, screenTop));
}

/**
 * Prefer the measured scrollbox height once it exists; otherwise keep the first-paint estimate.
 * Passing a measured 0 into file windowing only mounts the leading file plus overscan, which
 * leaves a tall first frame blank until the user scrolls.
 */
export function resolveRenderViewportHeight(measuredHeight: number, estimatedHeight: number) {
  return measuredHeight > 0 ? measuredHeight : Math.max(1, estimatedHeight);
}
