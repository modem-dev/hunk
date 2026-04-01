/** One vertical extent measured in terminal rows within a single coordinate space. */
export interface VerticalBounds {
  top: number;
  height: number;
}

/**
 * Shared geometry for one file section body.
 *
 * `bodyHeight` and every nested `top` value should use the same coordinate space, such as
 * section-body-relative rows or whole-stream rows.
 */
export interface SectionGeometry<THunkBounds extends VerticalBounds> {
  bodyHeight: number;
  hunkAnchorRows: Map<number, number>;
  hunkBounds: Map<number, THunkBounds>;
}
