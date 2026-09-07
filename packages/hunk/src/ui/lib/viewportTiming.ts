/** Delay used to coalesce imperative ScrollBox viewport reads to roughly one frame. */
export const VIEWPORT_READ_COALESCE_MS = 16;

/**
 * Estimate render-only viewport bounds before OpenTUI publishes exact scrollbox geometry.
 * Subtracts the review pane's screen-top offset from the renderer height so the first paint
 * can window files without waiting for the scrollbox to report its laid-out height. A planned
 * pane height excludes any extension pane below the review.
 */
export function estimateInitialRenderViewportHeight(
  rendererHeight: number,
  screenTop: number,
  paneHeight?: number,
) {
  const availableRendererHeight = rendererHeight - Math.max(0, screenTop);
  return Math.max(
    1,
    paneHeight === undefined
      ? availableRendererHeight
      : Math.min(availableRendererHeight, paneHeight),
  );
}

/**
 * Prefer the measured scrollbox height once it exists; otherwise keep the first-paint estimate.
 * Passing a measured 0 into file windowing only mounts the leading file plus overscan, which
 * leaves a tall first frame blank until the user scrolls.
 */
export function resolveRenderViewportHeight(measuredHeight: number, estimatedHeight: number) {
  return measuredHeight > 0 ? measuredHeight : Math.max(1, estimatedHeight);
}
