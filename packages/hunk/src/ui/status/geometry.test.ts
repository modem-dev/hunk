import { expect, test } from "bun:test";
import { createTestStatusRuntime } from "../../../../../test/helpers/status-runtime";
import { StatusController } from "./controller";
import { moveStatusFocus, planStatusViewport, projectStatusRows } from "./geometry";
import { statusPlainText } from "./staticProjection";
import { measureTextWidth } from "../lib/text";

test("wide and narrow rows expose mixed states without selection-dependent metadata", () => {
  const runtime = createTestStatusRuntime();
  runtime.snapshot.paths[0]!.path = "界界\nfile.ts";
  const controller = new StatusController(runtime);
  for (const width of [28, 60, 140]) {
    const before = projectStatusRows(controller.getSnapshot(), width);
    controller.select("path:beta.ts");
    expect(projectStatusRows(controller.getSnapshot(), width)).toEqual(before);
    for (const row of before)
      for (const line of row.lines)
        expect(measureTextWidth(statusPlainText(line))).toBeLessThanOrEqual(width - 2);
    expect(
      before
        .flatMap((row) => row.lines)
        .map(statusPlainText)
        .join(" "),
    ).toContain("\\nfile.ts");
    expect(
      before
        .flatMap((row) => row.lines)
        .map(statusPlainText)
        .join(" "),
    ).toContain("modified (staged)");
    expect(
      before
        .flatMap((row) => row.lines)
        .map(statusPlainText)
        .join(" "),
    ).toContain("beta.ts");
  }
});

test("short viewport retains focused row and bounded expansion stays in the same row stream", () => {
  const controller = new StatusController(createTestStatusRuntime());
  const rows = projectStatusRows(controller.getSnapshot(), 60);
  const viewport = planStatusViewport(rows, "path:beta.ts", 0, 2);
  expect(viewport.lines.some((line) => line.row.id === "path:beta.ts")).toBe(true);
  expect(viewport.lines.length).toBeLessThanOrEqual(2);
});

test("oversized focused rows retain intra-row scrolling through resize and reach both ends", () => {
  const rows = [
    {
      id: "long",
      kind: "path" as const,
      lines: Array.from({ length: 20 }, (_, i) => [{ text: String(i), role: "text" as const }]),
    },
  ];
  expect(planStatusViewport(rows, "long", 8, 3).top).toBe(8);
  expect(planStatusViewport(rows, "long", 18, 3).lines.map((line) => line.text)).toEqual([
    "17",
    "18",
    "19",
  ]);
  expect(planStatusViewport(rows, "long", 8, 6).top).toBe(8);
  let position = { selected: "long" as string | null, top: 0 };
  for (let i = 0; i < 20; i++)
    position = moveStatusFocus(rows, position.selected, position.top, 3, 1);
  expect(position).toEqual({ selected: "long", top: 17 });
  for (let i = 0; i < 6; i++)
    position = moveStatusFocus(rows, position.selected, position.top, 3, -3);
  expect(position).toEqual({ selected: "long", top: 0 });
});

test("styled wrapping preserves complete rename/submodule facts and the in-flow worktree boundary", () => {
  const runtime = createTestStatusRuntime();
  runtime.snapshot.paths = [
    {
      path: "nested/界界/  new name.ts",
      previousPath: "old/  name.ts",
      index: "renamed",
      worktree: "modified",
      conflict: true,
      submodule: { commitChanged: true, trackedChanges: true, untrackedChanges: true },
    },
  ];
  const controller = new StatusController(runtime);
  for (const width of [20, 30, 42, 120]) {
    const rows = projectStatusRows(controller.getSnapshot(), width);
    const path = rows.find((row) => row.kind === "path")!;
    const content = path.lines.map((line) => statusPlainText(line).slice(2)).join("");
    expect(content).toContain("old/  name.ts -> nested/界界/  new name.ts");
    expect(content).toContain(
      "conflict · submodule commit changed tracked changes untracked changes",
    );
    expect(
      path.lines
        .flat()
        .filter((span) => span.role === "staged")
        .map((span) => span.text)
        .join(""),
    ).toBe("renamed (staged)");
    expect(
      path.lines
        .flat()
        .filter((span) => span.role === "unstaged")
        .map((span) => span.text)
        .join(""),
    ).toBe("modified (unstaged)");
    const boundary = rows.find((row) => row.id === "worktrees")!;
    expect(boundary.lines[0]).toEqual([]);
    expect(boundary.lines.map(statusPlainText).join("")).toBe("── Other worktrees ──");
    const sibling = rows.find((row) => row.kind === "worktree")!;
    expect(
      sibling.lines
        .flat()
        .filter((span) => span.role === "accent")
        .map((span) => span.text)
        .join(""),
    ).toBe("sibling-branch");
    expect(
      sibling.lines
        .flat()
        .filter((span) => span.role === "muted")
        .map((span) => span.text)
        .join(""),
    ).toContain("status-test-sibling");
    for (const row of rows)
      for (const line of row.lines)
        expect(measureTextWidth(statusPlainText(line))).toBeLessThanOrEqual(width - 2);
  }
});

for (const tracked of [0, 1, 10, 11, 25]) {
  for (const untracked of [0, 1, 10, 11, 25]) {
    test(`file groups bound records independently: ${tracked} tracked / ${untracked} untracked`, () => {
      const runtime = createTestStatusRuntime();
      runtime.snapshot.paths = [
        ...Array.from({ length: tracked }, (_, i) => ({
          path: `tracked/${i}/a-long-name.ts`,
          index: "modified" as const,
          worktree: "modified" as const,
          conflict: false,
        })),
        ...Array.from({ length: untracked }, (_, i) => ({
          path: `untracked/${i}/a-long-name.ts`,
          index: "unchanged" as const,
          worktree: "untracked" as const,
          conflict: false,
        })),
      ];
      // Duplicate destinations cannot inflate a group count or consume its visible record cap.
      if (runtime.snapshot.paths[0]) runtime.snapshot.paths.push(runtime.snapshot.paths[0]);
      const controller = new StatusController(runtime);
      const rows = () => projectStatusRows(controller.getSnapshot(), 22);
      const paths = () => rows().filter((row) => row.kind === "path");
      expect(paths()).toHaveLength(Math.min(10, tracked) + Math.min(10, untracked));
      for (const [id, count] of [
        ["tracked", tracked],
        ["untracked", untracked],
      ] as const) {
        const group = rows().find((row) => row.id === `group:${id}`)!;
        expect(group.lines.map(statusPlainText).join("")).toContain(`(${count})`);
        expect(rows().some((row) => row.id === `toggle:${id}`)).toBe(count > 10);
      }
      for (const path of paths()) {
        expect(path.lines.length).toBeGreaterThan(1);
        for (const line of path.lines) {
          expect(statusPlainText(line).startsWith("  ")).toBe(true);
          expect(measureTextWidth(statusPlainText(line))).toBeLessThanOrEqual(20);
        }
      }
      const selected = controller.getSnapshot().selected;
      controller.togglePathGroup("tracked");
      expect(controller.getSnapshot().selected).toBe(selected);
      expect(paths()).toHaveLength(tracked + Math.min(10, untracked));
      controller.togglePathGroup("untracked");
      expect(paths()).toHaveLength(tracked + untracked);
      controller.togglePathGroup("tracked");
      expect(paths()).toHaveLength(Math.min(10, tracked) + untracked);
      expect(rows().find((row) => row.id === "worktrees")!.lines[0]).toEqual([]);
    });
  }
}

test("collapsing a selected hidden path focuses its toggle and reconciles the viewport", () => {
  const runtime = createTestStatusRuntime();
  runtime.snapshot.paths = Array.from({ length: 25 }, (_, i) => ({
    path: `file-${i}.ts`,
    index: "unchanged",
    worktree: "modified",
    conflict: false,
  }));
  const controller = new StatusController(runtime);
  controller.togglePathGroup("tracked");
  controller.select("path:file-24.ts", 100);
  controller.togglePathGroup("tracked");
  const state = controller.getSnapshot();
  expect(state.selected).toBe("toggle:tracked");
  const rows = projectStatusRows(state, 45);
  const viewport = planStatusViewport(rows, state.selected, state.top, 8);
  expect(viewport.top).toBeLessThan(100);
  expect(viewport.lines.some((line) => line.text.includes("and 15 more files"))).toBe(true);
  expect(rows.some((row) => row.id === "path:file-24.ts")).toBe(false);
  controller.togglePathGroup("tracked");
  expect(controller.getSnapshot().selected).toBe("toggle:tracked");
  expect(
    projectStatusRows(controller.getSnapshot(), 45)
      .find((row) => row.id === "toggle:tracked")!
      .lines.map(statusPlainText)
      .join(""),
  ).toBe("  Show fewer");
});
