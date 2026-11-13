/**
 * Names, badges, and sidebar projections for reviewed files, shared by every surface.
 *
 * The terminal sidebar and file headers and the browser sidebar and stream headers all show
 * the same facts about a file: its filename-first name, `old -> new` for a rename, a state
 * suffix, a change-kind letter, `*N` note and `+N`/`-N` stat badges that hide zeros and mark
 * a truncated count, and a flat or tree projection that never regroups files away from
 * review order. Those rules are written once here (`docs/browser-review-seam-audit.md`, E1);
 * each surface keeps only its own text sanitizing, measuring, and drawing.
 *
 * Platform-free on purpose: paths are review paths with `/` separators, split by the small
 * POSIX helpers below rather than `node:path`, so a browser bundle can import this module.
 * Callers pass paths already normalized for display.
 */
import type { ReviewFileChangeKind } from "./types";

/** The last segment of a `/`-separated path, as POSIX `basename` returns it. */
export function reviewPathBasename(path: string) {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index] === "/") {
      if (!matchedSlash) {
        start = index + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = index + 1;
    }
  }
  return end === -1 ? "" : path.slice(start, end);
}

/** Everything before the last segment of a `/`-separated path, as POSIX `dirname` returns it. */
export function reviewPathDirname(path: string) {
  if (path.length === 0) {
    return ".";
  }
  const hasRoot = path[0] === "/";
  let end = -1;
  let matchedSlash = true;
  for (let index = path.length - 1; index >= 1; index -= 1) {
    if (path[index] === "/") {
      if (!matchedSlash) {
        end = index;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) {
    return hasRoot ? "/" : ".";
  }
  if (hasRoot && end === 1) {
    return "//";
  }
  return path.slice(0, end);
}

/** The filename-first name one sidebar row shows, with `old -> new` for a renamed file. */
export function reviewSidebarFileName(path: string, previousPath?: string) {
  if (!previousPath || previousPath === path) {
    return reviewPathBasename(path);
  }
  const previousName = reviewPathBasename(previousPath);
  const nextName = reviewPathBasename(path);
  return previousName === nextName ? nextName : `${previousName} -> ${nextName}`;
}

/** One stat badge, or nothing for a zero so the sidebar shows only real line deltas. */
export function formatReviewSidebarStat(prefix: "+" | "-", value: number, truncated = false) {
  return value > 0 ? `${prefix}${value}${truncated ? "+" : ""}` : null;
}

/** The note badge for a file carrying review notes, or nothing. */
export function formatReviewNoteBadge(noteCount: number) {
  return noteCount > 0 ? `*${noteCount}` : null;
}

/** The badge texts one sidebar row may show. */
export interface ReviewSidebarBadgeTexts {
  agentCommentsText: string | null;
  additionsText: string | null;
  deletionsText: string | null;
}

export type ReviewSidebarBadgeKind = "agent-comment" | "addition" | "deletion";

/**
 * The visible badges for one sidebar row, in display order.
 *
 * The note badge comes first so it reads as review context before line churn.
 */
export function reviewSidebarBadges(entry: ReviewSidebarBadgeTexts) {
  const badges: Array<{ kind: ReviewSidebarBadgeKind; text: string }> = [];
  if (entry.agentCommentsText)
    badges.push({ kind: "agent-comment", text: entry.agentCommentsText });
  if (entry.additionsText) badges.push({ kind: "addition", text: entry.additionsText });
  if (entry.deletionsText) badges.push({ kind: "deletion", text: entry.deletionsText });
  return badges;
}

/** The change-kind letter a file shows, and the theme role that colors it. */
export function reviewFileChangeGlyph(changeKind: ReviewFileChangeKind, untracked: boolean) {
  if (untracked) return { glyph: "?", role: "fileUntracked" } as const;
  switch (changeKind) {
    case "new":
      return { glyph: "A", role: "fileNew" } as const;
    case "deleted":
      return { glyph: "D", role: "fileDeleted" } as const;
    case "rename-pure":
    case "rename-changed":
      return { glyph: "R", role: "fileRenamed" } as const;
    case "change":
      return { glyph: "M", role: "fileModified" } as const;
  }
}

/**
 * The header label for one file: its path, `old -> new` for a rename, and a state suffix.
 *
 * A rename within one directory keeps the directory once (`src/a.ts -> b.ts`); a move keeps
 * both full paths.
 */
export function reviewFileLabelParts(file: {
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  untracked: boolean;
}): { filename: string; stateLabel: string | null } {
  const { path, previousPath } = file;
  const renameTarget =
    previousPath && reviewPathDirname(previousPath) === reviewPathDirname(path)
      ? reviewPathBasename(path)
      : path;
  const filename =
    previousPath && previousPath !== path ? `${previousPath} -> ${renameTarget}` : path;

  let stateLabel: string | null = null;
  if (file.untracked) {
    stateLabel = " (untracked)";
  } else if (file.changeKind === "new") {
    stateLabel = " (new)";
  } else if (file.changeKind === "deleted") {
    stateLabel = " (deleted)";
  }
  return { filename, stateLabel };
}

// -- Sidebar projections -----------------------------------------------------------------

/** One file row of a sidebar projection. */
export interface ReviewSidebarFileEntry extends ReviewSidebarBadgeTexts {
  kind: "file";
  id: string;
  name: string;
  depth: number;
  changeType: ReviewFileChangeKind;
  isUntracked: boolean;
}

/** One directory heading of the flat projection. */
export interface ReviewSidebarGroupEntry {
  kind: "group";
  id: string;
  label: string;
}

/** One directory row of the tree projection. */
export interface ReviewSidebarDirectoryEntry {
  kind: "directory";
  id: string;
  path: string;
  label: string;
  depth: number;
  descendantFileCount: number;
}

export type ReviewSidebarEntry =
  | ReviewSidebarFileEntry
  | ReviewSidebarGroupEntry
  | ReviewSidebarDirectoryEntry;

/** What a projection needs from each file: its display path and its row. */
export interface ReviewSidebarProjectionInput<T> {
  files: readonly T[];
  pathOf: (file: T) => string;
  entryOf: (file: T, depth: number) => ReviewSidebarFileEntry;
}

/** Build the compact projection: one heading per run of files in one directory, in review order. */
export function buildReviewFlatSidebarEntries<T>({
  files,
  pathOf,
  entryOf,
}: ReviewSidebarProjectionInput<T>): ReviewSidebarEntry[] {
  const entries: ReviewSidebarEntry[] = [];
  let activeGroup: string | undefined;
  files.forEach((file, index) => {
    const group = reviewPathDirname(pathOf(file));
    if (group !== activeGroup) {
      activeGroup = group;
      entries.push({
        kind: "group",
        id: `group:${group}:${index}`,
        label: group === "." ? "./" : `${group}/`,
      });
    }
    entries.push(entryOf(file, 0));
  });
  return entries;
}

/** Split a directory path while keeping an absolute or UNC-style root marker. */
function directorySegments(parent: string) {
  if (parent === ".") {
    return [];
  }
  const root = parent.match(/^\/+/u)?.[0];
  const segments = parent.split("/").filter(Boolean);
  return root ? [root, ...segments] : segments;
}

/** Format one directory segment without doubling a retained root marker. */
function directoryLabel(segment: string) {
  return segment.startsWith("/") ? segment : `${segment}/`;
}

/** Join directory segments into the stable path one row represents. */
function directoryPath(segments: readonly string[]) {
  const [root, ...rest] = segments;
  return root?.startsWith("/") ? `${root}${rest.join("/")}` : segments.join("/");
}

/** The number of leading directory segments two branches share. */
function sharedDirectoryDepth(previous: readonly string[], next: readonly string[]) {
  const maxDepth = Math.min(previous.length, next.length);
  let depth = 0;
  while (depth < maxDepth && previous[depth] === next[depth]) {
    depth += 1;
  }
  return depth;
}

/** The stable paths of every directory containing one display path, outermost first. */
export function reviewSidebarDirectoryPaths(path: string): string[] {
  const directories = directorySegments(reviewPathDirname(path));
  return directories.map((_, depth) => directoryPath(directories.slice(0, depth + 1)));
}

/** Build the hierarchical projection without regrouping files away from review order. */
export function buildReviewTreeSidebarEntries<T>({
  files,
  pathOf,
  entryOf,
}: ReviewSidebarProjectionInput<T>): ReviewSidebarEntry[] {
  const entries: ReviewSidebarEntry[] = [];
  let activeDirectories: string[] = [];
  let activeDirectoryEntries: ReviewSidebarDirectoryEntry[] = [];

  files.forEach((file, fileIndex) => {
    const directories = directorySegments(reviewPathDirname(pathOf(file)));
    const sharedDepth = sharedDirectoryDepth(activeDirectories, directories);
    activeDirectoryEntries = activeDirectoryEntries.slice(0, sharedDepth);

    for (let depth = sharedDepth; depth < directories.length; depth += 1) {
      const segment = directories[depth]!;
      const path = directoryPath(directories.slice(0, depth + 1));
      const directoryEntry: ReviewSidebarDirectoryEntry = {
        kind: "directory",
        id: `directory:${fileIndex}:${depth}:${path}`,
        path,
        label: directoryLabel(segment),
        depth,
        descendantFileCount: 0,
      };
      entries.push(directoryEntry);
      activeDirectoryEntries.push(directoryEntry);
    }

    entries.push(entryOf(file, directories.length));
    for (const directoryEntry of activeDirectoryEntries) {
      directoryEntry.descendantFileCount += 1;
    }
    activeDirectories = directories;
  });

  return entries;
}

/** Expand the named ancestors while keeping unrelated collapsed directories collapsed. */
export function expandCollapsedReviewDirectoryPaths(
  current: ReadonlySet<string>,
  paths: readonly string[],
): ReadonlySet<string> {
  const expandedPaths = paths.filter((path) => current.has(path));
  if (expandedPaths.length === 0) {
    return current;
  }
  const next = new Set(current);
  for (const path of expandedPaths) {
    next.delete(path);
  }
  return next;
}

/** Toggle one directory path without mutating the current collapsed set. */
export function toggleCollapsedReviewDirectoryPath(
  current: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

/** Hide descendants of collapsed directories without changing the remaining order. */
export function collapseReviewTreeSidebarEntries(
  entries: readonly ReviewSidebarEntry[],
  collapsedDirectoryPaths: ReadonlySet<string>,
): ReviewSidebarEntry[] {
  if (collapsedDirectoryPaths.size === 0) {
    return [...entries];
  }
  const visible: ReviewSidebarEntry[] = [];
  let collapsedDepth: number | null = null;
  for (const entry of entries) {
    if (entry.kind === "group") {
      collapsedDepth = null;
      visible.push(entry);
      continue;
    }
    if (collapsedDepth !== null) {
      if (entry.depth > collapsedDepth) {
        continue;
      }
      collapsedDepth = null;
    }
    visible.push(entry);
    if (entry.kind === "directory" && collapsedDirectoryPaths.has(entry.path)) {
      collapsedDepth = entry.depth;
    }
  }
  return visible;
}
