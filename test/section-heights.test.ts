import { describe, expect, test } from "bun:test";
import type { VisibleAgentNote } from "../src/ui/lib/agentAnnotations";
import { measureDiffSectionMetrics } from "../src/ui/lib/sectionHeights";
import { resolveTheme } from "../src/ui/themes";
import { createDiffFile, createHeaderOnlyDiffFile, lines } from "./fixtures/diff-helpers";

describe("measureDiffSectionMetrics", () => {
  const theme = resolveTheme("midnight", null);

  test("measures split and stack layouts from the render plan", () => {
    const file = createDiffFile();

    const split = measureDiffSectionMetrics(file, "split", true, theme);
    const stack = measureDiffSectionMetrics(file, "stack", true, theme);

    expect(split.bodyHeight).toBeGreaterThan(0);
    expect(stack.bodyHeight).toBeGreaterThan(split.bodyHeight);
    expect(split.hunkBounds.get(0)?.height).toBeGreaterThan(0);
    expect(stack.hunkBounds.get(0)?.height).toBeGreaterThan(split.hunkBounds.get(0)?.height ?? 0);
  });

  test("accounts for visible inline notes without moving the hunk anchor", () => {
    const file = createDiffFile();
    const visibleAgentNotes: VisibleAgentNote[] = [
      {
        id: "annotation:example:0",
        annotation: {
          newRange: [1, 1],
          rationale: "Keep note height in section metrics.",
          summary: "Explain the change",
        },
      },
    ];

    const baseMetrics = measureDiffSectionMetrics(file, "split", true, theme, [], 120);
    const noteMetrics = measureDiffSectionMetrics(
      file,
      "split",
      true,
      theme,
      visibleAgentNotes,
      120,
    );

    expect(noteMetrics.bodyHeight).toBeGreaterThan(baseMetrics.bodyHeight);
    expect(noteMetrics.hunkAnchorRows.get(0)).toBe(baseMetrics.hunkAnchorRows.get(0));
    expect(noteMetrics.rowMetrics.some((row) => row.key.startsWith("inline-note:"))).toBe(true);
  });

  test("wraps long rows into taller section metrics when wrapping is enabled", () => {
    const file = createDiffFile({
      before: lines("const alpha = 1;", "const beta = 2;"),
      after: lines(
        "const alpha = 1;",
        "const beta = 'this is a deliberately long line that should wrap in a narrow viewport';",
      ),
      id: "wrapped",
      path: "wrapped.ts",
    });

    const nowrapMetrics = measureDiffSectionMetrics(
      file,
      "stack",
      true,
      theme,
      [],
      32,
      true,
      false,
    );
    const wrappedMetrics = measureDiffSectionMetrics(
      file,
      "stack",
      true,
      theme,
      [],
      32,
      true,
      true,
    );

    expect(wrappedMetrics.bodyHeight).toBeGreaterThan(nowrapMetrics.bodyHeight);
    expect(wrappedMetrics.hunkBounds.get(0)?.height).toBeGreaterThan(
      nowrapMetrics.hunkBounds.get(0)?.height ?? 0,
    );
  });

  test("returns a one-row placeholder for files with no visible hunks", () => {
    const file = createDiffFile({
      after: "const stable = true;\n",
      before: "const stable = true;\n",
      id: "empty",
      path: "empty.ts",
    });

    const metrics = measureDiffSectionMetrics(file, "split", true, theme);

    expect(file.metadata.hunks).toHaveLength(0);
    expect(metrics.bodyHeight).toBe(1);
    expect(metrics.hunkBounds.size).toBe(0);
    expect(metrics.rowMetrics).toEqual([]);
  });

  test("can measure a header-only hunk stream without line rows", () => {
    const file = createHeaderOnlyDiffFile();

    const metrics = measureDiffSectionMetrics(file, "split", true, theme);

    expect(file.metadata.hunks).toHaveLength(1);
    expect(metrics.bodyHeight).toBe(1);
    expect(metrics.hunkAnchorRows.size).toBe(1);
    expect(metrics.hunkAnchorRows.get(0)).toBe(0);
    expect(metrics.hunkBounds.get(0)).toMatchObject({ height: 1, top: 0 });
    expect(metrics.rowMetrics).toHaveLength(1);
    expect(metrics.rowMetrics[0]?.key).toContain(":header:");
  });
});
