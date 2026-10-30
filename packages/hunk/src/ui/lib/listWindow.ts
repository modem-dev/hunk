/**
 * Where a fixed-height list should start drawing to keep its selection visible.
 *
 * Shared by every modal list Hunk renders (the theme selector, extension select
 * dialogs) so they scroll identically: the selection sits centered once the list
 * is long enough to scroll, and pinned at either end near the edges.
 */
export function listWindowStart(selectedIndex: number, rowCount: number, visibleRows: number) {
  if (rowCount <= visibleRows) {
    return 0;
  }

  const centered = selectedIndex - Math.floor(visibleRows / 2);
  return Math.min(Math.max(centered, 0), rowCount - visibleRows);
}
