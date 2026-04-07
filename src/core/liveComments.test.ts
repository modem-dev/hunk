import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";
import {
  buildLiveComment,
  findDiffFileByPath,
  findHunkIndexForLine,
  hunkLineRange,
} from "./liveComments";

function createExampleDiffFile() {
  return createTestDiffFile({
    after: lines(
      "export const alpha = 2;",
      "export const keep = true;",
      "export const beta = 2;",
      "export const gamma = true;",
    ),
    before: lines("export const alpha = 1;", "export const keep = true;", "export const beta = 1;"),
    context: 3,
    id: "file:example",
    path: "src/example.ts",
    previousPath: "src/example-old.ts",
  });
}

describe("live comment helpers", () => {
  test("finds a diff file by current or previous path", () => {
    const file = createExampleDiffFile();

    expect(findDiffFileByPath([file], "src/example.ts")?.id).toBe(file.id);
    expect(findDiffFileByPath([file], "src/example-old.ts")?.id).toBe(file.id);
    expect(findDiffFileByPath([file], "missing.ts")).toBeUndefined();
  });

  test("maps old/new line numbers onto the covering hunk", () => {
    const file = createExampleDiffFile();

    expect(findHunkIndexForLine(file, "old", 1)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 2)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 40)).toBe(-1);
  });

  test("builds a live MCP comment annotation", () => {
    const comment = buildLiveComment(
      {
        filePath: "src/example.ts",
        side: "new",
        line: 4,
        summary: "Note",
        rationale: "Why this matters",
        author: "Pi",
      },
      "comment-1",
      "2026-03-22T00:00:00.000Z",
      0,
    );

    expect(comment).toMatchObject({
      id: "comment-1",
      source: "mcp",
      author: "Pi",
      filePath: "src/example.ts",
      hunkIndex: 0,
      side: "new",
      line: 4,
      summary: "Note",
      rationale: "Why this matters",
      newRange: [4, 4],
      tags: ["mcp"],
    });
  });

  test("computes inclusive single-line hunk ranges", () => {
    const file = createExampleDiffFile();
    const range = hunkLineRange(file.metadata.hunks[0]!);

    expect(range.oldRange[0]).toBeLessThanOrEqual(1);
    expect(range.oldRange[1]).toBeGreaterThanOrEqual(2);
    expect(range.newRange[0]).toBeLessThanOrEqual(1);
    expect(range.newRange[1]).toBeGreaterThanOrEqual(2);
  });
});
