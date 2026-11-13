import { describe, expect, test } from "bun:test";
import {
  MAX_LINE_HIGHLIGHT_INPUT_ENTRIES,
  MAX_LINE_HIGHLIGHTS_PER_FILE,
  MAX_LINE_HIGHLIGHTS_PER_LINE,
  validateLineHighlights,
} from "./validate";

describe("validateLineHighlights", () => {
  test("treats null and empty arrays as ordinary no-mark answers", () => {
    expect(validateLineHighlights(null)).toEqual({ ok: true, marks: [], droppedInvalid: 0 });
    expect(validateLineHighlights(undefined)).toEqual({ ok: true, marks: [], droppedInvalid: 0 });
    expect(validateLineHighlights([])).toEqual({ ok: true, marks: [], droppedInvalid: 0 });
  });

  test("rejects a non-array result whole", () => {
    const validation = validateLineHighlights({ side: "new" });
    expect(validation).toEqual({ ok: false, issue: "returned a non-array result" });
  });

  test("accepts valid marks and applies the tone default", () => {
    const validation = validateLineHighlights([
      { side: "new", line: 3, range: [2, 8] },
      { side: "old", line: 1, range: [0, 1], tone: "error" },
      { side: "new", line: 4, range: [0, 10], tone: "dim" },
    ]);
    expect(validation).toEqual({
      ok: true,
      droppedInvalid: 0,
      marks: [
        { side: "new", line: 3, start: 2, end: 8, tone: "match" },
        { side: "old", line: 1, start: 0, end: 1, tone: "error" },
        { side: "new", line: 4, start: 0, end: 10, tone: "dim" },
      ],
    });
  });

  test("drops structurally invalid entries individually and counts them", () => {
    const validation = validateLineHighlights([
      { side: "new", line: 2, range: [1, 4] },
      null,
      { side: "both", line: 2, range: [1, 4] },
      { side: "new", line: 0, range: [1, 4] },
      { side: "new", line: 1.5, range: [1, 4] },
      { side: "new", line: 2, range: [4, 4] },
      { side: "new", line: 2, range: [5, 4] },
      { side: "new", line: 2, range: [-1, 4] },
      { side: "new", line: 2, range: [1] },
      { side: "new", line: 2, range: [1, 4], tone: "sparkle" },
    ]);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.marks).toHaveLength(1);
      expect(validation.droppedInvalid).toBe(9);
    }
  });

  test("rejects a file exceeding the per-file cap instead of truncating", () => {
    const marks = Array.from({ length: MAX_LINE_HIGHLIGHTS_PER_FILE + 1 }, (_, index) => ({
      side: "new" as const,
      line: index + 1,
      range: [0, 1] as const,
    }));
    const validation = validateLineHighlights(marks);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issue).toContain(String(MAX_LINE_HIGHLIGHTS_PER_FILE));
    }
  });

  test("rejects an oversized result without reading a single entry", () => {
    // The mark caps count entries that survived validation, so an array of pure
    // garbage used to cost a full structural pass at no cost to the extension.
    const raw = Array.from({ length: MAX_LINE_HIGHLIGHT_INPUT_ENTRIES + 1 }, () => "garbage");
    let entryReads = 0;
    const probed = new Proxy(raw, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) entryReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const validation = validateLineHighlights(probed);

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issue).toContain(String(MAX_LINE_HIGHLIGHT_INPUT_ENTRIES));
    }
    expect(entryReads).toBe(0);
  });

  test("rejects a line exceeding the per-line cap instead of truncating", () => {
    const marks = Array.from({ length: MAX_LINE_HIGHLIGHTS_PER_LINE + 1 }, (_, index) => ({
      side: "new" as const,
      line: 7,
      range: [index, index + 1] as const,
    }));
    const validation = validateLineHighlights(marks);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issue).toContain(String(MAX_LINE_HIGHLIGHTS_PER_LINE));
    }
  });
});
