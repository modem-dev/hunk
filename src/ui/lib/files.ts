import { basename, dirname } from "node:path/posix";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { AgentAnnotation, DiffFile } from "../../core/types";

export interface FileListEntry {
  kind: "file";
  id: string;
  name: string;
  additionsText: string;
  deletionsText: string;
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
  if (!file.previousPath || file.previousPath === file.path) {
    return basename(file.path);
  }

  const previousName = basename(file.previousPath);
  const nextName = basename(file.path);
  return previousName === nextName ? nextName : `${previousName} -> ${nextName}`;
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
    const haystack = [file.path, file.previousPath, file.agent?.summary]
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
    const group = dirname(file.path);
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
      additionsText: `+${file.stats.additions}`,
      deletionsText: `-${file.stats.deletions}`,
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

  const baseLabel =
    file.previousPath && file.previousPath !== file.path
      ? `${file.previousPath} -> ${file.path}`
      : file.path;

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
