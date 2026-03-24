import type { FileGroupEntry, FileListEntry } from "../../lib/files";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { fileRowId } from "../../lib/ids";

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
  entry,
  selected,
  textWidth,
  theme,
  onSelect,
}: {
  entry: FileListEntry;
  selected: boolean;
  textWidth: number;
  theme: AppTheme;
  onSelect: () => void;
}) {
  const rowBackground = selected ? theme.panelAlt : theme.panel;
  const additionsWidth = entry.additionsText.length;
  const deletionsWidth = entry.deletionsText.length;
  const statsWidth = additionsWidth + 1 + deletionsWidth;
  const nameWidth = Math.max(1, textWidth - 1 - statsWidth - 1);

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
        <text fg={theme.text}>{padText(fitText(entry.name, nameWidth), nameWidth)}</text>
        <text fg={theme.badgeAdded}>{entry.additionsText}</text>
        <text fg={selected ? theme.text : theme.muted}> </text>
        <text fg={theme.badgeRemoved}>{entry.deletionsText}</text>
      </box>
    </box>
  );
}
