import { describe, expect, test } from "bun:test";
import { plannedRowMatchesCursor, type CursorHighlight } from "./cursorHighlight";

const CURSOR: CursorHighlight = {
  stableKey: "line:new:2",
  style: "row",
  side: "new",
};

describe("plannedRowMatchesCursor", () => {
  test("matches canonical and alias stable keys", () => {
    expect(plannedRowMatchesCursor({ stableKey: CURSOR.stableKey }, CURSOR)).toBe(true);
    expect(
      plannedRowMatchesCursor(
        { stableKey: "line:old:2", stableAliasKeys: [CURSOR.stableKey] },
        CURSOR,
      ),
    ).toBe(true);
  });

  test("rejects absent and unrelated cursors", () => {
    expect(plannedRowMatchesCursor({ stableKey: "line:new:3" }, CURSOR)).toBe(false);
    expect(plannedRowMatchesCursor({ stableKey: CURSOR.stableKey }, undefined)).toBe(false);
  });
});
