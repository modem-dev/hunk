import type { ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { sidebarEntryStatsWidth, type SidebarEntry } from "../../lib/files";
import type { AppTheme } from "../../themes";
import { FileGroupHeader, FileListItem } from "./FileListItem";

/** Render the file navigation sidebar. */
export function SidebarPane({
  entries,
  scrollRef,
  selectedFileId,
  textWidth,
  theme,
  width,
  onSelectFile,
}: {
  entries: SidebarEntry[];
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedFileId?: string;
  textWidth: number;
  theme: AppTheme;
  width: number;
  onSelectFile: (fileId: string) => void;
}) {
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));

  return (
    <box
      style={{
        width,
        border: ["top"],
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingY: 1,
        paddingX: 0,
        flexDirection: "column",
      }}
    >
      <scrollbox
        ref={scrollRef}
        width="100%"
        height="100%"
        focused={false}
        scrollY={true}
        viewportCulling={true}
        rootOptions={{ backgroundColor: theme.panel }}
        wrapperOptions={{ backgroundColor: theme.panel }}
        viewportOptions={{ backgroundColor: theme.panel }}
        contentOptions={{ backgroundColor: theme.panel }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box style={{ width: "100%", flexDirection: "column" }}>
          {entries.map((entry) =>
            entry.kind === "group" ? (
              <FileGroupHeader key={entry.id} entry={entry} textWidth={textWidth} theme={theme} />
            ) : (
              <FileListItem
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedFileId}
                statsWidth={statsWidth}
                textWidth={textWidth}
                theme={theme}
                onSelect={() => onSelectFile(entry.id)}
              />
            ),
          )}
        </box>
      </scrollbox>
    </box>
  );
}
