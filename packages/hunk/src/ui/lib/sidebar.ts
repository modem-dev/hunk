/** Clamp a dragged sidebar width into the app layout's allowed range. */
export function resizeSidebarWidth(
  startWidth: number,
  dragOriginX: number,
  currentX: number,
  minWidth: number,
  maxWidth: number,
) {
  const nextWidth = startWidth + (currentX - dragOriginX);
  return Math.min(Math.max(nextWidth, minWidth), maxWidth);
}
