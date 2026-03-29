import type { FileGroupEntry, FileListEntry } from "../../lib/files";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { fileRowId } from "../../lib/ids";

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
  textWidth,
  theme,
}: {
  entry: FileGroupEntry;
  textWidth: number;
  theme: AppTheme;
}) {
  return (
    <box
      style={{
        width: "100%",
        height: 1,
        paddingLeft: 1,
        backgroundColor: theme.panel,
      }}
    >
      <text fg={theme.muted}>{fitText(entry.label, Math.max(1, textWidth))}</text>
    </box>
  );
}

/** Render one file row in the navigation sidebar. */
export function FileListItem({
  additionsWidth,
  deletionsWidth,
  entry,
  selected,
  textWidth,
  theme,
  onSelect,
}: {
  additionsWidth: number;
  deletionsWidth: number;
  entry: FileListEntry;
  selected: boolean;
  textWidth: number;
  theme: AppTheme;
  onSelect: () => void;
}) {
  const rowBackground = selected ? theme.panelAlt : theme.panel;
  const statsWidth = additionsWidth + 1 + deletionsWidth;
  const { icon, color } = getFileStateIcon(entry, theme);
  const iconWidth = icon ? 2 : 0; // icon + space
  const nameWidth = Math.max(1, textWidth - 1 - iconWidth - statsWidth - 1);

  return (
    <box
      id={fileRowId(entry.id)}
      style={{
        width: "100%",
        height: 1,
        backgroundColor: rowBackground,
        flexDirection: "row",
      }}
      onMouseUp={onSelect}
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
          paddingLeft: 1,
          flexDirection: "row",
          backgroundColor: rowBackground,
        }}
      >
        {icon && <text fg={color}>{icon} </text>}
        <text fg={theme.text}>{padText(fitText(entry.name, nameWidth), nameWidth)}</text>
        <text fg={theme.badgeAdded}>{entry.additionsText.padStart(additionsWidth, " ")}</text>
        <text fg={selected ? theme.text : theme.muted}> </text>
        <text fg={theme.badgeRemoved}>{entry.deletionsText.padStart(deletionsWidth, " ")}</text>
      </box>
    </box>
  );
}
