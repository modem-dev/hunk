import { describe, expect, test } from "bun:test";
import { webNoteLocationLabel } from "./noteLocation";

describe("webNoteLocationLabel", () => {
  test("names one new-side line, and a range with an en dash", () => {
    expect(webNoteLocationLabel({ newRange: [13, 13] })).toBe("line 13");
    expect(webNoteLocationLabel({ newRange: [14, 16] })).toBe("lines 14–16");
  });

  test("marks the old side", () => {
    expect(webNoteLocationLabel({ oldRange: [13, 13] })).toBe("old line 13");
    expect(webNoteLocationLabel({ oldRange: [3, 5] })).toBe("old lines 3–5");
  });

  test("joins both sides old first, and says hunk when there are no lines", () => {
    expect(webNoteLocationLabel({ oldRange: [3, 3], newRange: [4, 6] })).toBe(
      "old line 3 → lines 4–6",
    );
    expect(webNoteLocationLabel({})).toBe("hunk");
  });
});
