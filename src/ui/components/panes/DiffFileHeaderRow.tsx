import type { DiffFile } from "../../../core/types";
import { fileLabelParts } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffFileHeaderRowProps {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  theme: AppTheme;
  onSelect?: () => void;
}

/** Render one file header row in the review stream or sticky overlay. */
export function DiffFileHeaderRow({
  file,
  headerLabelWidth,
  headerStatsWidth,
  theme,
  onSelect,
}: DiffFileHeaderRowProps) {
  const additionsText = `+${file.stats.additions}`;
  const deletionsText = `-${file.stats.deletions}`;
  const { filename, stateLabel } = fileLabelParts(file);

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
        <text fg={theme.text}>
          {fitText(filename, Math.max(1, headerLabelWidth - (stateLabel?.length ?? 0)))}
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
      </box>
    </box>
  );
}
