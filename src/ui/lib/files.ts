import { basename, dirname } from "node:path/posix";
import type { FileDiffMetadata } from "@pierre/diffs";
import { normalizeDiffPath } from "../../core/changeset/diffPaths";
import type { DiffFile } from "../../core/changeset/model";
import { reviewFileStatBadges } from "../../core/review/presentation";
import type { AgentAnnotation } from "../../extension-api/types";
import { readMetadataChangeType } from "../../extensions/events";
import { formatTerminalPath } from "../../lib/terminalText";

export interface FileListEntry {
  kind: "file";
  id: string;
  name: string;
  agentCommentsText: string | null;
  additionsText: string | null;
  deletionsText: string | null;
  changeType: FileDiffMetadata["type"];
  isUntracked: boolean;
}

/**
 * The slice of one reviewed file the sidebar needs to build its entries.
 *
 * Structural on purpose: Hunk's internal `DiffFile` satisfies it through
 * `metadata.type`, and the public `ExtensionDiffFile` view satisfies it through
 * its first-class `changeType`, so the built-in sidebar — which is itself a
 * bundled extension consuming the public props — and internal callers share
 * this one entry builder.
 */
export interface SidebarFileSource {
  id: string;
  path: string;
  previousPath?: string;
  stats: { additions: number; deletions: number };
  statsTruncated?: boolean;
  isUntracked?: boolean;
  agent?: { annotations: readonly unknown[] } | null;
  changeType?: FileDiffMetadata["type"];
  metadata?: unknown;
}

export interface FileGroupEntry {
  kind: "group";
  id: string;
  label: string;
}

export type SidebarEntry = FileListEntry | FileGroupEntry;

/** Build the filename-first label shown inside one sidebar row. */
function sidebarFileName(file: SidebarFileSource) {
  const path = formatTerminalPath(normalizeDiffPath(file.path) ?? file.path);
  const previousPath = file.previousPath
    ? formatTerminalPath(normalizeDiffPath(file.previousPath) ?? file.previousPath)
    : undefined;

  if (!previousPath || previousPath === path) {
    return basename(path);
  }

  const previousName = basename(previousPath);
  const nextName = basename(path);
  return previousName === nextName ? nextName : `${previousName} -> ${nextName}`;
}

/** Build the visible stats badges for one sidebar row.
 * Keep the agent-note badge first so it reads as review context before line churn.
 */
export function sidebarEntryStats(
  entry: Pick<FileListEntry, "agentCommentsText" | "additionsText" | "deletionsText">,
) {
  const stats: Array<{ kind: "agent-comment" | "addition" | "deletion"; text: string }> = [];

  if (entry.agentCommentsText) {
    stats.push({ kind: "agent-comment", text: entry.agentCommentsText });
  }

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
  entry: Pick<FileListEntry, "agentCommentsText" | "additionsText" | "deletionsText">,
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

/** Build the grouped sidebar entries while preserving the review stream order. */
export function buildSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  let activeGroup: string | undefined;

  files.forEach((file, index) => {
    const path = formatTerminalPath(normalizeDiffPath(file.path) ?? file.path);
    const group = dirname(path);

    if (group !== activeGroup) {
      activeGroup = group;
      entries.push({
        kind: "group",
        id: `group:${group}:${index}`,
        label: group === "." ? "./" : `${group}/`,
      });
    }

    const agentCommentCount = file.agent?.annotations.length ?? 0;
    // Badge text is the shared review formatter's, not the sidebar's, so a browser
    // rendering the same file states the same churn (E1).
    const { additionsText, deletionsText } = reviewFileStatBadges({
      additions: file.stats.additions,
      deletions: file.stats.deletions,
      ...(file.statsTruncated !== undefined ? { truncated: file.statsTruncated } : {}),
    });

    entries.push({
      kind: "file",
      id: file.id,
      name: sidebarFileName(file),
      agentCommentsText: agentCommentCount > 0 ? `*${agentCommentCount}` : null,
      additionsText,
      deletionsText,
      changeType: file.changeType ?? readMetadataChangeType(file.metadata) ?? "change",
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

  const path = formatTerminalPath(normalizeDiffPath(file.path) ?? file.path);
  const previousPath = file.previousPath
    ? formatTerminalPath(normalizeDiffPath(file.previousPath) ?? file.previousPath)
    : undefined;
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
