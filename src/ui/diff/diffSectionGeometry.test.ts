import { describe, expect, test } from "bun:test";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { measureDiffSectionGeometry } from "./diffSectionGeometry";
import { resolveTheme } from "../themes";
import {
  createTestDiffFile,
  createTestHeaderOnlyDiffFile,
  lines,
} from "../../../test/helpers/diff-helpers";

describe("measureDiffSectionGeometry", () => {
  const theme = resolveTheme("midnight", null);

  test("measures split and stack layouts from the render plan", () => {
    const file = createTestDiffFile();

    const split = measureDiffSectionGeometry(file, "split", true, theme);
    const stack = measureDiffSectionGeometry(file, "stack", true, theme);

    expect(split.bodyHeight).toBeGreaterThan(0);
    expect(stack.bodyHeight).toBeGreaterThan(split.bodyHeight);
    expect(split.hunkBounds.get(0)?.height).toBeGreaterThan(0);
    expect(stack.hunkBounds.get(0)?.height).toBeGreaterThan(split.hunkBounds.get(0)?.height ?? 0);
  });

  test("accounts for visible inline notes without moving the hunk anchor", () => {
    const file = createTestDiffFile();
    const visibleAgentNotes: VisibleAgentNote[] = [
      {
        id: "annotation:example:0",
        annotation: {
          newRange: [1, 1],
          rationale: "Keep note height in section geometry.",
          summary: "Explain the change",
        },
      },
    ];

    const baseGeometry = measureDiffSectionGeometry(file, "split", true, theme, [], 120);
    const noteGeometry = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      visibleAgentNotes,
      120,
    );

    expect(noteGeometry.bodyHeight).toBeGreaterThan(baseGeometry.bodyHeight);
    expect(noteGeometry.hunkAnchorRows.get(0)).toBe(baseGeometry.hunkAnchorRows.get(0));
    expect(noteGeometry.rowBounds.some((row) => row.key.startsWith("inline-note:"))).toBe(true);
  });

  test("wraps long rows into taller section geometry when wrapping is enabled", () => {
    const file = createTestDiffFile({
      before: lines("const alpha = 1;", "const beta = 2;"),
      after: lines(
        "const alpha = 1;",
        "const beta = 'this is a deliberately long line that should wrap in a narrow viewport';",
      ),
      id: "wrapped",
      path: "wrapped.ts",
    });

    const nowrapGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      [],
      32,
      true,
      false,
    );
    const wrappedGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      [],
      32,
      true,
      true,
    );

    expect(wrappedGeometry.bodyHeight).toBeGreaterThan(nowrapGeometry.bodyHeight);
    expect(wrappedGeometry.hunkBounds.get(0)?.height).toBeGreaterThan(
      nowrapGeometry.hunkBounds.get(0)?.height ?? 0,
    );
  });

  test("returns a one-row placeholder for files with no visible hunks", () => {
    const file = createTestDiffFile({
      after: "const stable = true;\n",
      before: "const stable = true;\n",
      id: "empty",
      path: "empty.ts",
    });

    const metrics = measureDiffSectionGeometry(file, "split", true, theme);

    expect(file.metadata.hunks).toHaveLength(0);
    expect(metrics.bodyHeight).toBe(1);
    expect(metrics.hunkBounds.size).toBe(0);
    expect(metrics.rowBounds).toEqual([]);
  });

  test("can measure a header-only hunk stream without line rows", () => {
    const file = createTestHeaderOnlyDiffFile();

    const metrics = measureDiffSectionGeometry(file, "split", true, theme);

    expect(file.metadata.hunks).toHaveLength(1);
    expect(metrics.bodyHeight).toBe(1);
    expect(metrics.hunkAnchorRows.size).toBe(1);
    expect(metrics.hunkAnchorRows.get(0)).toBe(0);
    expect(metrics.hunkBounds.get(0)).toMatchObject({ height: 1, top: 0 });
    expect(metrics.rowBounds).toHaveLength(1);
    expect(metrics.rowBounds[0]?.key).toContain(":header:");
  });

  test("expanding a collapsed gap grows section height by the synthesized row count", () => {
    // 30-line file with one change at line 5; trailing gap covers most of the file.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
    const after = before.replace("line 5\n", "line 5 modified\n");
    const file = createTestDiffFile({
      after,
      before,
      id: "expand",
      path: "expand.txt",
    });

    const collapsedGeometry = measureDiffSectionGeometry(file, "split", true, theme);
    const expandedGeometry = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [],
      0,
      true,
      false,
      new Set(["trailing:0"]),
      { kind: "loaded", text: after },
    );

    const synthesizedRowCount =
      expandedGeometry.rowBounds.length - collapsedGeometry.rowBounds.length;
    expect(synthesizedRowCount).toBeGreaterThan(0);
    expect(expandedGeometry.bodyHeight).toBe(collapsedGeometry.bodyHeight + synthesizedRowCount);
    // The leading hunk's anchor stays put because expansion happens after it.
    expect(expandedGeometry.hunkAnchorRows.get(0)).toBe(collapsedGeometry.hunkAnchorRows.get(0));
    // The trailing gap belongs to neither hunk: expanding it must not stretch
    // the preceding hunk's measured bounds.
    expect(expandedGeometry.hunkBounds.get(0)?.height).toBe(
      collapsedGeometry.hunkBounds.get(0)?.height,
    );
  });

  test("expanding a leading between-hunk gap does not shift the following hunk's anchor or bounds", () => {
    // File with one change near the end so a long leading gap precedes hunk 0.
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");
    const after = before.replace("line 35\n", "line 35 modified\n");
    const file = createTestDiffFile({
      after,
      before,
      id: "expand-leading",
      path: "leading.txt",
    });

    // Hide hunk headers so any "anchorable" row preceding the hunk's first
    // diff line can win the anchor — that's exactly the path the bug fix
    // needs to guard against.
    const showHunkHeaders = false;
    const collapsedGeometry = measureDiffSectionGeometry(
      file,
      "split",
      showHunkHeaders,
      theme,
      [],
      0,
      true,
      false,
    );
    const expandedGeometry = measureDiffSectionGeometry(
      file,
      "split",
      showHunkHeaders,
      theme,
      [],
      0,
      true,
      false,
      new Set(["before:0"]),
      { kind: "loaded", text: after },
    );

    const synthesizedRowCount =
      expandedGeometry.rowBounds.length - collapsedGeometry.rowBounds.length;
    expect(synthesizedRowCount).toBeGreaterThan(0);
    // The total body grows by the synthesized row count.
    expect(expandedGeometry.bodyHeight).toBe(collapsedGeometry.bodyHeight + synthesizedRowCount);
    // But hunk 0's bounds describe only the changed code — they must not
    // grow when the gap before it is expanded.
    expect(expandedGeometry.hunkBounds.get(0)?.height).toBe(
      collapsedGeometry.hunkBounds.get(0)?.height,
    );
    // And hunk 0's anchor lands on the first real diff row of the hunk,
    // pushed down by exactly the synthesized expansion rows, not on the
    // first expanded gap line itself.
    const collapsedAnchor = collapsedGeometry.hunkAnchorRows.get(0) ?? 0;
    const expandedAnchor = expandedGeometry.hunkAnchorRows.get(0) ?? 0;
    expect(expandedAnchor).toBe(collapsedAnchor + synthesizedRowCount);
  });

  test("expanded trailing context uses the expanded line-number width for wrap geometry", () => {
    const beforeLines = Array.from({ length: 1000 }, () => "x");
    beforeLines[4] = "old";
    beforeLines[999] = "abcdefghij";
    const afterLines = [...beforeLines];
    afterLines[4] = "new";
    const before = lines(...beforeLines);
    const after = lines(...afterLines);
    const file = createTestDiffFile({
      after,
      before,
      id: "large-expanded-gutter",
      path: "large-expanded-gutter.txt",
    });
    const expandedKeys = new Set(["trailing:0"]);
    const sourceStatus = { kind: "loaded", text: after } as const;

    const nowrapGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      [],
      20,
      true,
      false,
      expandedKeys,
      sourceStatus,
    );
    const wrappedGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      [],
      20,
      true,
      true,
      expandedKeys,
      sourceStatus,
    );

    expect(wrappedGeometry.bodyHeight).toBe(nowrapGeometry.bodyHeight + 1);
  });

  test("same-length source edits invalidate note-aware expanded geometry", () => {
    const beforeLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[4] = "line 5 modified";
    const file = createTestDiffFile({
      after: lines(...afterLines),
      before: lines(...beforeLines),
      id: "same-length-source",
      path: "same-length-source.txt",
    });
    const visibleAgentNotes: VisibleAgentNote[] = [
      {
        id: "annotation:same-length-source:0",
        annotation: {
          newRange: [5, 5],
          rationale: "Forces note-aware geometry caching.",
          summary: "Changed line",
        },
      },
    ];
    const expandedKeys = new Set(["trailing:0"]);
    const shortSourceLines = [...afterLines];
    const longSourceLines = [...afterLines];
    const shortLine = "short";
    const longLine = "this is a deliberately long expanded source line";
    shortSourceLines[0] += "x".repeat(longLine.length - shortLine.length);
    shortSourceLines[8] = shortLine;
    longSourceLines[8] = longLine;
    const shortSource = lines(...shortSourceLines);
    const longSource = lines(...longSourceLines);

    expect(shortSource).toHaveLength(longSource.length);

    const shortGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      visibleAgentNotes,
      24,
      true,
      true,
      expandedKeys,
      { kind: "loaded", text: shortSource },
    );
    const longGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      visibleAgentNotes,
      24,
      true,
      true,
      expandedKeys,
      { kind: "loaded", text: longSource },
    );

    expect(longGeometry.bodyHeight).toBeGreaterThan(shortGeometry.bodyHeight);
  });
});
