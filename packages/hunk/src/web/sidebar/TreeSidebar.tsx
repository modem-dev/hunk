/** @jsxImportSource react */
/**
 * The tree-mode files sidebar, drawn by `@pierre/trees`.
 *
 * Loaded lazily (it carries Preact and the tree renderer), so the review stream paints
 * without waiting for it. Paths are sorted by review order, change kinds become the tree's
 * git statuses, and the shared badges become row decorations.
 *
 * Rows are laid out the way the terminal's `FileListItem` draws them: indent, change-kind
 * letter, name, then badges — no file-type icon, the name in the text color, and the letter
 * from the shared `reviewFileChangeGlyph` rather than Pierre's own status vocabulary (which
 * would show `U` where the terminal shows `?`). Pierre's status lane is kept for its row
 * coloring hooks and restyled with stylesheet rules generated from the shared helper.
 */
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef } from "react";
import { reviewFileChangeGlyph, reviewSidebarBadges } from "../../core/review/fileLabels";
import type { ReviewFileChangeKind } from "../../core/review/types";
import { sidebarEntry, treePathsOf, type FileSidebarProps } from "./sidebarEntry";

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

/** The CSS custom property the page's theme sets for one glyph role (`fileNew` -> `--hunk-file-new`). */
function roleColor(role: string) {
  return `var(--hunk-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)})`;
}

/**
 * Stylesheet rules for the tree's shadow root, generated from the shared change glyphs.
 *
 * Moves the status lane before the name, hides file-type icons (directories keep their
 * chevron), drops the directory status dot, and replaces Pierre's status text with the
 * terminal's letter in the theme's color for its role.
 */
export function treeRowStyles() {
  const kinds = [
    ["new", false],
    ["deleted", false],
    ["rename-changed", false],
    ["change", false],
    ["change", true],
  ] as const;
  const letters = kinds.map(([kind, untracked]) => {
    const { glyph, role } = reviewFileChangeGlyph(kind, untracked);
    return (
      `[data-item-git-status="${gitStatusOf(kind, untracked)}"] > [data-item-section="git"]::before` +
      ` { content: "${glyph}"; color: ${roleColor(role)}; }`
    );
  });
  return [
    `[data-item-section="icon"], [data-item-section="git"] { order: 1; }`,
    `[data-item-section="content"] { order: 2; color: var(--hunk-text); }`,
    `[data-item-section="decoration"] { order: 3; }`,
    `[data-item-section="action"] { order: 4; }`,
    `[data-item-type="file"] > [data-item-section="icon"] { display: none; }`,
    `[data-item-type="folder"] > [data-item-section="git"] { display: none; }`,
    `[data-item-section="git"] { min-width: 1.4em; font-weight: 600; font-family: var(--code-font); }`,
    `[data-item-section="git"] > * { display: none; }`,
    ...letters,
  ].join("\n");
}

/** CSS color for one badge kind, from the active theme's tokens; matches the flat list. */
const BADGE_COLOR = {
  "agent-comment": "var(--hunk-text)",
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
  noteCounts,
  selectedKey,
  onSelectFile,
  viewedStatuses,
}: Omit<FileSidebarProps, "mode">) {
  const paths = useMemo(() => treePathsOf(entries), [entries]);
  const byPath = useMemo(
    () => new Map(entries.map((entry, index) => [paths[index]!, entry])),
    [entries, paths],
  );
  const order = useMemo(() => reviewOrderIndex(paths), [paths]);
  const following = useRef(false);
  const latest = useRef({ byPath, noteCounts, onSelectFile, order, selectedKey, viewedStatuses });
  latest.current = { byPath, noteCounts, onSelectFile, order, selectedKey, viewedStatuses };
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
    unsafeCSS: treeRowStyles(),
    gitStatus: entries.map((entry, index) => ({
      path: paths[index]!,
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
      const badges: { text: string; color: string }[] = reviewSidebarBadges(
        sidebarEntry(entry, 0, latest.current.noteCounts.get(entry.key) ?? 0),
      ).map((badge) => ({ text: badge.text, color: BADGE_COLOR[badge.kind] }));
      const viewed = latest.current.viewedStatuses?.get(entry.key);
      if (viewed === "viewed") badges.push({ text: "✓", color: "var(--hunk-muted)" });
      if (viewed === "changed") badges.push({ text: "Δ", color: "var(--hunk-accent)" });
      if (badges.length === 0) return null;
      return {
        text: badges.map((badge) => badge.text).join(" "),
        ...(viewed === "viewed"
          ? { title: "Viewed" }
          : viewed === "changed"
            ? { title: "Changed since viewed" }
            : {}),
        // The separator rides on each later badge; a part of only whitespace is dropped.
        parts: badges.map((badge, index) => ({
          text: index > 0 ? `\u00a0${badge.text}` : badge.text,
          color: badge.color,
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
      entries.map((entry, index) => ({
        path: paths[index]!,
        status: gitStatusOf(entry.changeKind, entry.flags.untracked),
      })),
    );
  }, [model, paths, entries]);

  // Note badges are row decorations, which the tree repaints only when a row changes; clearing
  // and restating the statuses changes every row.
  const firstCounts = useRef(true);
  useEffect(() => {
    if (firstCounts.current) {
      firstCounts.current = false;
      return;
    }
    model.setGitStatus([]);
    model.setGitStatus(
      latest.current.byPath.size > 0
        ? Array.from(latest.current.byPath, ([path, entry]) => ({
            path,
            status: gitStatusOf(entry.changeKind, entry.flags.untracked),
          }))
        : [],
    );
  }, [model, noteCounts, viewedStatuses]);

  // Follow the store's selection, whoever made it.
  const selectedIndex = entries.findIndex((entry) => entry.key === selectedKey);
  const selectedPath = selectedIndex >= 0 ? paths[selectedIndex] : undefined;
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
