import { useMemo } from "react";
import type { DiffRow, SplitLineCell, StackLineCell } from "../../diff/pierre";
import { DiffRowView, fitText } from "../../diff/renderRows";
import { measureTextWidth } from "../../lib/text";
import type { DiffSectionRowPlan } from "../../diff/diffSectionRowPlan";
import type { PlannedReviewRow } from "../../diff/reviewRenderPlan";
import type { LineCursor } from "../../lib/lineCursors";
import type { AppTheme } from "../../themes";

type SplitLineRow = Extract<DiffRow, { type: "split-line" }>;
type StackLineRow = Extract<DiffRow, { type: "stack-line" }>;

/** Adapt one split cell into the full-width stack cell used by the line lens. */
function lensStackCell(cell: SplitLineCell, side: "old" | "new"): StackLineCell {
  return {
    kind: cell.kind === "empty" ? "context" : cell.kind,
    sign: cell.kind === "empty" ? " " : cell.sign,
    ...(side === "old" ? { oldLineNumber: cell.lineNumber } : { newLineNumber: cell.lineNumber }),
    ...(cell.moveKind ? { moveKind: cell.moveKind } : {}),
    spans: cell.spans,
  };
}

/** Convert a side-by-side row into fixed old-above-new lens rows. */
export function buildSplitLineLensRows(row: SplitLineRow): [StackLineRow, StackLineRow] {
  return [
    {
      type: "stack-line",
      key: `${row.key}:lens:old`,
      fileId: row.fileId,
      hunkIndex: row.hunkIndex,
      cell: lensStackCell(row.left, "old"),
    },
    {
      type: "stack-line",
      key: `${row.key}:lens:new`,
      fileId: row.fileId,
      hunkIndex: row.hunkIndex,
      cell: lensStackCell(row.right, "new"),
    },
  ];
}

/** Index split rows by every stable cursor anchor they expose. */
export function indexSplitRowsByStableKey(plannedRows: readonly PlannedReviewRow[]) {
  const splitRowsByStableKey = new Map<string, SplitLineRow>();

  for (const plannedRow of plannedRows) {
    if (plannedRow.kind !== "diff-row" || plannedRow.row.type !== "split-line") {
      continue;
    }

    splitRowsByStableKey.set(plannedRow.stableKey, plannedRow.row);
    for (const stableKey of plannedRow.stableAliasKeys ?? []) {
      splitRowsByStableKey.set(stableKey, plannedRow.row);
    }
  }

  return splitRowsByStableKey;
}

/** Pin the current split row's old and new versions below the review viewport. */
export function SplitLineLens({
  codeHorizontalOffset = 0,
  cursor,
  rowPlan,
  showLineNumbers,
  theme,
  width,
}: {
  codeHorizontalOffset?: number;
  cursor: LineCursor;
  rowPlan: DiffSectionRowPlan;
  showLineNumbers: boolean;
  theme: AppTheme;
  width: number;
}) {
  const splitRowsByStableKey = useMemo(
    () => indexSplitRowsByStableKey(rowPlan.plannedRows),
    [rowPlan.plannedRows],
  );
  const splitRow = splitRowsByStableKey.get(cursor.stableKey) ?? null;
  const lensRows = useMemo(() => (splitRow ? buildSplitLineLensRows(splitRow) : null), [splitRow]);

  if (!lensRows) {
    return null;
  }

  const label = fitText("─ Current line · old above, new below ", width);
  const rule = label + "─".repeat(Math.max(0, width - measureTextWidth(label)));
  return (
    <box
      style={{
        width: "100%",
        height: 3,
        minHeight: 3,
        flexShrink: 0,
        flexDirection: "column",
        backgroundColor: theme.panel,
      }}
    >
      <text fg={theme.border}>{rule}</text>
      {lensRows.map((row) => (
        <DiffRowView
          key={row.key}
          row={row}
          width={width}
          lineNumberDigits={rowPlan.lineNumberDigits}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={false}
          wrapLines={false}
          codeHorizontalOffset={codeHorizontalOffset}
          theme={theme}
          selected={false}
        />
      ))}
    </box>
  );
}
