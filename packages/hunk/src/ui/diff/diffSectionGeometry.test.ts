import { describe, expect, test } from "bun:test";
import { createVisibleAgentNote, type VisibleAgentNote } from "../lib/agentAnnotations";
import { measureDiffSectionGeometry } from "./diffSectionGeometry";
import { resolveTheme } from "../themes";
import {
  createTestDiffFile,
  createTestHeaderOnlyDiffFile,
  lines,
} from "../../../../../test/helpers/diff-helpers";

describe("measureDiffSectionGeometry", () => {
  const theme = resolveTheme("github-dark-default", null);

  test("omits notes owned by scoped-out hunks and restores them when the scope clears", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
    const after = before.replace("line 5\n", "changed 5\n").replace("line 35\n", "changed 35\n");
    const file = createTestDiffFile({ before, after });
    expect(file.metadata.hunks).toHaveLength(2);
    const notes = [5, 35].map((line) =>
      createVisibleAgentNote(file.metadata.hunks, {
        id: `note-${line}`,
        annotation: { newRange: [line, line], summary: `Note ${line}` },
      }),
    );
    for (const layout of ["split", "unified"] as const) {
      const scoped = measureDiffSectionGeometry(
        file,
        layout,
        true,
        theme,
        notes,
        120,
        true,
        false,
        undefined,
        undefined,
        false,
        4,
        0,
        new Set([1]),
      );
      const scopedNotes = scoped.plannedRows.filter((row) => row.kind === "inline-note");
      expect(scopedNotes.map((row) => row.annotationId)).toEqual(["note-35"]);
      expect(scoped.hunkBounds.has(0)).toBe(false);
      expect(scoped.hunkBounds.has(1)).toBe(true);
      expect(scoped.plannedRows.map((row) => row.key)).toEqual(
        scoped.rowBounds.map((row) => row.key),
      );

      const restored = measureDiffSectionGeometry(
        file,
        layout,
        true,
        theme,
        notes,
        120,
        true,
        false,
      );
      expect(
        restored.plannedRows
          .filter((row) => row.kind === "inline-note")
          .map((row) => row.annotationId),
      ).toEqual(["note-5", "note-35"]);
      expect(restored.hunkBounds.has(0)).toBe(true);
      expect(restored.hunkBounds.has(1)).toBe(true);
    }
  });

  test("measures split and unified layouts from the render plan", () => {
    const file = createTestDiffFile();

    const split = measureDiffSectionGeometry(file, "split", true, theme);
    const unified = measureDiffSectionGeometry(file, "unified", true, theme);

    expect(split.bodyHeight).toBeGreaterThan(0);
    expect(unified.bodyHeight).toBeGreaterThan(split.bodyHeight);
    expect(split.hunkBounds.get(0)?.height).toBeGreaterThan(0);
    expect(unified.hunkBounds.get(0)?.height).toBeGreaterThan(split.hunkBounds.get(0)?.height ?? 0);
  });

  test("reuses no-note geometry for the same file and layout inputs", () => {
    const file = createTestDiffFile();

    const first = measureDiffSectionGeometry(file, "split", true, theme, [], 120, true, false);
    const second = measureDiffSectionGeometry(file, "split", true, theme, [], 120, true, false);
    const differentWidth = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [],
      121,
      true,
      false,
    );
    const differentAddNotePolicy = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [],
      120,
      true,
      false,
      undefined,
      undefined,
      true,
    );
    const differentTabWidth = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [],
      120,
      true,
      false,
      undefined,
      undefined,
      false,
      8,
    );
    const differentHunkGap = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [],
      120,
      true,
      false,
      undefined,
      undefined,
      false,
      4,
      2,
    );

    expect(second).toBe(first);
    expect(differentWidth).toBe(first);
    expect(differentAddNotePolicy).not.toBe(first);
    expect(differentTabWidth).not.toBe(first);
    expect(differentHunkGap).not.toBe(first);
    expect(differentHunkGap.bodyHeight).toBeGreaterThan(first.bodyHeight);
  });

  for (const layout of ["split", "unified"] as const) {
    test(`${layout} reuses nowrap geometry across zero, tiny, and normal widths with fresh-measurement parity`, () => {
      const before = Array.from({ length: 100 }, (_, index) => `\tline ${index + 1}\n`).join("");
      const after = before
        .replace("line 5\n", "line 5 modified\n")
        .replace("line 75\n", "line 75 modified\n");
      const file = createTestDiffFile({ before, after, id: "resize", path: "resize.txt" });
      const expandedKeys = new Set(["trailing:1"]);
      const sourceStatus = { kind: "loaded", text: after } as const;

      for (const showHeaders of [false, true]) {
        /** Measure the same expanded row stream under one fixed rendering policy. */
        const measure = (input: typeof file, width: number) =>
          measureDiffSectionGeometry(
            input,
            layout,
            showHeaders,
            theme,
            [],
            width,
            showHeaders,
            false,
            expandedKeys,
            sourceStatus,
            !showHeaders,
            showHeaders ? 4 : 8,
            2,
          );
        const first = measure(file, 0);
        const lazyGetter = Object.getOwnPropertyDescriptor(first, "plannedRows")?.get;
        expect(lazyGetter).toBeFunction();
        expect(first.hunkBounds.size).toBe(2);
        expect(first.rowBounds.some((row) => row.expandedGapKey)).toBe(true);

        for (const width of [1, 2, 9, 32, 160, 240, 200, 0, 160]) {
          const reused = measure(file, width);
          expect(reused).toBe(first);
          // A fresh file identity prevents cache reuse from masking width-dependent content.
          const fresh = measure({ ...file }, width);
          expect(reused).toEqual(fresh);
          expect(reused.plannedRows.map((row) => row.key)).toEqual(
            reused.rowBounds.map((row) => row.key),
          );
          for (const bounds of reused.rowBounds) {
            expect(reused.rowBoundsByKey.get(bounds.key)).toBe(bounds);
            expect(reused.rowBoundsByStableKey.get(bounds.stableKey)).toBe(bounds);
          }
        }
      }
    });
  }

  test("caches planned rows after the lazy geometry property is first read", () => {
    const geometry = measureDiffSectionGeometry(
      createTestDiffFile(),
      "split",
      true,
      theme,
      [],
      120,
      true,
      false,
    );

    const plannedRows = geometry.plannedRows;

    expect(plannedRows).toHaveLength(geometry.rowBounds.length);
    expect(geometry.plannedRows).toBe(plannedRows);
  });

  test("keeps lazy planned rows aligned with bounds after caller-owned inputs mutate", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
    const after = before.replace("line 5\n", "line 5 modified\n");
    const file = createTestDiffFile({ after, before, id: "snapshot", path: "snapshot.txt" });
    const expandedKeys = new Set(["trailing:0"]);
    const visibleAgentNotes: VisibleAgentNote[] = [
      createVisibleAgentNote(file.metadata.hunks, {
        id: "original-note",
        annotation: { newRange: [5, 5], summary: "Original note." },
      }),
    ];
    const geometry = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      visibleAgentNotes,
      120,
      true,
      false,
      expandedKeys,
      { kind: "loaded", text: after },
    );

    expandedKeys.clear();
    visibleAgentNotes[0]!.annotation.newRange = [1, 1];
    visibleAgentNotes[0]!.annotation.summary = "Mutated after geometry measurement.";
    visibleAgentNotes.push(
      createVisibleAgentNote(file.metadata.hunks, {
        id: "late-note",
        annotation: { newRange: [1, 1], summary: "Added after geometry measurement." },
      }),
    );

    const plannedRows = geometry.plannedRows;
    expect(plannedRows.map((row) => row.key)).toEqual(
      geometry.rowBounds.map((bounds) => bounds.key),
    );
    expect(plannedRows.find((row) => row.kind === "inline-note")?.annotation.summary).toBe(
      "Original note.",
    );
  });

  test("reuses the nowrap base while replacing only the bounded note width slot", () => {
    const file = createTestDiffFile();
    const visibleAgentNotes: VisibleAgentNote[] = [
      createVisibleAgentNote(file.metadata.hunks, {
        id: "annotation:example:0",
        annotation: {
          newRange: [1, 1],
          rationale: "Keep a note-aware geometry slot.",
          summary: "Explain this change with a long inline note. ".repeat(20),
        },
      }),
    ];

    const width100 = measureDiffSectionGeometry(file, "split", true, theme, [], 100, true, false);
    const noteWidth100 = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      visibleAgentNotes,
      100,
      true,
      false,
    );
    const width101 = measureDiffSectionGeometry(file, "split", true, theme, [], 101, true, false);

    expect(width101).toBe(width100);
    expect(measureDiffSectionGeometry(file, "split", true, theme, visibleAgentNotes, 100)).toBe(
      noteWidth100,
    );
    const noteWidth200 = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      visibleAgentNotes,
      200,
    );
    expect(noteWidth200).not.toBe(noteWidth100);
    expect(noteWidth200.bodyHeight).toBeLessThan(noteWidth100.bodyHeight);
    expect(measureDiffSectionGeometry(file, "split", true, theme, [], 200)).toBe(width100);
    expect(measureDiffSectionGeometry(file, "split", true, theme, visibleAgentNotes, 100)).not.toBe(
      noteWidth100,
    );
  });

  test("accounts for visible inline notes without moving the hunk anchor", () => {
    const file = createTestDiffFile();
    const visibleAgentNotes: VisibleAgentNote[] = [
      createVisibleAgentNote(file.metadata.hunks, {
        id: "annotation:example:0",
        annotation: {
          newRange: [1, 1],
          rationale: "Keep note height in section geometry.",
          summary: "Explain the change",
        },
      }),
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

  test("reuses note-aware geometry across equivalent note arrays", () => {
    const file = createTestDiffFile();
    const buildNotes = (summary: string): VisibleAgentNote[] => [
      createVisibleAgentNote(file.metadata.hunks, {
        id: "annotation:example:0",
        annotation: {
          newRange: [1, 1],
          rationale: "Keep note height in section geometry.",
          summary,
        },
      }),
    ];

    const first = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      buildNotes("Explain"),
      120,
    );
    const sameContent = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      buildNotes("Explain"),
      120,
    );
    const changedSummary = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      buildNotes("Explain this change with enough words to wrap onto another note line."),
      120,
    );

    expect(sameContent).toBe(first);
    expect(changedSummary).not.toBe(first);
    expect(changedSummary.bodyHeight).toBeGreaterThan(first.bodyHeight);
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
      "unified",
      true,
      theme,
      [],
      32,
      true,
      false,
    );
    const wrappedGeometry = measureDiffSectionGeometry(
      file,
      "unified",
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

  for (const layout of ["split", "unified"] as const) {
    test(`${layout} replaces bounded wrapped width variants and preserves wrap/layout invalidation`, () => {
      const file = createTestDiffFile({
        before: "old\n",
        after: `${"long code ".repeat(40)}\n`,
        id: "width-sensitive",
        path: "long.txt",
      });
      const narrow = measureDiffSectionGeometry(file, layout, true, theme, [], 32, true, true);
      const wide = measureDiffSectionGeometry(file, layout, true, theme, [], 200, true, true);
      expect(wide).not.toBe(narrow);
      expect(wide.bodyHeight).toBeLessThan(narrow.bodyHeight);
      expect(measureDiffSectionGeometry(file, layout, true, theme, [], 200, true, true)).toBe(wide);
      expect(measureDiffSectionGeometry(file, layout, true, theme, [], 32, true, true)).not.toBe(
        narrow,
      );
      const nowrap = measureDiffSectionGeometry(file, layout, true, theme, [], 32);
      expect(nowrap).not.toBe(narrow);
      expect(nowrap.bodyHeight).toBeLessThan(narrow.bodyHeight);
      expect(
        measureDiffSectionGeometry(
          file,
          layout === "split" ? "unified" : "split",
          true,
          theme,
          [],
          32,
        ),
      ).not.toBe(nowrap);
    });
  }

  test("nowrap expanded geometry invalidates source status and same-length source edits", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
    const after = before.replace("line 5\n", "line 5 modified\n");
    const file = createTestDiffFile({ before, after, id: "source", path: "source.txt" });
    const expandedKeys = new Set(["trailing:0"]);
    const statuses = [
      undefined,
      { kind: "loading" },
      { kind: "error" },
      { kind: "loaded", text: after },
      { kind: "loaded", text: after.replace("line 20", "edit 20") },
    ] as const;
    let previous = measureDiffSectionGeometry(file, "split", true, theme, [], 100);
    for (const status of statuses) {
      const geometry = measureDiffSectionGeometry(
        file,
        "split",
        true,
        theme,
        [],
        120,
        true,
        false,
        expandedKeys,
        status,
      );
      expect(geometry).not.toBe(previous);
      expect(geometry).toEqual(
        measureDiffSectionGeometry(
          { ...file },
          "split",
          true,
          theme,
          [],
          1,
          true,
          false,
          expandedKeys,
          status,
        ),
      );
      previous = geometry;
    }
    expect(JSON.stringify(previous.plannedRows)).toContain("edit 20");
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
      "unified",
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
      "unified",
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
      createVisibleAgentNote(file.metadata.hunks, {
        id: "annotation:same-length-source:0",
        annotation: {
          newRange: [5, 5],
          rationale: "Forces note-aware geometry caching.",
          summary: "Changed line",
        },
      }),
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
      "unified",
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
      "unified",
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
