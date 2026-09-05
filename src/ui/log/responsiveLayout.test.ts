import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import { measureTextWidth } from "../lib/text";
import type { LogPresentation } from "./controller";
import { projectResponsiveLogRow, resolveLogResponsiveLayout } from "./responsiveLayout";

const commit: HistoryCommit = {
  revisionId: "a".repeat(40),
  displayId: "日本語a1",
  parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
  subject: "Responsive history title",
  body: "A useful description of the selected change.\n\nMore detail.",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.com",
  authoredAt: "2026-09-05T12:00:00Z",
  decorations: [
    { kind: "head", label: "HEAD", attachedLocalBranch: "main" },
    { kind: "local-branch", label: "main" },
    { kind: "tag", label: "v1.0.0" },
  ],
};
const row = planHistoryPage([commit]).rows[0]!;
const presentation: LogPresentation = {
  graph: true,
  unicode: true,
  author: true,
  date: true,
  decorations: true,
};

describe("responsive log layout", () => {
  test("selects one automatic density from actual width", () => {
    expect(resolveLogResponsiveLayout(120, 30)).toMatchObject({
      density: "wide",
      rowHeight: 4,
      visibleRows: 6,
    });
    expect(resolveLogResponsiveLayout(80, 24)).toMatchObject({
      density: "medium",
      rowHeight: 3,
      visibleRows: 7,
    });
    expect(resolveLogResponsiveLayout(42, 18)).toMatchObject({
      density: "narrow",
      rowHeight: 3,
      visibleRows: 5,
    });
  });

  test("keeps GitHub-style left metadata and a display-cell-correct right id", () => {
    const wide = projectResponsiveLogRow({
      row,
      presentation,
      layout: resolveLogResponsiveLayout(120, 30),
      width: 120,
    });
    expect(wide.title).toBe("Responsive history title");
    expect(wide.description).toContain("useful description");
    expect(wide.metadata).toContain("Ada Lovelace");
    expect(wide.metadata).toContain("2026-09-05");
    expect(wide.metadata).toContain("HEAD -> main");
    expect(wide.metadata).toContain("tag: v1.0.0");
    expect(wide.secondary).toBe("2 parents");
    expect(measureTextWidth(wide.displayId)).toBe(8);
    expect(wide.copyIcon).toBe("⧉");
    expect(wide.rightWidth).toBeGreaterThan(measureTextWidth(wide.displayId));
    expect(wide.graphWidth + wide.leftWidth + wide.rightWidth + 2).toBeLessThanOrEqual(118);
  });

  test("bounds many graph lanes while reserving the title and right-aligned id", () => {
    const manyLanes = Array.from({ length: 24 }, (_, index) => `lane-${index}`);
    const crowdedRow = {
      ...row,
      cells: manyLanes.map((_, index) => ({
        kind: index === 0 ? ("node" as const) : ("vertical" as const),
      })),
      lanesBefore: manyLanes,
      lanesAfter: manyLanes,
    };
    const projected = projectResponsiveLogRow({
      row: crowdedRow,
      presentation,
      layout: resolveLogResponsiveLayout(42, 18),
      width: 42,
    });
    expect(projected.graph).toEndWith("…");
    expect(projected.leftWidth).toBeGreaterThanOrEqual(12);
    expect(
      projected.graphWidth + projected.leftWidth + projected.rightWidth + projected.columnGap,
    ).toBeLessThanOrEqual(40);
    expect(projected.displayId).not.toBe("");
    expect(projected.copyIcon).toBe("⧉");
  });

  test("removes description and secondary state as room contracts", () => {
    const medium = projectResponsiveLogRow({
      row,
      presentation,
      layout: resolveLogResponsiveLayout(80, 24),
      width: 80,
    });
    expect(medium.description).toBe("");
    expect(medium.metadata).toContain("2026-09-05");
    expect(medium.secondary).toBe("");

    const narrow = projectResponsiveLogRow({
      row,
      presentation,
      layout: resolveLogResponsiveLayout(42, 18),
      width: 42,
    });
    expect(narrow.description).toBe("");
    expect(narrow.metadata).not.toContain("2026-09-05");
    expect(measureTextWidth(narrow.title)).toBeLessThanOrEqual(narrow.leftWidth);
    expect(measureTextWidth(narrow.displayId)).toBeLessThanOrEqual(narrow.rightWidth);
  });
});
