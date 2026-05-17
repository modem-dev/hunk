/**
 * Display-width helpers for the diff renderer.
 *
 * Hunk renders code through opentui, which measures terminal columns with
 * `Bun.stringWidth`. Any padding, slicing, or wrapping logic that uses
 * `String#length` will therefore undercount wide characters (CJK, emoji,
 * fullwidth punctuation), so a row that looks the right number of code units
 * still ends up too narrow on screen and pushes following cells out of place.
 *
 * These helpers keep the layout math in agreement with the cell grid the
 * terminal actually paints.
 */

/** Display columns occupied by `text` on a typical terminal. */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

export interface DisplayWidthSlice {
  /** The slice text. Every included grapheme fits fully inside the window. */
  text: string;
  /** Display columns of `text`. Always `<= width`. */
  consumedColumns: number;
  /** Columns dropped to honour `startColumn` boundary (0 unless a wide grapheme straddled it). */
  leadingSkip: number;
  /** Columns of the next grapheme that was dropped because it would have overflowed `width` (0 or 1). */
  trailingDropped: number;
}

/**
 * Slice `text` to fit a display-column window starting at `startColumn` and at
 * most `width` columns wide. Wide graphemes are kept whole: when a 2-column
 * grapheme would straddle either boundary it is dropped, and the caller can
 * pad with a single space to preserve alignment with adjacent cells.
 */
export function sliceByDisplayWidth(
  text: string,
  startColumn: number,
  width: number,
): DisplayWidthSlice {
  if (width <= 0) {
    return { text: "", consumedColumns: 0, leadingSkip: 0, trailingDropped: 0 };
  }

  let result = "";
  let consumed = 0;
  let skipped = 0;
  let trailingDropped = 0;

  for (const grapheme of text) {
    const w = Bun.stringWidth(grapheme);

    if (skipped < startColumn) {
      if (skipped + w <= startColumn) {
        skipped += w;
        continue;
      }
      // Wide grapheme straddles the start boundary; drop it and align to the
      // boundary so the caller's pre-slice padding still lines up.
      skipped = startColumn;
      continue;
    }

    if (consumed + w > width) {
      trailingDropped = width - consumed;
      break;
    }

    result += grapheme;
    consumed += w;
  }

  return { text: result, consumedColumns: consumed, leadingSkip: skipped, trailingDropped };
}

/**
 * Wrap `text` into visual rows of at most `width` columns each. Wide graphemes
 * stay whole: when one would overflow the current row, the row is broken
 * before it.
 *
 * The result always contains at least one row (an empty string for empty input).
 */
export function wrapByDisplayWidth(
  text: string,
  width: number,
): { text: string; columns: number }[] {
  if (width <= 0) {
    return [{ text: "", columns: 0 }];
  }

  const rows: { text: string; columns: number }[] = [];
  let current = "";
  let currentColumns = 0;

  for (const grapheme of text) {
    const w = Bun.stringWidth(grapheme);
    if (currentColumns + w > width && current.length > 0) {
      rows.push({ text: current, columns: currentColumns });
      current = "";
      currentColumns = 0;
    }
    current += grapheme;
    currentColumns += w;
  }

  rows.push({ text: current, columns: currentColumns });
  return rows;
}
