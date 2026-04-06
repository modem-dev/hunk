import { describe, expect, test } from "bun:test";
import type { VisibleAgentNote } from "./agentAnnotations";
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
});
