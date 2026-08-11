import type { ExtensionCurrentLinePaint } from "../../extension-api/types";
import type { DiffRow, SplitLineCell, StackLineCell } from "../diff/pierre";
import { DiffRowView } from "../diff/renderRows";
import type { DiffSectionRowPlan } from "../diff/diffSectionRowPlan";
import type { LineCursor } from "./lineCursors";
import type { AppTheme } from "../themes";

type SplitLineRow = Extract<DiffRow, { type: "split-line" }>;
type StackLineRow = Extract<DiffRow, { type: "stack-line" }>;

/** Adapt one private split cell into the private full-width row painter. */
function stackRow(row: SplitLineRow, cell: SplitLineCell, side: "old" | "new"): StackLineRow {
  const adapted: StackLineCell = {
    kind: cell.kind === "empty" ? "context" : cell.kind,
    sign: cell.kind === "empty" ? " " : cell.sign,
    ...(side === "old" ? { oldLineNumber: cell.lineNumber } : { newLineNumber: cell.lineNumber }),
    ...(cell.moveKind ? { moveKind: cell.moveKind } : {}),
    spans: cell.spans,
  };
  return {
    type: "stack-line",
    key: `${row.key}:pane:${side}`,
    fileId: row.fileId,
    hunkIndex: row.hunkIndex,
    cell: adapted,
  };
}

/** Build an opaque public painter from the exact accepted private row plan. */
export function createExtensionCurrentLinePaint({
  cursor,
  rowPlan,
  showLineNumbers,
  codeHorizontalOffset,
  theme,
}: {
  cursor: LineCursor;
  rowPlan: DiffSectionRowPlan;
  showLineNumbers: boolean;
  codeHorizontalOffset: number;
  theme: AppTheme;
}): ExtensionCurrentLinePaint | null {
  let splitRow: SplitLineRow | undefined;
  for (const planned of rowPlan.plannedRows) {
    if (planned.kind !== "diff-row" || planned.row.type !== "split-line") continue;
    if (
      planned.stableKey === cursor.stableKey ||
      planned.stableAliasKeys?.includes(cursor.stableKey)
    ) {
      splitRow = planned.row;
      break;
    }
  }
  if (!splitRow) return null;
  const rows = {
    old: stackRow(splitRow, splitRow.left, "old"),
    new: stackRow(splitRow, splitRow.right, "new"),
  };
  return Object.freeze({
    render(side: "old" | "new", width: number) {
      return (
        <DiffRowView
          key={rows[side].key}
          row={rows[side]}
          width={width}
          lineNumberDigits={rowPlan.lineNumberDigits}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={false}
          wrapLines={false}
          codeHorizontalOffset={codeHorizontalOffset}
          theme={theme}
          selected={false}
        />
      );
    },
  });
}
