import { useMemo } from "react";
import {
  FileDirectoryRow,
  FileGroupHeader,
  FileListItem,
} from "../ui/components/panes/FileListItem";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  resolveFileSidebarMode,
  sidebarEntryStatsWidth,
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
  const textWidth = Math.max(1, width - 1);
  const mode = resolveFileSidebarMode(textWidth);
  const entries = useMemo(
    () =>
      mode === "tree"
        ? buildTreeSidebarEntries(internalFiles)
        : buildFlatSidebarEntries(internalFiles),
    [internalFiles, mode],
  );
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
              entry={entry}
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
