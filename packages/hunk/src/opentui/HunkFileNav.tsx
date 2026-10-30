import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileDirectoryRow,
  FileGroupHeader,
  FileListItem,
} from "../ui/components/panes/FileListItem";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  collapseTreeSidebarEntries,
  expandCollapsedDirectoryPaths,
  resolveFileSidebarMode,
  sidebarDirectoryPaths,
  sidebarEntryStatsWidth,
  toggleCollapsedDirectoryPath,
} from "../ui/lib/files";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFiles } from "./model";
import type { HunkFileNavProps } from "./types";

/** Render Hunk's file navigation list without global shortcuts, scrolling, borders, or surrounding chrome. */
export function HunkFileNav({
  files,
  selectedFileId,
  width,
  theme = "github-dark-default",
  onSelectFile = () => {},
}: HunkFileNavProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const internalFiles = useMemo(() => toInternalDiffFiles(files), [files]);
  const previousSelectedFileIdRef = useRef(selectedFileId);
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const textWidth = Math.max(1, width - 1);
  const mode = resolveFileSidebarMode(textWidth);
  const entries = useMemo(() => {
    if (mode === "flat") {
      return buildFlatSidebarEntries(internalFiles);
    }
    return collapseTreeSidebarEntries(
      buildTreeSidebarEntries(internalFiles),
      collapsedDirectoryPaths,
    );
  }, [collapsedDirectoryPaths, internalFiles, mode]);

  /** Toggle one logical directory everywhere it appears in the ordered tree projection. */
  const toggleDirectory = (path: string) => {
    setCollapsedDirectoryPaths((current) => toggleCollapsedDirectoryPath(current, path));
  };

  useEffect(() => {
    const previousSelectedFileId = previousSelectedFileIdRef.current;
    previousSelectedFileIdRef.current = selectedFileId;
    if (!selectedFileId || selectedFileId === previousSelectedFileId) {
      return;
    }

    const selectedFile = internalFiles.find((file) => file.id === selectedFileId);
    if (!selectedFile) {
      return;
    }

    setCollapsedDirectoryPaths((current) =>
      expandCollapsedDirectoryPaths(current, sidebarDirectoryPaths(selectedFile.path)),
    );
  }, [internalFiles, selectedFileId]);

  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: resolvedTheme.panel }}>
      {entries.map((entry) => {
        if (entry.kind === "group") {
          return (
            <FileGroupHeader
              key={entry.id}
              entry={entry}
              paddingLeft={0}
              textWidth={Math.max(1, width)}
              theme={resolvedTheme}
            />
          );
        }
        if (entry.kind === "directory") {
          return (
            <FileDirectoryRow
              key={entry.id}
              collapsed={collapsedDirectoryPaths.has(entry.path)}
              entry={entry}
              onToggleDirectory={toggleDirectory}
              paddingLeft={0}
              statsWidth={statsWidth}
              textWidth={textWidth}
              theme={resolvedTheme}
            />
          );
        }

        return (
          <FileListItem
            key={entry.id}
            entry={entry}
            paddingLeft={0}
            selected={entry.id === selectedFileId}
            statsWidth={statsWidth}
            textWidth={textWidth}
            theme={resolvedTheme}
            onSelectFile={onSelectFile}
          />
        );
      })}
    </box>
  );
}
