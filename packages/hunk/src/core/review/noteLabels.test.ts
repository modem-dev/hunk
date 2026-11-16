import { describe, expect, test } from "bun:test";
import { buildReviewAnnotationIndexFromNotes } from "./annotations";
import { stmlColorTarget } from "./stml";
import {
  reviewNoteAge,
  reviewNoteAuthorLabel,
  reviewNoteRangeLabel,
  reviewNoteThreadTitle,
} from "./noteLabels";

describe("note labels", () => {
  test("ages a note compactly and leaves an unknown time blank", () => {
    const now = Date.parse("2026-08-30T12:00:00.000Z");
    expect(reviewNoteAge("2026-08-30T11:59:45.000Z", now)).toBe("now");
    expect(reviewNoteAge("2026-08-30T11:18:00.000Z", now)).toBe("42m");
    expect(reviewNoteAge("2026-08-28T12:00:00.000Z", now)).toBe("2d");
    expect(reviewNoteAge(undefined, now)).toBe("");
  });

  test("names the reviewer, an author, or an anonymous agent", () => {
    expect(reviewNoteAuthorLabel("user", "sonnet")).toBe("Your note");
    expect(reviewNoteAuthorLabel("agent", "  sonnet ")).toBe("sonnet");
    expect(reviewNoteAuthorLabel("ai", " ")).toBe("Agent note");
    expect(reviewNoteThreadTitle({ source: "agent" })).toBe("Agent note");
  });

  test("names lines GitHub-style, old side first", () => {
    expect(reviewNoteRangeLabel({ newRange: [12, 12] })).toBe("R12");
    expect(reviewNoteRangeLabel({ oldRange: [3, 5], newRange: [4, 6] })).toBe("L3–L5 → R4–R6");
    expect(reviewNoteRangeLabel({})).toBe("hunk");
  });
});

describe("buildReviewAnnotationIndexFromNotes", () => {
  test("marks intersecting and owner hunks, and files with context but no notes", () => {
    const index = buildReviewAnnotationIndexFromNotes(
      [
        { fileKey: "a", anchor: { intersectingHunkIndices: [1, 2] } },
        { fileKey: "a", anchor: { intersectingHunkIndices: [], ownerHunkIndex: 4 } },
      ],
      ["b"],
    );
    expect([...index.annotatedHunkIndicesByFileKey.get("a")!].sort()).toEqual([1, 2, 4]);
    expect(index.annotatedHunkIndicesByFileKey.has("b")).toBe(false);
    expect([...index.annotatedFileKeys].sort()).toEqual(["a", "b"]);
  });
});

describe("stmlColorTarget", () => {
  test("names a theme token, a literal color, or nothing", () => {
    expect(stmlColorTarget(" Success ")).toEqual({ kind: "theme", key: "addedSignColor" });
    expect(stmlColorTarget("#ABC")).toEqual({ kind: "literal", color: "#abc" });
    expect(stmlColorTarget("orange")).toEqual({ kind: "literal", color: "#e0873d" });
    expect(stmlColorTarget("chartreuse")).toBeUndefined();
    expect(stmlColorTarget(undefined)).toBeUndefined();
  });
});
