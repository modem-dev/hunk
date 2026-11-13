/**
 * Measures where each hunk and each expanded gap of one rendered file sits, in CSS pixels.
 *
 * The selected-hunk rail, hunk reveals, click-to-select, and viewport anchoring all need to
 * know which rows a hunk occupies on screen. Which rows those are is shared-model data — a
 * hunk's `unifiedLineStart`/`splitLineStart` and counts, which Pierre writes onto every row as
 * `data-line-index="<unified>,<split>"` — so this module reads row indices from the model and
 * only asks the DOM where those rows ended up. Expanded gap lines are not part of the hunk
 * they were folded into: the rail and the anchor policy follow the hunk the review addresses,
 * as the terminal does.
 */
import type { ReviewHunkVerticalBounds } from "../../core/review/viewportAnchor";
import type { ReviewFileV1 } from "../../core/review/types";
import type { ReviewGapView } from "./fileProjection";

/** A half-open range of rendered row indices in one layout. */
export interface ReviewRowRange {
  start: number;
  end: number;
}

/** The rows one hunk of the shared model occupies in one layout. */
export function reviewHunkRowRange(
  file: ReviewFileV1,
  hunkIndex: number,
  layout: "split" | "unified",
): ReviewRowRange | undefined {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) return undefined;
  const start = layout === "split" ? hunk.splitLineStart : hunk.unifiedLineStart;
  const count = layout === "split" ? hunk.splitLineCount : hunk.unifiedLineCount;
  return { start, end: start + count };
}

/** The rows an expanded gap's lines occupy in one layout, beside the hunk they abut. */
export function reviewGapRowRange(
  file: ReviewFileV1,
  gap: ReviewGapView,
  layout: "split" | "unified",
): ReviewRowRange | undefined {
  const { position, hunkIndex, lineCount } = gap.address;
  const hunk = reviewHunkRowRange(file, hunkIndex, layout);
  if (!hunk) return undefined;
  return position === "before"
    ? { start: hunk.start - lineCount, end: hunk.start }
    : { start: hunk.end, end: hunk.end + lineCount };
}

/** Where one file's hunks and expanded gaps sit, relative to the top of its rendered diff. */
export interface ReviewFileGeometry {
  /** Bounds per hunk index; a hunk with no rendered rows is absent. */
  hunks: (ReviewHunkVerticalBounds | undefined)[];
  /** Bounds per expanded gap id. */
  gaps: Map<string, ReviewHunkVerticalBounds>;
}

/** Find the hunk whose rows include one rendered row index. */
export function reviewHunkAtRow(
  file: ReviewFileV1,
  layout: "split" | "unified",
  row: number,
): number | undefined {
  for (let index = 0; index < file.hunks.length; index += 1) {
    const range = reviewHunkRowRange(file, index, layout)!;
    if (row >= range.start && row < range.end) return index;
  }
  return undefined;
}

/** Read one row element's index in a layout from Pierre's `data-line-index`. */
export function rowIndexOf(element: Element, layout: "split" | "unified") {
  const [unified, split] = (element.getAttribute("data-line-index") ?? "").split(",");
  const value = Number(layout === "split" ? split : unified);
  return Number.isInteger(value) ? value : undefined;
}

/**
 * Measure the rendered bounds of every hunk and expanded gap of one mounted file.
 *
 * Reads only the first and last row of each range: every element carrying one row index
 * (both split columns and their gutters) is unioned, so wrapped rows count at full height.
 */
export function measureReviewFileGeometry(
  host: HTMLElement,
  file: ReviewFileV1,
  gaps: readonly ReviewGapView[],
  layout: "split" | "unified",
): ReviewFileGeometry {
  const root = host.querySelector("diffs-container")?.shadowRoot;
  const geometry: ReviewFileGeometry = { hunks: [], gaps: new Map() };
  if (!root) return geometry;

  const rowsByIndex = new Map<number, Element[]>();
  for (const element of Array.from(root.querySelectorAll("[data-line-index]"))) {
    const index = rowIndexOf(element, layout);
    if (index === undefined) continue;
    const rows = rowsByIndex.get(index);
    if (rows) rows.push(element);
    else rowsByIndex.set(index, [element]);
  }

  const origin = host.getBoundingClientRect().top;
  const bounds = (range: ReviewRowRange | undefined) => {
    if (!range || range.end <= range.start) return undefined;
    const first = rowsByIndex.get(range.start);
    const last = rowsByIndex.get(range.end - 1);
    if (!first || !last) return undefined;
    const top = Math.min(...first.map((element) => element.getBoundingClientRect().top));
    const bottom = Math.max(...last.map((element) => element.getBoundingClientRect().bottom));
    return { top: top - origin, height: Math.max(0, bottom - top) };
  };

  geometry.hunks = file.hunks.map((_hunk, index) =>
    bounds(reviewHunkRowRange(file, index, layout)),
  );
  for (const gap of gaps) {
    if (gap.state !== "expanded") continue;
    const measured = bounds(reviewGapRowRange(file, gap, layout));
    if (measured) geometry.gaps.set(gap.gapId, measured);
  }
  return geometry;
}
