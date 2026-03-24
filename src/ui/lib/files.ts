import { basename, dirname } from "node:path/posix";
import type { DiffFile } from "../../core/types";

export interface FileListEntry {
  kind: "file";
  id: string;
  name: string;
  additionsText: string;
  deletionsText: string;
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

/** Group sidebar rows by their current parent folder while preserving file order. */
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
    });
  });

  return entries;
}

/** Build the canonical file label used across headers and note cards. */
export function fileLabel(file: DiffFile | undefined) {
  if (!file) {
    return "No file selected";
  }

  return file.previousPath && file.previousPath !== file.path
    ? `${file.previousPath} -> ${file.path}`
    : file.path;
}
