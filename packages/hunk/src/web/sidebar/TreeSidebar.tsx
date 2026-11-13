/** @jsxImportSource react */
/**
 * The tree-mode files sidebar, drawn by `@pierre/trees`.
 *
 * Loaded lazily (it carries Preact and the tree renderer), so the review stream paints
 * without waiting for it. Paths are sorted by review order, change kinds become the tree's
 * git statuses, and the shared badges become row decorations.
 */
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef } from "react";
import { reviewSidebarBadges } from "../../core/review/fileLabels";
import type { ReviewFileChangeKind } from "../../core/review/types";
import { sidebarEntry, type FileSidebarProps } from "./sidebarEntry";

/** Pierre tree's status vocabulary for one change kind. */
function gitStatusOf(changeKind: ReviewFileChangeKind, untracked: boolean) {
  if (untracked) return "untracked" as const;
  switch (changeKind) {
    case "new":
      return "added" as const;
    case "deleted":
      return "deleted" as const;
    case "rename-pure":
    case "rename-changed":
      return "renamed" as const;
    case "change":
      return "modified" as const;
  }
}

/** CSS color for one badge kind, from the active theme's tokens. */
const BADGE_COLOR = {
  "agent-comment": "var(--hunk-accent)",
  addition: "var(--hunk-badge-added)",
  deletion: "var(--hunk-badge-removed)",
} as const;

/** The first review position at or below every file and directory path. */
function reviewOrderIndex(paths: readonly string[]) {
  const order = new Map<string, number>();
  paths.forEach((path, index) => {
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      if (!order.has(prefix)) order.set(prefix, index);
    }
  });
  return order;
}

/** The hierarchical sidebar, drawn by `@pierre/trees`. */
export default function TreeSidebar({
  entries,
  selectedKey,
  onSelectFile,
}: Omit<FileSidebarProps, "mode">) {
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const byPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const order = useMemo(() => reviewOrderIndex(paths), [paths]);
  const following = useRef(false);
  const latest = useRef({ byPath, onSelectFile, order, selectedKey });
  latest.current = { byPath, onSelectFile, order, selectedKey };
  const reviewOrderOf = (path: string) =>
    latest.current.order.get(path.replace(/\/+$/u, "")) ?? Number.MAX_SAFE_INTEGER;

  const { model } = useFileTree({
    paths,
    // Review order, not alphabetical: each entry sorts by the first review position at or
    // below it, so files keep the stream's order and directories appear where their first
    // file does.
    sort: (left, right) => reviewOrderOf(left.path) - reviewOrderOf(right.path),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    density: "compact",
    gitStatus: entries.map((entry) => ({
      path: entry.path,
      status: gitStatusOf(entry.changeKind, entry.flags.untracked),
    })),
    onSelectionChange: (selected) => {
      // A selection this component made to follow the store is not the reader choosing a
      // file; acting on it would turn scrolling into a jump.
      if (following.current) return;
      const entry = selected[0] ? latest.current.byPath.get(selected[0]) : undefined;
      if (entry && entry.key !== latest.current.selectedKey) latest.current.onSelectFile(entry.key);
    },
    renderRowDecoration: ({ row }) => {
      const entry = row.kind === "file" ? latest.current.byPath.get(row.path) : undefined;
      if (!entry) return null;
      const badges = reviewSidebarBadges(sidebarEntry(entry, 0));
      if (badges.length === 0) return null;
      return {
        text: badges.map((badge) => badge.text).join(" "),
        // The separator rides on each later badge; a part of only whitespace is dropped.
        parts: badges.map((badge, index) => ({
          text: index > 0 ? `\u00a0${badge.text}` : badge.text,
          color: BADGE_COLOR[badge.kind],
        })),
      };
    },
  });

  // A new generation or more loaded files replace the tree's paths and statuses.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    model.resetPaths(paths);
    model.setGitStatus(
      entries.map((entry) => ({
        path: entry.path,
        status: gitStatusOf(entry.changeKind, entry.flags.untracked),
      })),
    );
  }, [model, paths, entries]);

  // Follow the store's selection, whoever made it.
  const selectedPath = entries.find((entry) => entry.key === selectedKey)?.path;
  useEffect(() => {
    if (!selectedPath) return;
    const item = model.getItem(selectedPath);
    if (item && !item.isSelected()) {
      following.current = true;
      try {
        for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
        item.select();
      } finally {
        following.current = false;
      }
    }
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" });
  }, [model, selectedPath]);

  return <FileTree model={model} className="file-tree" aria-label="Files" />;
}
