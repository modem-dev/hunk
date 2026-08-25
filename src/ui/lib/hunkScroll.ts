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

export type CurrentLineAlignment = "top" | "center" | "bottom";

/** Place the current rendered line at one semantic viewport edge or center. */
export function computeLineAlignmentScrollTop({
  alignment,
  lineTop,
  lineHeight,
  viewportHeight,
}: {
  alignment: CurrentLineAlignment;
  lineTop: number;
  lineHeight: number;
  viewportHeight: number;
}) {
  const top = Math.max(0, lineTop);
  const height = Math.max(1, lineHeight);
  const viewport = Math.max(1, viewportHeight);

  if (alignment === "top") return top;
  if (alignment === "bottom") return Math.max(0, top + height - viewport);
  return Math.max(0, top - Math.floor((viewport - height) / 2));
}

/**
 * How far a current-line reveal may move the viewport.
 *
 * `"nearest"` is stepping: move only as far as it takes to bring the line on screen.
 * `"reveal"` is a jump to somewhere the reviewer was not looking, so it lands the line where
 * hunk and note reveals land it, a little below the viewport top, even when the line already
 * happened to be visible.
 */
export type LineRevealPlacement = "nearest" | "reveal";

/**
 * Pick a scroll target that brings the current line just into view.
 *
 * This runs on every step key, so it moves the minimum distance and stays put while the line is
 * already on screen; hunk reveal's top bias would yank the viewport on each keystroke.
 */
export function computeLineRevealScrollTop({
  lineTop,
  lineHeight,
  scrollTop,
  viewportHeight,
}: {
  lineTop: number;
  lineHeight: number;
  scrollTop: number;
  viewportHeight: number;
}) {
  const clampedTop = Math.max(0, lineTop);
  const clampedHeight = Math.max(1, lineHeight);
  const clampedViewportHeight = Math.max(0, viewportHeight);

  if (clampedTop < scrollTop) {
    return clampedTop;
  }

  const lineBottom = clampedTop + clampedHeight;
  const viewportBottom = scrollTop + clampedViewportHeight;
  if (lineBottom > viewportBottom) {
    return Math.max(0, lineBottom - clampedViewportHeight);
  }

  return scrollTop;
}
