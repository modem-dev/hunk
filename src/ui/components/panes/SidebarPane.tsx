import type { ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { sidebarEntryStatsWidth, type SidebarEntry } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { FileGroupHeader, FileListItem } from "./FileListItem";

/** Render the file navigation sidebar. */
export function SidebarPane({
  entries,
  hiddenByMarkCount = 0,
  scrollRef,
  selectedFileId,
  textWidth,
  theme,
  width,
  onSelectFile,
  onUnmarkFile,
}: {
  entries: SidebarEntry[];
  /** When > 0, render a footer hint reminding the user how many files are hidden by marks. */
  hiddenByMarkCount?: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedFileId?: string;
  textWidth: number;
  theme: AppTheme;
  width: number;
  onSelectFile: (fileId: string) => void;
  /** Called when the user clicks a marked sidebar row, so it can be unmarked instead of selected. */
  onUnmarkFile?: (fileId: string) => void;
}) {
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));
  const showHiddenFooter = hiddenByMarkCount > 0;
  const hiddenFooterText = `${hiddenByMarkCount} hidden`;

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
                onSelect={() => {
                  // Clicking a marked row should bring the file back rather than re-select a
                  // hidden file in the diff stream.
                  if (entry.marked && onUnmarkFile) {
                    onUnmarkFile(entry.id);
                    return;
                  }
                  onSelectFile(entry.id);
                }}
              />
            ),
          )}
        </box>
      </scrollbox>
      {showHiddenFooter ? (
        <box
          style={{
            width: "100%",
            height: 1,
            paddingLeft: 1,
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.muted}>{fitText(hiddenFooterText, Math.max(1, textWidth))}</text>
        </box>
      ) : null}
    </box>
  );
}
