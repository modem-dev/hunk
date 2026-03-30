import type { DiffFile } from "../../../core/types";
import { diffSectionId } from "../../lib/ids";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";

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

      <DiffFileHeaderRow
        file={file}
        headerLabelWidth={headerLabelWidth}
        headerStatsWidth={headerStatsWidth}
        theme={theme}
        onSelect={onSelect}
      />

      <box style={{ width: "100%", height: bodyHeight, backgroundColor: theme.panel }} />
    </box>
  );
}
