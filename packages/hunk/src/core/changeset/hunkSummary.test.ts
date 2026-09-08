import { describe, expect, test } from "bun:test";
import type { Hunk } from "@pierre/diffs";
import { createJsxFileViewLayout } from "../../../../../examples/extensions/jsx-file-view";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { createFileViewInput } from "../../ui/fileViews/host";
import { validateFileViewLayout } from "../../ui/fileViews/layout";
import { formatHunkHeader } from "./hunkHeader";
import { summarizeHunk } from "./hunkSummary";
import { reviewHunkRanges } from "../review/geometry";

describe("summarizeHunk", () => {
  test("summarizes every hunk Pierre parses with its header and inclusive spans", () => {
    // Two separated changes with zero context parse into two hunks.
    const file = createTestDiffFile({
      before: "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst stable = true;\n",
      after: "const alpha = 10;\nconst beta = 2;\nconst gamma = 30;\nconst stable = true;\n",
      context: 0,
    });
    expect(file.metadata.hunks.length).toBeGreaterThan(1);

    const summaries = file.metadata.hunks.map((hunk, index) => summarizeHunk(hunk, index));

    for (const [index, hunk] of file.metadata.hunks.entries()) {
      // Pierre includes a trailing line break in parsed specs. Raw formatting preserves it,
      // while the public summary boundary makes the same semantic header row-safe.
      expect(formatHunkHeader(hunk)).toMatch(/[\r\n]$/);
      expect(summaries[index]).toEqual({
        index,
        header: formatHunkHeader(hunk)
          .replace(/[\r\n]+/g, " ")
          .trimEnd(),
        ...reviewHunkRanges(hunk),
      });
      expect(summaries[index]!.header).toMatch(/^@@ -\d/);
      expect(summaries[index]!.header).not.toMatch(/[\r\n]/);
      expect(summaries[index]!.oldRange).toBeDefined();
      expect(summaries[index]!.newRange).toBeDefined();
    }

    const publicFile = createFileViewInput(file, 80, new AbortController().signal).file;
    const jsxLayout = createJsxFileViewLayout(publicFile);
    expect(jsxLayout).not.toBeNull();
    expect(validateFileViewLayout(jsxLayout, summaries.length, 80)).toMatchObject({ valid: true });
  });

  test("JSX example omits nonexistent added/deleted source sides", () => {
    const publicFile = createFileViewInput(
      createTestDiffFile(),
      80,
      new AbortController().signal,
    ).file;
    const template = publicFile.hunks?.[0];
    if (!template) throw new Error("Expected one parsed hunk");

    for (const [missingSide, firstOldRange, firstNewRange, secondOldRange, secondNewRange] of [
      ["old", [0, 0], [1, 1], [0, 0], [2, 2]],
      ["new", [1, 1], [0, 0], [2, 2], [0, 0]],
    ] as const) {
      const layout = createJsxFileViewLayout({
        ...publicFile,
        hunks: [
          {
            ...template,
            index: 0,
            oldRange: [...firstOldRange] as [number, number],
            newRange: [...firstNewRange] as [number, number],
          },
          {
            ...template,
            index: 1,
            oldRange: [...secondOldRange] as [number, number],
            newRange: [...secondNewRange] as [number, number],
          },
        ],
      });
      expect(layout).not.toBeNull();
      expect(validateFileViewLayout(layout, 2, 80)).toMatchObject({ valid: true });
      expect(
        layout?.rows
          .flatMap((row) => row.sourceRanges ?? [])
          .some((range) => range.side === missingSide),
      ).toBe(false);
    }
  });

  test("gives a synthesized hunk without line numbers no ranges instead of NaN spans", () => {
    // Transform validation only requires `hunkContent`, so this is the least
    // hunk an extension can legally put in front of the review UI.
    const bare = { hunkContent: [] } as unknown as Hunk;

    expect(summarizeHunk(bare, 3)).toEqual({ index: 3, header: "" });
  });

  test("normalizes CR/LF runs and trailing whitespace in a synthesized public header", () => {
    const declared = {
      hunkContent: [],
      hunkSpecs: "@@ synthesized @@\r\nfunction name\n\t",
    } as unknown as Hunk;

    expect(summarizeHunk(declared, 0)).toEqual({
      index: 0,
      header: "@@ synthesized @@ function name",
    });
  });
});
