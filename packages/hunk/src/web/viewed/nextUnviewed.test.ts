import { describe, expect, test } from "bun:test";
import { nextUnviewedFile } from "./nextUnviewed";
import type { ReviewViewedStatus } from "./viewedFiles";

const files = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];

/** Statuses for the test files, every unnamed file unviewed. */
function testStatuses(marks: Record<string, ReviewViewedStatus>) {
  return new Map(files.map((file) => [file.key, marks[file.key] ?? "unviewed"] as const));
}

describe("nextUnviewedFile", () => {
  test("picks the file after the selected one", () => {
    expect(nextUnviewedFile(files, "a", testStatuses({}))?.key).toBe("b");
  });

  test("skips viewed files", () => {
    expect(nextUnviewedFile(files, "a", testStatuses({ b: "viewed", c: "viewed" }))?.key).toBe("d");
  });

  test("wraps to the start of the review", () => {
    expect(nextUnviewedFile(files, "c", testStatuses({ d: "viewed" }))?.key).toBe("a");
  });

  test("counts a file changed since it was viewed as unviewed", () => {
    expect(nextUnviewedFile(files, "a", testStatuses({ b: "changed" }))?.key).toBe("b");
  });

  test("points at the selected file when it is the only one left", () => {
    const statuses = testStatuses({ a: "viewed", c: "viewed", d: "viewed" });
    expect(nextUnviewedFile(files, "b", statuses)?.key).toBe("b");
  });

  test("starts at the first file without a selection, or with one outside the list", () => {
    expect(nextUnviewedFile(files, null, testStatuses({}))?.key).toBe("a");
    expect(nextUnviewedFile(files, "gone", testStatuses({ a: "viewed" }))?.key).toBe("b");
  });

  test("treats a file with no status yet as unviewed", () => {
    expect(nextUnviewedFile(files, "a", new Map())?.key).toBe("b");
  });

  test("returns nothing when every file is viewed, or there are none", () => {
    const all = testStatuses({ a: "viewed", b: "viewed", c: "viewed", d: "viewed" });
    expect(nextUnviewedFile(files, "a", all)).toBeUndefined();
    expect(nextUnviewedFile([], null, new Map())).toBeUndefined();
  });
});
