import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import {
  buildLiveComment,
  findDiffFileByPath,
  findHunkIndexForLine,
  firstCommentTargetForHunk,
  hunkLineRange,
  resolveCommentTarget,
} from "../src/core/liveComments";
import type { DiffFile } from "../src/core/types";

function createDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "src/example.ts",
      contents: [
        "export const alpha = 1;",
        "export const keep = true;",
        "export const beta = 1;",
        "",
      ].join("\n"),
      cacheKey: "before",
    },
    {
      name: "src/example.ts",
      contents: [
        "export const alpha = 2;",
        "export const keep = true;",
        "export const beta = 2;",
        "export const gamma = true;",
        "",
      ].join("\n"),
      cacheKey: "after",
    },
    { context: 3 },
    true,
  );

  let additions = 0;
  let deletions = 0;
  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return {
    id: "file:example",
    path: "src/example.ts",
    previousPath: "src/example-old.ts",
    patch: "",
    language: "typescript",
    stats: { additions, deletions },
    metadata,
    agent: null,
  };
}

function createLateChangeDiffFile(): DiffFile {
  const beforeLines = Array.from(
    { length: 10 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[9] = "export const line10 = 100;";

  const metadata = parseDiffFromFile(
    {
      name: "src/late.ts",
      contents: `${beforeLines.join("\n")}\n`,
      cacheKey: "late-before",
    },
    {
      name: "src/late.ts",
      contents: `${afterLines.join("\n")}\n`,
      cacheKey: "late-after",
    },
    { context: 3 },
    true,
  );

  return {
    id: "file:late",
    path: "src/late.ts",
    patch: "",
    language: "typescript",
    stats: { additions: 1, deletions: 1 },
    metadata,
    agent: null,
  };
}

describe("live comment helpers", () => {
  test("finds a diff file by current or previous path", () => {
    const file = createDiffFile();

    expect(findDiffFileByPath([file], "src/example.ts")?.id).toBe(file.id);
    expect(findDiffFileByPath([file], "src/example-old.ts")?.id).toBe(file.id);
    expect(findDiffFileByPath([file], "missing.ts")).toBeUndefined();
  });

  test("maps old/new line numbers onto the covering hunk", () => {
    const file = createDiffFile();

    expect(findHunkIndexForLine(file, "old", 1)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 2)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 40)).toBe(-1);
  });

  test("resolves hunk-targeted comments to the first changed line on the preferred side", () => {
    const file = createLateChangeDiffFile();
    const target = resolveCommentTarget(file, {
      filePath: "src/late.ts",
      hunkIndex: 0,
      summary: "Late change",
    });

    expect(target).toEqual({
      hunkIndex: 0,
      side: "new",
      line: 10,
    });
  });

  test("prefers a later addition over an earlier deletion-only chunk", () => {
    const target = firstCommentTargetForHunk({
      additionStart: 20,
      additionLines: 1,
      deletionStart: 20,
      deletionLines: 1,
      hunkContent: [
        { type: "change", deletions: 1, additions: 0 },
        { type: "context", lines: 2 },
        { type: "change", deletions: 0, additions: 1 },
      ],
    } as Parameters<typeof firstCommentTargetForHunk>[0]);

    expect(target).toEqual({
      side: "new",
      line: 22,
    });
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
    const file = createDiffFile();
    const range = hunkLineRange(file.metadata.hunks[0]!);

    expect(range.oldRange[0]).toBeLessThanOrEqual(1);
    expect(range.oldRange[1]).toBeGreaterThanOrEqual(2);
    expect(range.newRange[0]).toBeLessThanOrEqual(1);
    expect(range.newRange[1]).toBeGreaterThanOrEqual(2);
  });
});
