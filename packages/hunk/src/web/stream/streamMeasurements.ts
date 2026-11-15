/**
 * Remembers what the stream measured for files that are not currently drawn.
 *
 * A file's body height and hunk geometry are true only for the layout and wrapping they were
 * measured in. `sync` drops both the moment a render sees a different layout or wrap, so that
 * same render, the scrollbar and the minimap all start from the same estimates; clearing in a
 * later effect would leave one render drawing files at the old layout's heights, with no
 * re-render to correct it.
 */
export class StreamMeasurements<Geometry> {
  /** Body heights measured while a file was mounted. */
  readonly heights = new Map<string, number>();
  /** Where each drawn file's hunks and gaps sit. */
  readonly geometries = new Map<string, Geometry>();
  private key: string;

  constructor(layout: string, wrapLines: boolean) {
    this.key = `${layout}|${wrapLines}`;
  }

  /** Drop every measurement if the layout or wrapping differs from the last call. */
  sync(layout: string, wrapLines: boolean) {
    const key = `${layout}|${wrapLines}`;
    if (key === this.key) return false;
    this.key = key;
    this.heights.clear();
    this.geometries.clear();
    return true;
  }

  /** Forget one file's hunk geometry, as when its diff view goes away. */
  dropGeometry(fileKey: string) {
    this.geometries.delete(fileKey);
  }
}
