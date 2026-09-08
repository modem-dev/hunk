import { describe, expect, test } from "bun:test";
import { measureTextWidth } from "../lib/text";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import {
  formatHistoryDecorations,
  getHistoryCommitIdBounds,
  projectHistoryRecord,
  projectHistoryRow,
  renderHistoryContinuation,
  renderHistoryConvergence,
  renderHistoryGraph,
  resolveHistoryColor,
  resolveHistoryTheme,
} from "./staticProjection";

const commit: HistoryCommit = {
  revisionId: "a".repeat(40),
  displayId: "aaaaaaaa",
  parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
  subject: "Improve 日本語 rendering\x1b]52;c;cHdu\x07\nspoof",
  body: "First paragraph.\n\nSecond paragraph.",
  authorName: "Ada\rLovelace",
  authoredAt: "2026-01-02T03:04:05Z",
  decorations: [
    { kind: "head", label: "HEAD\x1b[2J", attachedLocalBranch: "main" },
    { kind: "local-branch", label: "main" },
    { kind: "remote-branch", label: "origin/main" },
    { kind: "tag", label: "v1.0.0" },
  ],
};
const row = planHistoryPage([commit]).rows[0]!;

describe("static history projection", () => {
  test("renders portable graph palettes", () => {
    expect(renderHistoryGraph(row, false)).toBe("●─┬");
    expect(renderHistoryGraph(row, true)).toBe("*-+");

    const octopus = planHistoryPage([{ ...commit, parentRevisionIds: ["b", "c", "d"] }]).rows[0]!;
    expect(renderHistoryGraph(octopus, false)).toBe("●─┬─┬");
    expect(renderHistoryGraph(octopus, true)).toBe("*-+-+");
  });

  test("sanitizes metadata and fits narrow output by display cells", () => {
    const text = projectHistoryRow(row, { ascii: false, color: false, width: 40 });
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\n");
    expect(text).toContain("aaaaaaaa");
  });

  test("reports the compact commit-id hit target in display cells", () => {
    const bounds = getHistoryCommitIdBounds(row);
    const text = projectHistoryRow(row, { ascii: false, color: false });
    expect(text.slice(bounds.start, bounds.end)).toBe("aaaaaaaa");
    expect(bounds.end - bounds.start).toBe(8);
  });

  test("honors actual sub-20-column terminal widths", () => {
    for (const width of [1, 8, 19]) {
      const lines = projectHistoryRecord(row, { ascii: false, color: false, width });
      expect(lines.every((line) => measureTextWidth(line) <= width)).toBe(true);
    }
  });

  test("keeps complete logical rows when width is omitted", () => {
    const text = projectHistoryRow(row, { ascii: true, color: false });
    expect(text).toContain("Improve 日本語 rendering");
    expect(text).toContain("AdaLovelace");
    expect(text).toContain("2026-01-02");
  });

  test("renders Git-like medium records with full metadata, bodies, and typed decorations", () => {
    const lines = projectHistoryRecord(row, { ascii: false, color: false });
    expect(lines.join("\n")).toContain(`commit ${"a".repeat(40)}`);
    expect(lines.join("\n")).toContain("Author: AdaLovelace");
    expect(lines.join("\n")).toContain("Date:   2026-01-02 03:04:05Z");
    expect(lines.join("\n")).toContain("First paragraph.");
    const continuation = renderHistoryContinuation(row, false);
    expect(lines[3]).toBe(continuation);
    expect(lines[4]).toBe(`${continuation}      Improve 日本語 renderingspoof`);
    expect(lines[5]).toBe(continuation);
    expect(lines[6]).toBe(`${continuation}      First paragraph.`);
    expect(lines.at(-1)).toBe(continuation);
    expect(formatHistoryDecorations(row)).toBe(" (HEAD -> main, origin/main, tag: v1.0.0)");
  });

  test("renders the golden no-fast-forward merge convergence", () => {
    const planned = planHistoryPage([
      { ...commit, revisionId: "merge", parentRevisionIds: ["main", "side"] },
      { ...commit, revisionId: "side", parentRevisionIds: ["main"], decorations: [] },
      { ...commit, revisionId: "main", parentRevisionIds: [], decorations: [] },
    ]);
    expect(renderHistoryConvergence(planned.rows[1]!, false)).toBe("│╯");
    expect(renderHistoryConvergence(planned.rows[1]!, true)).toBe("|/");
  });

  test("resolves colors through the shared Hunk theme catalog", () => {
    expect(resolveHistoryTheme("catppuccin-mocha").id).toBe("catppuccin-mocha");
  });

  test("honors explicit color over terminal conventions", () => {
    expect(
      resolveHistoryColor({ mode: "always", stdoutIsTTY: false, env: { NO_COLOR: "1" } }),
    ).toBe(true);
    expect(resolveHistoryColor({ mode: "auto", stdoutIsTTY: true, env: { NO_COLOR: "1" } })).toBe(
      false,
    );
    expect(resolveHistoryColor({ mode: "auto", stdoutIsTTY: true, env: { NO_COLOR: "" } })).toBe(
      false,
    );
    expect(resolveHistoryColor({ mode: "auto", stdoutIsTTY: true, env: { TERM: "dumb" } })).toBe(
      false,
    );
  });
});
