/**
 * Summarizes one review as numbers: totals, change kinds, file roles, a size class, per-directory
 * rollups, the largest files, notes per file, and viewed progress.
 *
 * Every surface that reports a review's shape reads this one selector — the browser's Overview
 * tab now, `hunk session` and the terminal later — so "how big is this change" has one answer.
 * It reads only per-file facts every surface already has (path, change kind, stats, flags), the
 * notes it is handed, and the viewed marks, so it runs as well over the browser's shared-state
 * file index as over a full document. Order is document order wherever ties are broken.
 */
import { REVIEW_MEANINGFUL_FILE_ROLES, reviewFileRole, type ReviewFileRole } from "./fileRoles";
import type { ReviewFileChangeKind, ReviewFileFlagsV1, ReviewFileStatsV1 } from "./types";

/** The per-file facts the overview reads. */
export interface ReviewOverviewFileInput {
  key: string;
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  stats: ReviewFileStatsV1;
  flags: ReviewFileFlagsV1;
}

/** Who wrote one note, for per-file counts: an agent (live or sidecar) or the reviewer. */
export type ReviewOverviewNoteOrigin = "agent" | "reviewer";

/** One note, reduced to what the overview counts. */
export interface ReviewOverviewNoteInput {
  fileKey: string;
  origin: ReviewOverviewNoteOrigin;
}

/** Added and removed lines over some set of files; `truncated` marks a lower bound. */
export interface ReviewOverviewTotals {
  files: number;
  additions: number;
  deletions: number;
  /** Some file's counts are a lower bound (the producer counted more than it rendered). */
  truncated: boolean;
}

/**
 * The change-kind breakdown. The first five partition the files; `untracked`, `binary`, and
 * `tooLarge` are flags that overlap them and are counted separately.
 */
export interface ReviewOverviewChangeKinds {
  new: number;
  modified: number;
  deleted: number;
  renamed: number;
  renamedChanged: number;
  untracked: number;
  binary: number;
  tooLarge: number;
}

/**
 * How large a review is, by its meaningful changed lines (added plus removed, tests, docs, and
 * generated files excluded).
 *
 * The thresholds are the widely used Kubernetes `size/*` pull-request labels — under 10 lines
 * XS, under 30 S, under 100 M, under 500 L — with their XL and XXL merged at 500 and above:
 * past 500 meaningful lines a review is "split it if you can" whatever the exact number.
 */
export type ReviewSizeClass = "XS" | "S" | "M" | "L" | "XL";

/** Upper bounds (exclusive) of each size class but the last, in changed lines. */
export const REVIEW_SIZE_CLASS_THRESHOLDS: readonly [ReviewSizeClass, number][] = [
  ["XS", 10],
  ["S", 30],
  ["M", 100],
  ["L", 500],
];

/** One directory's rollup, its subdirectories largest first. */
export interface ReviewOverviewDirectory {
  /** The directory's name, or a compacted chain such as `packages/hunk/src`. */
  name: string;
  /** Full path from the review root, without a trailing slash; empty for the root. */
  path: string;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** The first file inside it in document order: where a jump to the directory lands. */
  firstFileKey: string;
  children: ReviewOverviewDirectory[];
}

/** One file in the largest-files list. */
export interface ReviewOverviewFileChurn {
  fileKey: string;
  path: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

/** Notes on one file, by origin. */
export interface ReviewOverviewFileNotes {
  fileKey: string;
  path: string;
  agent: number;
  reviewer: number;
}

export interface ReviewOverview {
  totals: ReviewOverviewTotals;
  /** Totals without tests, docs, and generated files. */
  meaningful: ReviewOverviewTotals;
  changeKinds: ReviewOverviewChangeKinds;
  roles: Record<ReviewFileRole, ReviewOverviewTotals>;
  sizeClass: ReviewSizeClass;
  /** The review root; its children are the top-level directories. */
  directories: ReviewOverviewDirectory;
  /** Files by added plus removed lines, largest first, at most `largestFileLimit`. */
  largestFiles: ReviewOverviewFileChurn[];
  /** Files carrying notes, in document order. */
  notesByFile: ReviewOverviewFileNotes[];
  noteTotals: { agent: number; reviewer: number };
  /** Viewed progress, present once any file is marked viewed. */
  viewed?: { files: number; total: number };
}

export interface ReviewOverviewInput {
  files: readonly ReviewOverviewFileInput[];
  notes?: Iterable<ReviewOverviewNoteInput>;
  /** Viewed marks by file key, already matched to each file's current content. */
  viewedFiles?: Readonly<Record<string, unknown>>;
  /** How many files the largest-files list keeps; 10 by default. */
  largestFileLimit?: number;
}

/** Classify one note's origin for counting: the reviewer's own notes, or an agent's. */
export function reviewOverviewNoteOrigin(source: string): ReviewOverviewNoteOrigin {
  return source === "user" ? "reviewer" : "agent";
}

/** Decide the size class for a number of meaningful changed lines. */
export function reviewSizeClass(changedLines: number): ReviewSizeClass {
  for (const [sizeClass, bound] of REVIEW_SIZE_CLASS_THRESHOLDS) {
    if (changedLines < bound) return sizeClass;
  }
  return "XL";
}

/** An empty running total. */
function emptyTotals(): ReviewOverviewTotals {
  return { files: 0, additions: 0, deletions: 0, truncated: false };
}

/** Add one file's stats to a running total. */
function addFile(totals: ReviewOverviewTotals, stats: ReviewFileStatsV1) {
  totals.files += 1;
  totals.additions += stats.additions;
  totals.deletions += stats.deletions;
  totals.truncated ||= stats.truncated;
}

/** Added plus removed lines. */
function churn(value: { additions: number; deletions: number }) {
  return value.additions + value.deletions;
}

/** Mutable directory node while the tree is built. */
interface DirectoryBuilder {
  name: string;
  path: string;
  totals: ReviewOverviewTotals;
  firstFileKey: string;
  children: Map<string, DirectoryBuilder>;
}

/** Order directories largest first, then by name, and compact single-child chains. */
function finishDirectory(node: DirectoryBuilder, isRoot: boolean): ReviewOverviewDirectory {
  let current = node;
  let name = node.name;
  // A directory holding exactly one subdirectory and no files of its own reads as one row.
  while (!isRoot && current.children.size === 1) {
    const only = [...current.children.values()][0]!;
    if (only.totals.files !== current.totals.files) break;
    name = `${name}/${only.name}`;
    current = only;
  }
  const children = [...current.children.values()]
    .map((child) => finishDirectory(child, false))
    .sort((left, right) => churn(right) - churn(left) || left.name.localeCompare(right.name));
  return {
    name,
    path: current.path,
    files: node.totals.files,
    additions: node.totals.additions,
    deletions: node.totals.deletions,
    truncated: node.totals.truncated,
    firstFileKey: node.firstFileKey,
    children,
  };
}

/** Summarize one review; see the module header. */
export function selectReviewOverview(input: ReviewOverviewInput): ReviewOverview {
  const totals = emptyTotals();
  const meaningful = emptyTotals();
  const roles = Object.fromEntries(
    (["source", "test", "docs", "generated", "config"] as const).map((role) => [
      role,
      emptyTotals(),
    ]),
  ) as Record<ReviewFileRole, ReviewOverviewTotals>;
  const changeKinds: ReviewOverviewChangeKinds = {
    new: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    renamedChanged: 0,
    untracked: 0,
    binary: 0,
    tooLarge: 0,
  };
  const root: DirectoryBuilder = {
    name: "",
    path: "",
    totals: emptyTotals(),
    firstFileKey: input.files[0]?.key ?? "",
    children: new Map(),
  };

  for (const file of input.files) {
    addFile(totals, file.stats);
    const role = reviewFileRole(file.path);
    addFile(roles[role], file.stats);
    if (REVIEW_MEANINGFUL_FILE_ROLES.has(role)) addFile(meaningful, file.stats);

    const kind = {
      new: "new",
      change: "modified",
      deleted: "deleted",
      "rename-pure": "renamed",
      "rename-changed": "renamedChanged",
    } as const satisfies Record<ReviewFileChangeKind, keyof ReviewOverviewChangeKinds>;
    changeKinds[kind[file.changeKind]] += 1;
    if (file.flags.untracked) changeKinds.untracked += 1;
    if (file.flags.binary) changeKinds.binary += 1;
    if (file.flags.tooLarge) changeKinds.tooLarge += 1;

    // A file counts toward every directory above it; a deleted file lives where it was.
    addFile(root.totals, file.stats);
    let node = root;
    for (const segment of file.path.split("/").filter(Boolean).slice(0, -1)) {
      let child = node.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          totals: emptyTotals(),
          firstFileKey: file.key,
          children: new Map(),
        };
        node.children.set(segment, child);
      }
      addFile(child.totals, file.stats);
      node = child;
    }
  }

  const largestFiles = input.files
    .map((file, order) => ({ file, order }))
    .filter(({ file }) => churn(file.stats) > 0)
    .sort(
      (left, right) => churn(right.file.stats) - churn(left.file.stats) || left.order - right.order,
    )
    .slice(0, input.largestFileLimit ?? 10)
    .map(({ file }) => ({
      fileKey: file.key,
      path: file.path,
      additions: file.stats.additions,
      deletions: file.stats.deletions,
      truncated: file.stats.truncated,
    }));

  const noteCounts = new Map<string, { agent: number; reviewer: number }>();
  const noteTotals = { agent: 0, reviewer: 0 };
  for (const note of input.notes ?? []) {
    const counts = noteCounts.get(note.fileKey) ?? { agent: 0, reviewer: 0 };
    counts[note.origin] += 1;
    noteCounts.set(note.fileKey, counts);
  }
  const notesByFile: ReviewOverviewFileNotes[] = [];
  for (const file of input.files) {
    const counts = noteCounts.get(file.key);
    if (!counts) continue;
    noteTotals.agent += counts.agent;
    noteTotals.reviewer += counts.reviewer;
    notesByFile.push({ fileKey: file.key, path: file.path, ...counts });
  }

  const viewedCount = input.viewedFiles
    ? input.files.filter((file) => Object.hasOwn(input.viewedFiles!, file.key)).length
    : 0;

  return {
    totals,
    meaningful,
    changeKinds,
    roles,
    sizeClass: reviewSizeClass(churn(meaningful)),
    directories: finishDirectory(root, true),
    largestFiles,
    notesByFile,
    noteTotals,
    ...(viewedCount > 0 ? { viewed: { files: viewedCount, total: input.files.length } } : {}),
  };
}
