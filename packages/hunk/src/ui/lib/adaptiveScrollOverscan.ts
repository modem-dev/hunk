export const RAPID_SCROLL_OVERSCAN_IDLE_MS = 160;

const RAPID_SCROLL_MIN_DELTA_ROWS = 4;
const RAPID_SCROLL_MIN_VIEWPORT_MULTIPLIER = 3;
const RAPID_SCROLL_MAX_OVERSCAN_ROWS = 240;

/**
 * Return the temporary overscan halo to use after one coalesced scroll jump.
 *
 * Slow row-by-row movement keeps the default window small. Bursty wheel/page movement expands the
 * mounted window for a short idle period so the terminal can keep showing real, slightly
 * over-rendered rows instead of placeholders while scroll events outrun React commits.
 */
export function computeRapidScrollOverscanRows({
  deltaRows,
  viewportHeight,
}: {
  deltaRows: number;
  viewportHeight: number;
}) {
  const absoluteDeltaRows = Math.abs(deltaRows);
  if (absoluteDeltaRows < RAPID_SCROLL_MIN_DELTA_ROWS) {
    return 0;
  }

  const viewportRows = Math.max(1, Math.floor(viewportHeight));
  return Math.min(
    RAPID_SCROLL_MAX_OVERSCAN_ROWS,
    Math.max(absoluteDeltaRows * 2, viewportRows * RAPID_SCROLL_MIN_VIEWPORT_MULTIPLIER),
  );
}
