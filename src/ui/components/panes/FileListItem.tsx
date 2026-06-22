import { memo } from "react";
import { fileRowId } from "../../lib/ids";
import { iconForFile } from "../../lib/fileIcons";
import { sidebarEntryStats, type FileGroupEntry, type FileListEntry } from "../../lib/files";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Get icon and color for file state using standard git status codes. */
function getFileStateIcon(entry: FileListEntry, theme: AppTheme): { icon: string; color: string } {
  if (entry.isUntracked) {
    return { icon: "?", color: theme.fileUntracked };
  }

  switch (entry.changeType) {
    case "new":
      return { icon: "A", color: theme.fileNew };
    case "deleted":
      return { icon: "D", color: theme.fileDeleted };
    case "rename-pure":
    case "rename-changed":
      return { icon: "R", color: theme.fileRenamed };
    case "change":
      return { icon: "M", color: theme.fileModified };
    default:
      return { icon: "", color: theme.text };
  }
}

/** Render one folder header in the navigation sidebar. */
export function FileGroupHeader({
  entry,
  nerdFontIcons = false,
  paddingLeft = 1,
  textWidth,
  theme,
}: {
  entry: FileGroupEntry;
  nerdFontIcons?: boolean;
  paddingLeft?: number;
  textWidth: number;
  theme: AppTheme;
}) {
  const folderIcon = nerdFontIcons ? iconForFile(entry.label, true) : null;
  const iconWidth = folderIcon ? 2 : 0;
  return (
    <box
      style={{
        width: "100%",
        height: 1,
        paddingLeft,
        flexDirection: "row",
        backgroundColor: theme.panel,
      }}
    >
      {folderIcon ? <text fg={folderIcon.color}>{folderIcon.icon} </text> : null}
      <text fg={theme.muted}>{fitText(entry.label, Math.max(1, textWidth - iconWidth))}</text>
    </box>
  );
}

/** Render one file row in the navigation sidebar. */
export const FileListItem = memo(function FileListItem({
  entry,
  nerdFontIcons = false,
  paddingLeft = 1,
  selected,
  statsWidth,
  textWidth,
  theme,
  onSelectFile,
}: {
  entry: FileListEntry;
  nerdFontIcons?: boolean;
  paddingLeft?: number;
  selected: boolean;
  statsWidth: number;
  textWidth: number;
  theme: AppTheme;
  onSelectFile: (fileId: string) => void;
}) {
  const rowBackground = selected ? theme.panelAlt : theme.panel;
  const stats = sidebarEntryStats(entry);
  const { icon, color } = getFileStateIcon(entry, theme);
  const typeIcon = nerdFontIcons ? iconForFile(entry.name) : null;
  const iconWidth = (icon ? 2 : 0) + (typeIcon ? 2 : 0); // icons + spaces
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const nameWidth = Math.max(1, textWidth - 1 - iconWidth - statsSectionWidth);

  return (
    <box
      id={fileRowId(entry.id)}
      style={{
        width: "100%",
        height: 1,
        backgroundColor: rowBackground,
        flexDirection: "row",
      }}
      onMouseUp={() => onSelectFile(entry.id)}
    >
      <box
        style={{
          width: 1,
          height: 1,
          backgroundColor: selected ? theme.accent : rowBackground,
        }}
      />
      <box
        style={{
          flexGrow: 1,
          height: 1,
          paddingLeft,
          flexDirection: "row",
          backgroundColor: rowBackground,
        }}
      >
        {icon && <text fg={color}>{icon} </text>}
        {typeIcon && <text fg={typeIcon.color}>{typeIcon.icon} </text>}
        <text fg={theme.text}>{padText(fitText(entry.name, nameWidth), nameWidth)}</text>
        {statsSectionWidth > 0 && (
          <box
            style={{
              width: statsSectionWidth,
              height: 1,
              flexDirection: "row",
              justifyContent: "flex-end",
              backgroundColor: rowBackground,
            }}
          >
            {stats.map((stat, index) => (
              <box
                key={`${entry.id}:${stat.kind}`}
                style={{ height: 1, flexDirection: "row", backgroundColor: rowBackground }}
              >
                {index > 0 && <text fg={selected ? theme.text : theme.muted}> </text>}
                <text
                  fg={
                    stat.kind === "agent-comment"
                      ? theme.noteBorder
                      : stat.kind === "addition"
                        ? theme.badgeAdded
                        : theme.badgeRemoved
                  }
                >
                  {stat.text}
                </text>
              </box>
            ))}
          </box>
        )}
      </box>
    </box>
  );
});
