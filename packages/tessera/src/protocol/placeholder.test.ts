import { describe, expect, test } from "bun:test";
import { ROWCOLUMN_DIACRITICS, MAX_PLACEHOLDER_INDEX } from "./diacritics";
import { fitsPlaceholderGrid, PLACEHOLDER_CHAR, placeholderRows } from "./placeholder";

const ESC = String.fromCharCode(0x1b);

/** Counts placeholder characters, which equals the cell count in a row. */
function cellCount(row: string): number {
  return [...row].filter((ch) => ch === PLACEHOLDER_CHAR).length;
}

describe("diacritics table", () => {
  test("carries the full set kitty derives from Unicode 6.0", () => {
    expect(ROWCOLUMN_DIACRITICS).toHaveLength(297);
    expect(MAX_PLACEHOLDER_INDEX).toBe(296);
  });

  test("starts at combining overline and holds only combining marks", () => {
    expect(ROWCOLUMN_DIACRITICS[0]).toBe(0x0305);
    expect(new Set(ROWCOLUMN_DIACRITICS).size).toBe(ROWCOLUMN_DIACRITICS.length);
  });
});

describe("placeholderRows", () => {
  test("emits one string per row with one cell per column", () => {
    const rows = placeholderRows({ id: 1, rows: 3, cols: 5 });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(cellCount(row)).toBe(5);
  });

  test("encodes the image id in the foreground color", () => {
    // 0x0a0b0c splits across the three channels as 10, 11, 12.
    const rows = placeholderRows({ id: 0x0a0b0c, rows: 1, cols: 1 });
    expect(rows[0]!).toContain(`${ESC}[38;2;10;11;12m`);
  });

  test("encodes a placement id in the underline color", () => {
    const rows = placeholderRows({ id: 1, rows: 1, cols: 1, placementId: 0x000203 });
    expect(rows[0]!).toContain(`${ESC}[58:2::0:2:3m`);
  });

  test("omits the underline sequence when no placement id is given", () => {
    expect(placeholderRows({ id: 1, rows: 1, cols: 1 })[0]!).not.toContain("58:2:");
  });

  test("relies on run continuation by default and spells out columns on request", () => {
    const lean = placeholderRows({ id: 1, rows: 1, cols: 20 })[0]!;
    const explicit = placeholderRows({ id: 1, rows: 1, cols: 20, explicitColumns: true })[0]!;
    expect(explicit.length).toBeGreaterThan(lean.length);
    expect(cellCount(lean)).toBe(cellCount(explicit));
  });

  test("carries the high byte of a large id as a third diacritic", () => {
    const small = placeholderRows({ id: 1, rows: 1, cols: 1 })[0]!;
    const large = placeholderRows({ id: 0x01000001, rows: 1, cols: 1 })[0]!;
    expect([...large].length).toBeGreaterThan([...small].length);
  });

  test("returns nothing for an empty grid", () => {
    expect(placeholderRows({ id: 1, rows: 0, cols: 5 })).toEqual([]);
  });

  test("refuses grids larger than the diacritic table can address", () => {
    expect(() => placeholderRows({ id: 1, rows: 1, cols: 298 })).toThrow(/exceeds/);
  });
});

describe("fitsPlaceholderGrid", () => {
  test("accepts sizes within the table and rejects the rest", () => {
    expect(fitsPlaceholderGrid(24, 80)).toBe(true);
    expect(fitsPlaceholderGrid(297, 297)).toBe(true);
    expect(fitsPlaceholderGrid(298, 10)).toBe(false);
    expect(fitsPlaceholderGrid(0, 10)).toBe(false);
  });
});
