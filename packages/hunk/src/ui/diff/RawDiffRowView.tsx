/** Adapts renderer-only diff rows to the canonical planned-row view. */
import { memo } from "react";
import type { DiffRow } from "./diffRows";
import { DiffRowView, type DiffRowViewProps } from "./DiffRowView";
import { legacyPlannedDiffRow } from "./codeRowLayout";

/** Inputs for a raw row rendered outside the shared review plan. */
export interface RawDiffRowViewProps extends Omit<DiffRowViewProps, "plannedRow"> {
  row: DiffRow;
  anchorId?: string;
  noteGuideSide?: "old" | "new";
}

/** Wrap a raw diff row in the planned envelope required by the mounted row view. */
export const RawDiffRowView = memo(function RawDiffRowViewComponent({
  row,
  anchorId,
  noteGuideSide,
  ...viewProps
}: RawDiffRowViewProps) {
  return (
    <DiffRowView {...viewProps} plannedRow={legacyPlannedDiffRow(row, anchorId, noteGuideSide)} />
  );
});
