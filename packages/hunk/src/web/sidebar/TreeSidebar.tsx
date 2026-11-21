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
 *
 * Review state rides on the one row decoration Pierre allows per row, which is text parts
 * with a color each (an icon decoration would replace the text). Each mark's color is a
 * named custom property (`var(--sidebar-mark-viewed)`), and the stylesheet keys on that name
 * in the part's inline style (`treeMarkStyles`): a speech bubble before a note count, the
 * dimmed name of a viewed row. The viewed and changed marks are the text glyphs `✓` and `↻`;
 * an icon image cannot reach the shadow root under the page's CSP and its no-SVG-blob rule.
 * Directory rows carry their viewed roll-up (`1/40`) the same way.
 * Pierre names a row by its file name alone, so the counts read aloud through the
 * decoration's `title` ("2 notes · Viewed").
 */
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { reviewFileChangeGlyph, reviewSidebarBadges } from "../../core/review/fileLabels";
import type { ReviewFileChangeKind } from "../../core/review/types";
import { formatCount } from "../format/lineCounts";
import { sidebarEntry, treePathsOf, type FileSidebarProps } from "./sidebarEntry";
import {
  directoryViewedRollups,
  formatNoteCountLabel,
  formatViewedRollup,
  showsViewedRollup,
} from "./viewedRollup";

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
    ...treeMarkStyles(),
  ].join("\n");
}

/** The review marks a tree row's decoration can carry, each named by its color property. */
const TREE_MARKS = {
  notes: "--sidebar-mark-notes",
  viewed: "--sidebar-mark-viewed",
  changed: "--sidebar-mark-changed",
  rollup: "--sidebar-mark-rollup",
  rollupComplete: "--sidebar-mark-rollup-complete",
} as const;

/** The decoration-part color that tags a part as one mark. */
function markColor(mark: keyof typeof TREE_MARKS) {
  return `var(${TREE_MARKS[mark]})`;
}

/** A selector for the decoration parts tagged as one mark. */
function markPart(mark: keyof typeof TREE_MARKS) {
  return `[data-item-section="decoration"] span[style*="${markColor(mark)}"]`;
}

/**
 * Stylesheet rules for the review marks on tree rows.
 *
 * Sets each mark's color from theme tokens (viewed in the "added" family, changed since
 * viewed in the accent), draws the note bubble, dims a viewed row's name, gives the selected row
 * the flat list's accent marker, and keeps hover neutral instead of Pierre's accent tint.
 */
export function treeMarkStyles() {
  const added = "var(--hunk-badge-added, #1a7f37)";
  return [
    `:host { ${TREE_MARKS.notes}: var(--hunk-text); ${TREE_MARKS.viewed}: ${added};` +
      ` ${TREE_MARKS.changed}: var(--hunk-accent); ${TREE_MARKS.rollup}: var(--hunk-muted);` +
      ` ${TREE_MARKS.rollupComplete}: ${added}; --trees-bg-muted: var(--hunk-panel-alt); }`,
    `[data-item-section="decoration"] > span { gap: 6px; font-variant-numeric: tabular-nums; }`,
    `[data-item-section="decoration"] > span > span { display: inline-flex; align-items: center; }`,
    // A speech bubble drawn in CSS: the page's CSP and its rule against SVG blobs leave the
    // tree's shadow root no way to load the icon module's SVG.
    `${markPart("notes")} { position: relative; padding-left: 15px; }`,
    `${markPart("notes")}::before { content: ""; position: absolute; left: 1px; top: 50%;` +
      ` width: 9px; height: 7px; margin-top: -5px; border: 1.5px solid var(--hunk-muted);` +
      ` border-radius: 2px; }`,
    `${markPart("notes")}::after { content: ""; position: absolute; left: 3px; top: 50%;` +
      ` margin-top: 3px; border-left: 1.5px solid var(--hunk-muted);` +
      ` border-top: 3px solid var(--hunk-muted); width: 0; height: 0; }`,
    `${markPart("viewed")}, ${markPart("changed")} { font-weight: 600; }`,
    `[data-type="item"]:has(${markPart("viewed")}) > [data-item-section="content"]` +
      ` { color: var(--hunk-muted); }`,
    `[data-type="item"][data-item-selected="true"]::after { content: ""; position: absolute;` +
      ` left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 2px;` +
      ` background: var(--hunk-accent); }`,
  ];
}

/** CSS color for one badge kind, from the active theme's tokens; matches the flat list. */
const BADGE_COLOR = {
  "agent-comment": markColor("notes"),
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
  const rollups = useMemo(
    () =>
      directoryViewedRollups(
        entries.map((entry, index) => ({ key: entry.key, path: paths[index]! })),
        viewedStatuses,
      ),
    [entries, paths, viewedStatuses],
  );
  const following = useRef(false);
  // Re-selects the store's selected file in the tree; set once the model exists.
  const followSelection = useRef(() => {});
  const latest = useRef({
    byPath,
    noteCounts,
    onSelectFile,
    order,
    rollups,
    selectedKey,
    viewedStatuses,
  });
  latest.current = {
    byPath,
    noteCounts,
    onSelectFile,
    order,
    rollups,
    selectedKey,
    viewedStatuses,
  };
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
      if (entry) {
        if (entry.key !== latest.current.selectedKey) latest.current.onSelectFile(entry.key);
        return;
      }
      // A directory row took the selection; the highlight belongs on the selected file.
      queueMicrotask(() => followSelection.current());
    },
    renderRowDecoration: ({ row }) => {
      if (row.kind === "directory") {
        const rollup = latest.current.rollups.get(row.path.replace(/\/+$/u, ""));
        if (!showsViewedRollup(rollup)) return null;
        const { text, label, complete } = formatViewedRollup(rollup);
        return {
          text,
          title: label,
          parts: [{ text, color: markColor(complete ? "rollupComplete" : "rollup") }],
        };
      }
      const entry = latest.current.byPath.get(row.path);
      if (!entry) return null;
      const noteCount = latest.current.noteCounts.get(entry.key) ?? 0;
      // The note badge prints its bare count; the stylesheet draws the bubble before it.
      const parts: { text: string; color: string }[] = reviewSidebarBadges(
        sidebarEntry(entry, 0, noteCount),
      ).map((badge) => ({
        text: badge.kind === "agent-comment" ? formatCount(noteCount) : badge.text,
        color: BADGE_COLOR[badge.kind],
      }));
      const titles = noteCount > 0 ? [formatNoteCountLabel(noteCount)] : [];
      const viewed = latest.current.viewedStatuses?.get(entry.key);
      if (viewed === "viewed") {
        parts.push({ text: "✓", color: markColor("viewed") });
        titles.push("Viewed");
      }
      if (viewed === "changed") {
        parts.push({ text: "↻", color: markColor("changed") });
        titles.push("Changed since viewed");
      }
      if (parts.length === 0) return null;
      return {
        text: parts.map((part) => part.text).join(" "),
        ...(titles.length > 0 ? { title: titles.join(" · ") } : {}),
        parts,
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

  // Note badges, viewed marks, and folder roll-ups are row decorations, which the tree repaints
  // only when a row changes; clearing and restating the statuses changes every row.
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
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  followSelection.current = () => {
    const path = selectedPathRef.current;
    if (!path) return;
    const item = model.getItem(path);
    if (!item || (item.isSelected() && model.getSelectedPaths().length === 1)) return;
    following.current = true;
    try {
      for (const selected of model.getSelectedPaths()) model.getItem(selected)?.deselect();
      item.select();
    } finally {
      following.current = false;
    }
  };
  useEffect(() => {
    if (!selectedPath) return;
    followSelection.current();
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" });
  }, [model, selectedPath]);

  // Choosing the file that is already selected changes no selection, so the tree reports
  // nothing; the click itself jumps to the file's top, as it does in the flat list. Capture
  // phase, before the row acts: a row that is not selected yet reports through the selection.
  const jumpToSelectedOnClick = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
    const row = event.nativeEvent
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.itemType !== undefined,
      );
    const path = row?.dataset.itemPath;
    const entry =
      path && row.dataset.itemType === "file" ? latest.current.byPath.get(path) : undefined;
    if (entry && entry.key === latest.current.selectedKey && model.getItem(path!)?.isSelected()) {
      latest.current.onSelectFile(entry.key);
    }
  };

  // `display: contents` keeps the wrapper out of the layout the host element sits in.
  return (
    <div style={{ display: "contents" }} onClickCapture={jumpToSelectedOnClick}>
      <FileTree model={model} className="file-tree" aria-label="Files" />
    </div>
  );
}
