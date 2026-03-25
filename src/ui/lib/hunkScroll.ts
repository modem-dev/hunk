/**
 * Pick a scroll target that keeps the selected hunk readable.
 *
 * If the whole hunk fits, keep all of it in view. Otherwise bias toward showing the top of the
 * hunk with a little breathing room.
 */
export function computeHunkRevealScrollTop({
  hunkTop,
  hunkHeight,
  preferredTopPadding,
  viewportHeight,
}: {
  hunkTop: number;
  hunkHeight: number;
  preferredTopPadding: number;
  viewportHeight: number;
}) {
  const clampedTop = Math.max(0, hunkTop);
  const clampedHeight = Math.max(0, hunkHeight);
  const clampedViewportHeight = Math.max(0, viewportHeight);
  const desiredTop = Math.max(0, clampedTop - Math.max(0, preferredTopPadding));

  if (clampedViewportHeight === 0) {
    return desiredTop;
  }

  if (clampedHeight <= clampedViewportHeight) {
    // Preserve the preferred top padding when possible, but never at the cost of clipping the end
    // of a hunk that would otherwise fit completely on screen.
    const minimumTopForFullHunk = Math.max(0, clampedTop + clampedHeight - clampedViewportHeight);
    return Math.max(desiredTop, minimumTopForFullHunk);
  }

  return desiredTop;
}
