import type { ExtensionVcsStatusPath } from "../../extension-api/types";

export type StatusPathGroupId = "tracked" | "untracked";
export const STATUS_PATH_GROUP_LIMIT = 10;

/** Group normalized paths in provider/stable order; the VCS boundary validates uniqueness. */
export function groupStatusPaths(paths: readonly ExtensionVcsStatusPath[]) {
  const tracked: ExtensionVcsStatusPath[] = [];
  const untracked: ExtensionVcsStatusPath[] = [];
  for (const path of paths) {
    const isUntracked =
      path.worktree === "untracked" &&
      (!path.index || path.index === "unchanged") &&
      !path.conflict;
    (isUntracked ? untracked : tracked).push(path);
  }
  return [
    { id: "tracked" as const, title: "Tracked changes", paths: tracked },
    { id: "untracked" as const, title: "Untracked files", paths: untracked },
  ];
}

/** Move a now-hidden file selection to its group's visible expansion action. */
export function reconcileStatusPathSelection(
  paths: readonly ExtensionVcsStatusPath[],
  expanded: Record<StatusPathGroupId, boolean>,
  selected: string | null,
) {
  for (const group of groupStatusPaths(paths)) {
    if (
      !expanded[group.id] &&
      group.paths.slice(STATUS_PATH_GROUP_LIMIT).some((path) => `path:${path.path}` === selected)
    )
      return `toggle:${group.id}`;
  }
  return selected;
}
