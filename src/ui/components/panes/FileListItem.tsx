import type { FileListEntry } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { fileRowId } from "../../lib/ids";

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
  return (
    <box
      id={fileRowId(entry.id)}
      style={{
        width: "100%",
        height: 2,
        backgroundColor: theme.panel,
        flexDirection: "row",
      }}
      onMouseUp={onSelect}
    >
      <box
        style={{
          width: 1,
          height: 2,
          backgroundColor: selected ? theme.accent : theme.panel,
        }}
      />
      <box
        style={{
          flexGrow: 1,
          height: 2,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "column",
          backgroundColor: theme.panel,
        }}
      >
        <text fg={theme.text}>{fitText(entry.label, textWidth)}</text>
        <text fg={theme.muted}>{fitText(entry.description, textWidth)}</text>
      </box>
    </box>
  );
}
