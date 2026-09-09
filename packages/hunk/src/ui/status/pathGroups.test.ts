import { expect, test } from "bun:test";
import type { ExtensionVcsStatusPath } from "../../extension-api/types";
import { groupStatusPaths, reconcileStatusPathSelection } from "./pathGroups";

/** Build an explicit changed path for grouping-policy tests. */
function createTestGroupPath(
  path: string,
  facts: Partial<ExtensionVcsStatusPath> = {},
): ExtensionVcsStatusPath {
  return { path, index: "unchanged", worktree: "modified", conflict: false, ...facts };
}

test("unique group membership retains provider order and does not hide tracked or conflict facts", () => {
  const paths = [
    createTestGroupPath("new-b", { worktree: "untracked" }),
    createTestGroupPath("tracked-b"),
    createTestGroupPath("new-a", { worktree: "untracked", index: undefined }),
    createTestGroupPath("tracked-a", { index: "renamed", previousPath: "old-a" }),
    createTestGroupPath("new-b", { worktree: "untracked" }),
    createTestGroupPath("mixed", { worktree: "untracked", index: "added" }),
    createTestGroupPath("conflict", { worktree: "untracked", conflict: true }),
  ];
  const groups = groupStatusPaths(paths);
  expect(groups[0]!.paths.map((path) => path.path)).toEqual([
    "tracked-b",
    "tracked-a",
    "mixed",
    "conflict",
  ]);
  expect(groups[1]!.paths.map((path) => path.path)).toEqual(["new-b", "new-a"]);
  expect(groups[0]!.paths[1]!.previousPath).toBe("old-a");
});

test("refresh can move a selected path into a collapsed group without leaving hidden focus", () => {
  const paths = Array.from({ length: 11 }, (_, i) =>
    createTestGroupPath(`new-${i}`, { worktree: "untracked" }),
  );
  const expanded = { tracked: true, untracked: false };
  expect(reconcileStatusPathSelection(paths, expanded, "path:new-10")).toBe("toggle:untracked");
  expect(reconcileStatusPathSelection(paths, expanded, "path:new-9")).toBe("path:new-9");
  expect(reconcileStatusPathSelection(paths, { ...expanded, untracked: true }, "path:new-10")).toBe(
    "path:new-10",
  );
});
