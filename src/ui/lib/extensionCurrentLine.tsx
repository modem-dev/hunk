import type { ExtensionCurrentLinePaint } from "../../extension-api/types";
import type { DiffRow, SplitLineCell, StackLineCell } from "../diff/diffRows";
import { DiffRowView } from "../diff/DiffRowView";
import type { DiffSectionRowPlan } from "../diff/diffSectionRowPlan";
import type { LineCursor } from "./lineCursors";
import type { AppTheme } from "../themes";

type SplitLineRow = Extract<DiffRow, { type: "split-line" }>;
type StackLineRow = Extract<DiffRow, { type: "stack-line" }>;

/** One lifecycle update from the review renderer to pane orchestration. */
export type ExtensionCurrentLinePaintUpdate =
  | { status: "unavailable" }
  | { status: "pending" }
  | { status: "ready"; fileId: string; cursorKey: string; paint: ExtensionCurrentLinePaint };

/** Accepted paint plus the cursor identity it was built from. */
export interface ExtensionCurrentLinePaintState {
  status: ExtensionCurrentLinePaintUpdate["status"];
  fileId: string | null;
  cursorKey: string | null;
  paint: ExtensionCurrentLinePaint | null;
}

/** Match paint only to the exact file-scoped cursor identity that produced it. */
export function extensionCurrentLinePaintMatchesCursor(
  state: ExtensionCurrentLinePaintState,
  cursor: { fileId: string; stableKey: string } | null,
): boolean {
  return (
    state.status === "ready" &&
    state.fileId === cursor?.fileId &&
    state.cursorKey === cursor?.stableKey
  );
}

/** Apply one exact renderer lifecycle update. */
export function applyExtensionCurrentLinePaintUpdate(
  current: ExtensionCurrentLinePaintState,
  update: ExtensionCurrentLinePaintUpdate,
): ExtensionCurrentLinePaintState {
  if (update.status === "ready") {
    return {
      status: "ready",
      fileId: update.fileId,
      cursorKey: update.cursorKey,
      paint: update.paint,
    };
  }
  if (current.status === update.status && current.paint === null) return current;
  return { status: update.status, fileId: null, cursorKey: null, paint: null };
}

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

/** Build the public current-line painter and source address from the accepted row plan. */
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
    side: cursor.target.side,
    line: cursor.target.line,
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
