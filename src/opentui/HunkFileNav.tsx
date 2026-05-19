import { useMemo } from "react";
import { FileGroupHeader, FileListItem } from "../ui/components/panes/FileListItem";
import { buildSidebarEntries, sidebarEntryStatsWidth } from "../ui/lib/files";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFiles } from "./model";
import type { HunkFileNavProps } from "./types";

/** Render Hunk's file navigation list without global shortcuts, scrolling, borders, or surrounding chrome. */
export function HunkFileNav({
  files,
  selectedFileId,
  width,
  theme = "graphite",
  onSelectFile = () => {},
}: HunkFileNavProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const internalFiles = useMemo(() => toInternalDiffFiles(files), [files]);
  const entries = useMemo(() => buildSidebarEntries(internalFiles), [internalFiles]);
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));
  const textWidth = Math.max(1, width - 1);

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: resolvedTheme.panel }}>
      {entries.map((entry) =>
        entry.kind === "group" ? (
          <FileGroupHeader
            key={entry.id}
            entry={entry}
            paddingLeft={0}
            textWidth={Math.max(1, width)}
            theme={resolvedTheme}
          />
        ) : (
          <FileListItem
            key={entry.id}
            entry={entry}
            paddingLeft={0}
            selected={entry.id === selectedFileId}
            statsWidth={statsWidth}
            textWidth={textWidth}
            theme={resolvedTheme}
            onSelect={() => onSelectFile(entry.id)}
          />
        ),
      )}
    </box>
  );
}
