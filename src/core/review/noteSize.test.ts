import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_NOTE_BYTES, reviewNoteByteLength, reviewNoteWithinSizeLimit } from "./noteSize";
import type { ReviewNoteV1 } from "./types";

const base: ReviewNoteV1 = {
  id: "note:1",
  source: "user",
  fileKey: "file:abc",
  anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
  summary: "",
  editable: true,
};

describe("review note size", () => {
  test("measures the whole note, framing included", () => {
    const empty = reviewNoteByteLength(base);
    expect(empty).toBeGreaterThan(0);
    expect(reviewNoteByteLength({ ...base, summary: "abc" })).toBe(empty + 3);
  });

  test("does not depend on the order the note's fields were assembled in", () => {
    const forward: ReviewNoteV1 = { ...base, summary: "s", rationale: "r" };
    const reversed = Object.fromEntries(
      Object.entries(forward).reverse(),
    ) as unknown as ReviewNoteV1;
    expect(reviewNoteByteLength(reversed)).toBe(reviewNoteByteLength(forward));
  });

  // Intent: the failure D1 names — every field under the limit, the note over it.
  test("rejects a note whose fields each fit but whose whole does not", () => {
    const oversized = {
      ...base,
      summary: "x".repeat(MAX_REVIEW_NOTE_BYTES - 1),
      rationale: "x".repeat(MAX_REVIEW_NOTE_BYTES - 1),
    };
    expect(reviewNoteWithinSizeLimit(oversized)).toBe(false);
  });

  test("counts multibyte text in bytes rather than characters", () => {
    const summary = "🧪".repeat(MAX_REVIEW_NOTE_BYTES / 4);
    expect(summary.length).toBeLessThan(MAX_REVIEW_NOTE_BYTES);
    expect(reviewNoteWithinSizeLimit({ ...base, summary })).toBe(false);
  });
});
