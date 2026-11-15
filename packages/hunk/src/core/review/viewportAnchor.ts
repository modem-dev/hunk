/**
 * Picks the hunk a scrolled viewport is looking at, for the viewport-anchor policy.
 *
 * When a reviewer scrolls by hand, every surface adopts the hunk nearest the middle of its
 * viewport as the selection (`selection/anchor`, which never moves a viewport;
 * `REVIEW_VIEWPORT_ANCHOR_REVEAL` in `state.ts`, audit B11). The terminal measures hunk bounds
 * in rows and the browser in pixels, but which hunk owns an offset is one rule: the hunk
 * containing it, else the nearest one, with the later hunk winning an exact tie so ownership
 * hands off when a midpoint reaches the center.
 */

/** One hunk's vertical extent within its file body, in whatever unit the caller measures. */
export interface ReviewHunkVerticalBounds {
  top: number;
  height: number;
}

/**
 * Return the hunk owning one vertical offset inside a file body.
 *
 * `boundsOf` answers for each hunk index below `hunkCount`, or nothing for a hunk the caller
 * has not measured; with no measured hunks the answer is the first hunk. A bottom edge is
 * inclusive of its last unit (`top + height - 1`), matching row-measured callers.
 */
export function reviewHunkIndexAtOffset(
  hunkCount: number,
  boundsOf: (hunkIndex: number) => ReviewHunkVerticalBounds | undefined,
  offset: number,
) {
  let nearestHunkIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let hunkIndex = 0; hunkIndex < hunkCount; hunkIndex += 1) {
    const bounds = boundsOf(hunkIndex);
    if (!bounds) {
      continue;
    }

    const bottom = bounds.top + bounds.height - 1;
    if (offset >= bounds.top && offset <= bottom) {
      return hunkIndex;
    }

    const distance = offset < bounds.top ? bounds.top - offset : offset - bottom;

    // Favor the later hunk on exact ties so ownership hands off when the midpoint reaches center.
    if (
      distance < nearestDistance ||
      (distance === nearestDistance && hunkIndex > nearestHunkIndex)
    ) {
      nearestDistance = distance;
      nearestHunkIndex = hunkIndex;
    }
  }

  return nearestHunkIndex;
}
