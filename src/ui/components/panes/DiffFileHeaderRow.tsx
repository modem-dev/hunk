import { Show } from "solid-js";
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
export function DiffFileHeaderRow(props: DiffFileHeaderRowProps) {
  const additionsText = () =>
    `+${props.file.stats.additions}${props.file.statsTruncated ? "+" : ""}`;
  const deletionsText = () => `-${props.file.stats.deletions}`;
  const labelParts = () => fileLabelParts(props.file);

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
        backgroundColor: props.theme.panel,
      }}
      onMouseUp={props.onSelect}
    >
      {/* Clicking the file header jumps the main stream selection without collapsing to a single-file view. */}
      <box style={{ flexDirection: "row" }}>
        <text fg={props.theme.text}>
          {fitText(
            labelParts().filename,
            Math.max(1, props.headerLabelWidth - (labelParts().stateLabel?.length ?? 0)),
          )}
        </text>
        <Show when={labelParts().stateLabel}>
          <text fg={props.theme.muted}>{labelParts().stateLabel}</text>
        </Show>
      </box>
      <box
        style={{
          width: props.headerStatsWidth,
          height: 1,
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        <text fg={props.theme.badgeAdded}>{additionsText()}</text>
        <text fg={props.theme.muted}> </text>
        <text fg={props.theme.badgeRemoved}>{deletionsText()}</text>
        <text fg={props.theme.muted}> </text>
      </box>
    </box>
  );
}
