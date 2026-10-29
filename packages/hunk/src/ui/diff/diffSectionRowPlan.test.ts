import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../core/changeset/model";
import { resolveTheme } from "../themes";
import { buildDiffSectionRowPlan, type BuildDiffSectionRowPlanOptions } from "./diffSectionRowPlan";

const { buildSplitRows, buildUnifiedRows } = await import("./diffRows");

function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

/** Two hunks with unchanged lines before, between, and after them. */
function createDiffFile(id: string, path: string): DiffFile {
  const before = lines(...Array.from({ length: 120 }, (_, i) => `line ${i + 1}`));
  const after = before
    .replace("line 50\n", "line 50 changed\n")
    .replace("line 100\n", "line 100 changed\n");
  return {
    id,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: 2, deletions: 2 },
    metadata: parseDiffFromFile(
      { name: path, contents: before, cacheKey: `${id}:before` },
      { name: path, contents: after, cacheKey: `${id}:after` },
      { context: 3 },
      true,
    ),
    agent: null,
  };
}

function collapsedRowCounts(rows: ReturnType<typeof buildSplitRows>) {
  return rows.filter((row) => row.type === "collapsed").map((row) => row.text);
}

describe("presentation scope gap rows (#1235 regression)", () => {
  const theme = resolveTheme("github-dark-default", null);

  const plan = (options: {
    layout: "split" | "unified";
    visibleHunkIndexes?: ReadonlySet<number>;
    expandedKeys?: ReadonlySet<string>;
    sourceStatus?: { kind: "loaded"; text: string };
  }) =>
    buildDiffSectionRowPlan({
      file: createDiffFile("scope-gaps", "scope-gaps.ts"),
      layout: options.layout,
      showHunkHeaders: true,
      theme,
      expandedKeys: options.expandedKeys,
      sourceStatus:
        options.sourceStatus === undefined
          ? undefined
          : { kind: "loaded", text: options.sourceStatus.text },
      visibleHunkIndexes: options.visibleHunkIndexes,
    } satisfies Omit<BuildDiffSectionRowPlanOptions, "showHunkHeaders" | "layout"> & {
      layout: "split" | "unified";
      showHunkHeaders: boolean;
    });

  for (const layout of ["split", "unified"] as const) {
    const collapsedPlannedRows = (
      plannedRows: ReturnType<typeof buildDiffSectionRowPlan>["plannedRows"],
    ) => plannedRows.filter((row) => row.kind === "diff-row" && row.row.type === "collapsed");

    test(`full-file scope renders the same gap rows as no scope (${layout})`, () => {
      const allHunkIndexes = new Set([0, 1]);
      expect(plan({ layout }).plannedRows).toEqual(
        plan({ layout, visibleHunkIndexes: allHunkIndexes }).plannedRows,
      );
    });

    test(`partial scope still suppresses gap rows (${layout})`, () => {
      const unscoped = collapsedRowCounts(
        layout === "split"
          ? buildSplitRows(createDiffFile("partial", "partial.ts"), null, theme)
          : buildUnifiedRows(createDiffFile("partial", "partial.ts"), null, theme),
      );
      const scopedPlan = plan({ layout, visibleHunkIndexes: new Set([1]) });
      const planned = collapsedPlannedRows(scopedPlan.plannedRows);
      expect(unscoped.length).toBeGreaterThan(0);
      expect(planned).toEqual([]);
    });

    test(`full-file scope still expands collapsed gaps (${layout})`, () => {
      const expanded = plan({
        layout,
        visibleHunkIndexes: new Set([0, 1]),
        expandedKeys: new Set(["before:0", "before:1"]),
        sourceStatus: {
          kind: "loaded",
          text: Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
        },
      });
      const expandedRowKeys = expanded.plannedRows
        .filter((row) => row.kind === "diff-row")
        .map((row) => (row.row as { key: string }).key)
        .filter((key) => key.includes(":expanded:"));
      expect(expandedRowKeys.length).toBeGreaterThan(0);
    });
  }
});
