import type { DiffFile } from "../../../core/types";
import { iconForFile } from "../../lib/fileIcons";
import { fileLabelParts } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffFileHeaderRowProps {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  nerdFontIcons?: boolean;
  theme: AppTheme;
  onSelect?: () => void;
}

/** Render one file header row in the review stream or sticky overlay. */
export function DiffFileHeaderRow({
  file,
  headerLabelWidth,
  headerStatsWidth,
  nerdFontIcons = false,
  theme,
  onSelect,
}: DiffFileHeaderRowProps) {
  const additionsText = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const deletionsText = `-${file.stats.deletions}`;
  const { filename, stateLabel } = fileLabelParts(file);
  const typeIcon = nerdFontIcons ? iconForFile(file.path) : null;
  const iconWidth = typeIcon ? 2 : 0;

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
      onMouseUp={onSelect}
    >
      {/* Clicking the file header jumps the main stream selection without collapsing to a single-file view. */}
      <box style={{ flexDirection: "row" }}>
        {typeIcon && <text fg={typeIcon.color}>{typeIcon.icon} </text>}
        <text fg={theme.text}>
          {fitText(filename, Math.max(1, headerLabelWidth - iconWidth - (stateLabel?.length ?? 0)))}
        </text>
        {stateLabel && <text fg={theme.muted}>{stateLabel}</text>}
      </box>
      <box
        style={{
          width: headerStatsWidth,
          height: 1,
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        <text fg={theme.badgeAdded}>{additionsText}</text>
        <text fg={theme.muted}> </text>
        <text fg={theme.badgeRemoved}>{deletionsText}</text>
        <text fg={theme.muted}> </text>
      </box>
    </box>
  );
}
