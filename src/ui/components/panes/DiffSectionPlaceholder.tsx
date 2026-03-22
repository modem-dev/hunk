import type { DiffFile } from "../../../core/types";
import { diffSectionId } from "../../lib/ids";
import { fileLabel } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffSectionPlaceholderProps {
  bodyHeight: number;
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  separatorWidth: number;
  showSeparator: boolean;
  theme: AppTheme;
  onSelect: () => void;
}

/** Reserve offscreen section height without mounting its full diff rows. */
export function DiffSectionPlaceholder({
  bodyHeight,
  file,
  headerLabelWidth,
  headerStatsWidth,
  separatorWidth,
  showSeparator,
  theme,
  onSelect,
}: DiffSectionPlaceholderProps) {
  const additionsText = `+${file.stats.additions}`;
  const deletionsText = `-${file.stats.deletions}`;

  return (
    <box
      id={diffSectionId(file.id)}
      style={{
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.panel,
      }}
    >
      {showSeparator ? (
        <box
          style={{
            width: "100%",
            height: 1,
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.border}>{fitText("─".repeat(separatorWidth), separatorWidth)}</text>
        </box>
      ) : null}

      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.panel,
        }}
        onMouseUp={onSelect}
      >
        <text fg={theme.text}>{fitText(fileLabel(file), headerLabelWidth)}</text>
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

      <box style={{ width: "100%", height: bodyHeight, backgroundColor: theme.panel }} />
    </box>
  );
}
