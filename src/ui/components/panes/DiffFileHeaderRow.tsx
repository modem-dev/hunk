import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { DiffFile } from "../../../core/types";
import { fileLabelParts } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffFileHeaderRowProps {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  theme: AppTheme;
  collapsed?: boolean;
  onSelect?: () => void;
  onToggleCollapse?: () => void;
}

// Disclosure chevrons mirror GitHub's collapse affordance: ▸ when collapsed,
// ▾ when expanded. The trailing space keeps the filename aligned either way.
const COLLAPSE_CHEVRON = "▸ ";
const EXPAND_CHEVRON = "▾ ";

/** Render one file header row in the review stream or sticky overlay. */
export function DiffFileHeaderRow({
  file,
  headerLabelWidth,
  headerStatsWidth,
  theme,
  collapsed = false,
  onSelect,
  onToggleCollapse,
}: DiffFileHeaderRowProps) {
  const additionsText = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const deletionsText = `-${file.stats.deletions}`;
  const { filename, stateLabel } = fileLabelParts(file);
  const chevron = collapsed ? COLLAPSE_CHEVRON : EXPAND_CHEVRON;
  // The chevron consumes header width; reserve it so the filename doesn't overflow.
  const labelWidth = Math.max(1, headerLabelWidth - chevron.length - (stateLabel?.length ?? 0));

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
        {/* The chevron toggles collapse on its own; stopping propagation keeps the surrounding header click as a plain select. */}
        <box
          style={{ flexDirection: "row" }}
          onMouseUp={
            onToggleCollapse
              ? (event: TuiMouseEvent) => {
                  event.stopPropagation();
                  onToggleCollapse();
                }
              : undefined
          }
        >
          <text fg={theme.muted}>{chevron}</text>
        </box>
        <text fg={theme.text}>{fitText(filename, labelWidth)}</text>
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
