import { basename, dirname } from "node:path/posix";
import type { FileDiffMetadata } from "@pierre/diffs";
import { normalizeDiffPath } from "../../core/diffPaths";
import type { AgentAnnotation, DiffFile } from "../../core/types";

export interface FileListEntry {
  kind: "file";
  id: string;
  name: string;
  additionsText: string | null;
  deletionsText: string | null;
  changeType: FileDiffMetadata["type"];
  isUntracked: boolean;
}

export interface FileGroupEntry {
  kind: "group";
  id: string;
  label: string;
}

export type SidebarEntry = FileListEntry | FileGroupEntry;

/** Build the filename-first label shown inside one sidebar row. */
function sidebarFileName(file: DiffFile) {
  const path = normalizeDiffPath(file.path) ?? file.path;
  const previousPath = normalizeDiffPath(file.previousPath);

  if (!previousPath || previousPath === path) {
    return basename(path);
  }

  const previousName = basename(previousPath);
  const nextName = basename(path);
  return previousName === nextName ? nextName : `${previousName} -> ${nextName}`;
}

/** Hide zero-value file stats so the sidebar only shows real line deltas. */
function formatSidebarStat(prefix: "+" | "-", value: number) {
  return value > 0 ? `${prefix}${value}` : null;
}

/** Build the visible stats badges for one sidebar row. */
export function sidebarEntryStats(entry: Pick<FileListEntry, "additionsText" | "deletionsText">) {
  const stats: Array<{ kind: "addition" | "deletion"; text: string }> = [];

  if (entry.additionsText) {
    stats.push({ kind: "addition", text: entry.additionsText });
  }

  if (entry.deletionsText) {
    stats.push({ kind: "deletion", text: entry.deletionsText });
  }

  return stats;
}

/** Measure the rendered sidebar stats width, including the space between badges. */
export function sidebarEntryStatsWidth(
  entry: Pick<FileListEntry, "additionsText" | "deletionsText">,
) {
  return sidebarEntryStats(entry).reduce(
    (width, stat, index) => width + stat.text.length + (index > 0 ? 1 : 0),
    0,
  );
}

/** Merge one file-id keyed annotation map into the review stream file list. */
export function mergeFileAnnotationsByFileId<T extends AgentAnnotation>(
  files: DiffFile[],
  annotationsByFileId: Record<string, T[]>,
): DiffFile[] {
  return files.map((file) => {
    const annotations = annotationsByFileId[file.id];
    if (!annotations || annotations.length === 0) {
      return file;
    }

    return {
      ...file,
      agent: {
        path: file.path,
        summary: file.agent?.summary,
        annotations: [...(file.agent?.annotations ?? []), ...annotations],
      },
    };
  });
}

/** Apply the app's file filter query to the visible review stream. */
export function filterReviewFiles(files: DiffFile[], query: string): DiffFile[] {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return files;
  }

  return files.filter((file) => {
    const haystack = [
      normalizeDiffPath(file.path),
      normalizeDiffPath(file.previousPath),
      file.agent?.summary,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(trimmedQuery);
  });
}

/** Build the grouped sidebar entries while preserving the review stream order. */
export function buildSidebarEntries(files: DiffFile[]): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  let activeGroup: string | null = null;

  files.forEach((file, index) => {
    const path = normalizeDiffPath(file.path) ?? file.path;
    const group = dirname(path);
    const nextGroup = group === "." ? null : group;

    if (nextGroup !== activeGroup) {
      activeGroup = nextGroup;
      if (activeGroup) {
        entries.push({
          kind: "group",
          id: `group:${activeGroup}:${index}`,
          label: `${activeGroup}/`,
        });
      }
    }

    entries.push({
      kind: "file",
      id: file.id,
      name: sidebarFileName(file),
      additionsText: formatSidebarStat("+", file.stats.additions),
      deletionsText: formatSidebarStat("-", file.stats.deletions),
      changeType: file.metadata.type,
      isUntracked: file.isUntracked ?? false,
    });
  });

  return entries;
}

/** Build the canonical file label used across headers and note cards. */
export function fileLabel(file: DiffFile | undefined) {
  const { filename, stateLabel } = fileLabelParts(file);
  return stateLabel ? `${filename}${stateLabel}` : filename;
}

/** Split file label into filename and state label for styled rendering. */
export function fileLabelParts(file: DiffFile | undefined): {
  filename: string;
  stateLabel: string | null;
} {
  if (!file) {
    return { filename: "No file selected", stateLabel: null };
  }

  const path = normalizeDiffPath(file.path) ?? file.path;
  const previousPath = normalizeDiffPath(file.previousPath);
  const baseLabel = previousPath && previousPath !== path ? `${previousPath} -> ${path}` : path;

  // Determine state label for special cases
  let stateLabel: string | null = null;
  if (file.isUntracked) {
    stateLabel = " (untracked)";
  } else if (file.metadata.type === "new") {
    stateLabel = " (new)";
  } else if (file.metadata.type === "deleted") {
    stateLabel = " (deleted)";
  }

  return { filename: baseLabel, stateLabel };
}
