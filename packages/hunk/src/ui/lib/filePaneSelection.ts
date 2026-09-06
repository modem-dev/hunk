/**
 * Resolves files-pane cursors against the visible sidebar rows.
 * Folder actions follow the on-screen hierarchy: nested files in tree view,
 * only the files listed under a compact group in flat view.
 */
import type { FileListEntry, SidebarEntry } from "./files";

/** Cursor over one visible files-pane row, restored after inventory refresh. */
export type FilePaneCursor =
  | { kind: "file"; id: string }
  | { kind: "folder"; path: string; firstFileId: string };

/** Return the file rows visually nested under one sidebar entry. */
export function filesVisuallyUnderSidebarEntry(
  entries: readonly SidebarEntry[],
  index: number,
): FileListEntry[] {
  const selected = entries[index];
  if (!selected) return [];
  if (selected.kind === "file") return [selected];

  const files: FileListEntry[] = [];
  const selectedDepth = selected.kind === "directory" ? selected.depth : -1;
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.kind === "group") break;
    if (entry.kind === "directory" && entry.depth <= selectedDepth) break;
    if (entry.kind === "file" && entry.depth <= selectedDepth) break;
    if (entry.kind === "file") files.push(entry);
  }
  return files;
}

/** Capture a refresh-stable cursor for the row at `index`. */
export function cursorFromSidebarIndex(
  entries: readonly SidebarEntry[],
  index: number,
): FilePaneCursor | null {
  const entry = entries[index];
  if (!entry) return null;
  if (entry.kind === "file") return { kind: "file", id: entry.id };
  return {
    kind: "folder",
    path: entry.path,
    firstFileId: filesVisuallyUnderSidebarEntry(entries, index)[0]?.id ?? "",
  };
}

/** Resolve a stored cursor back to a visible row, falling back to the nearest file. */
export function sidebarIndexFromCursor(
  entries: readonly SidebarEntry[],
  cursor: FilePaneCursor | null,
): number {
  if (entries.length === 0) return -1;
  if (!cursor) {
    const firstFile = entries.findIndex((entry) => entry.kind === "file");
    return firstFile >= 0 ? firstFile : 0;
  }
  if (cursor.kind === "file") {
    const index = entries.findIndex((entry) => entry.kind === "file" && entry.id === cursor.id);
    return index >= 0 ? index : fallbackFileIndex(entries);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind === "file" || entry.path !== cursor.path) continue;
    const firstFile = filesVisuallyUnderSidebarEntry(entries, index)[0];
    if ((firstFile?.id ?? "") === cursor.firstFileId) return index;
  }

  const samePathIndexes = entries.flatMap((entry, index) =>
    entry.kind !== "file" && entry.path === cursor.path ? [index] : [],
  );
  if (samePathIndexes.length === 1) return samePathIndexes[0]!;
  if (cursor.firstFileId) {
    const fileIndex = entries.findIndex(
      (entry) => entry.kind === "file" && entry.id === cursor.firstFileId,
    );
    if (fileIndex >= 0) return fileIndex;
  }
  return fallbackFileIndex(entries);
}

/** Step the files-pane cursor through every visible row, including folders. */
export function stepSidebarIndex(
  entries: readonly SidebarEntry[],
  index: number,
  delta: number,
): number {
  if (entries.length === 0) return -1;
  const start = index >= 0 ? index : fallbackFileIndex(entries);
  return Math.max(0, Math.min(entries.length - 1, start + delta));
}

/** Find the row id currently highlighted in the files pane. */
export function sidebarEntryIdAtIndex(entries: readonly SidebarEntry[], index: number) {
  return entries[index]?.id ?? null;
}

function fallbackFileIndex(entries: readonly SidebarEntry[]) {
  const firstFile = entries.findIndex((entry) => entry.kind === "file");
  return firstFile >= 0 ? firstFile : 0;
}
