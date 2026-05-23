import { expandDiffTabs } from "./codeColumns";
import type {
  CollapsedGapPosition,
  DiffRow,
  RenderSpan,
  SplitLineCell,
  StackLineCell,
} from "./pierre";

export type ExpansionLayout = "split" | "stack";

/** Per-file load status for the source text used to fill expanded gaps. */
export type FileSourceStatus =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "error" };

export interface ExpandCollapsedRowsOptions {
  layout: ExpansionLayout;
  expandedKeys: ReadonlySet<string>;
  sourceStatus: FileSourceStatus | undefined;
  /** Optional syntax-aware span resolver for a zero-based source line. */
  sourceLineSpans?: (line: string | undefined, sourceLineNumber: number) => RenderSpan[];
  // Whose side's line indices in the source text. Defaults to "new".
  // For deleted files (no new side) callers should pass "old" instead.
  side?: "old" | "new";
}

/** Stable identifier for one collapsed gap inside a single file. */
export function gapKey(position: CollapsedGapPosition, hunkIndex: number) {
  return `${position}:${hunkIndex}`;
}

/**
 * Pick the gap key that the keyboard shortcut should toggle for the selected
 * hunk. Looks at the leading gap of the current hunk first, then the leading
 * gaps of subsequent hunks, and finally the trailing gap of the file. Returns
 * `null` when no reachable gap exists.
 */
export function selectGapForKeyboardToggle(
  hunks: ReadonlyArray<{ collapsedBefore: number }>,
  selectedHunkIndex: number,
  hasTrailingGap: boolean,
): string | null {
  if (hunks.length === 0) {
    return null;
  }

  const startIndex = Math.max(0, Math.min(selectedHunkIndex, hunks.length - 1));
  for (let index = startIndex; index < hunks.length; index += 1) {
    if ((hunks[index]?.collapsedBefore ?? 0) > 0) {
      return gapKey("before", index);
    }
  }

  if (hasTrailingGap) {
    return gapKey("trailing", hunks.length - 1);
  }

  return null;
}

function expandedRowText(lineCount: number) {
  return `Hide ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}`;
}

function loadingRowText(lineCount: number) {
  return `Loading ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}…`;
}

function errorRowText(lineCount: number) {
  return `Could not load ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}`;
}

function sliceLines(sourceText: string) {
  // Normalize CRLF so Windows-authored sources don't leak `\r` into rendered spans.
  const normalized = sourceText.replaceAll("\r\n", "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.length === 0 ? [] : trimmed.split("\n");
}

function spansFor(line: string | undefined): RenderSpan[] {
  const text = expandDiffTabs(line ?? "");
  return text.length > 0 ? [{ text }] : [];
}

function buildSplitContextRow(
  fileId: string,
  hunkIndex: number,
  position: CollapsedGapPosition,
  index: number,
  oldLineNumber: number,
  newLineNumber: number,
  spans: RenderSpan[],
): Extract<DiffRow, { type: "split-line" }> {
  const cell = (lineNumber: number): SplitLineCell => ({
    kind: "context",
    sign: " ",
    lineNumber,
    spans,
  });

  return {
    type: "split-line",
    key: `${fileId}:expanded:${position}:${hunkIndex}:${index}`,
    fileId,
    hunkIndex,
    left: cell(oldLineNumber),
    right: cell(newLineNumber),
    isExpansionRow: true,
  };
}

function buildStackContextRow(
  fileId: string,
  hunkIndex: number,
  position: CollapsedGapPosition,
  index: number,
  oldLineNumber: number,
  newLineNumber: number,
  spans: RenderSpan[],
): Extract<DiffRow, { type: "stack-line" }> {
  const cell: StackLineCell = {
    kind: "context",
    sign: " ",
    oldLineNumber,
    newLineNumber,
    spans,
  };

  return {
    type: "stack-line",
    key: `${fileId}:expanded:${position}:${hunkIndex}:${index}`,
    fileId,
    hunkIndex,
    cell,
    isExpansionRow: true,
  };
}

/**
 * Replace each expanded collapsed row with the actual unchanged file lines it
 * represents. The original collapsed row stays in place as a status row, and
 * synthesized context rows follow it when source has loaded. When source is
 * still loading or failed, only the row label changes so the user sees the
 * state of the request.
 */
export function expandCollapsedRows(
  rows: DiffRow[],
  options: ExpandCollapsedRowsOptions,
): DiffRow[] {
  const { layout, expandedKeys, sourceLineSpans, sourceStatus, side = "new" } = options;

  if (expandedKeys.size === 0) {
    return rows;
  }

  const sourceLines = sourceStatus?.kind === "loaded" ? sliceLines(sourceStatus.text) : [];
  const result: DiffRow[] = [];

  for (const row of rows) {
    if (row.type !== "collapsed") {
      result.push(row);
      continue;
    }

    const key = gapKey(row.position, row.hunkIndex);
    if (!expandedKeys.has(key)) {
      result.push(row);
      continue;
    }

    const range = side === "old" ? row.oldRange : row.newRange;
    const lineCount = Math.max(0, range[1] - range[0] + 1);

    if (sourceStatus?.kind === "loading") {
      result.push({ ...row, text: loadingRowText(lineCount) });
      continue;
    }

    if (sourceStatus?.kind === "error") {
      result.push({ ...row, text: errorRowText(lineCount) });
      continue;
    }

    if (sourceStatus === undefined) {
      // expandedKeys can briefly contain a key before the controller's load
      // status is committed; keep the original label until status arrives.
      result.push(row);
      continue;
    }

    const sourceStartIndex = range[0] - 1;
    const sourceEndIndex = range[1] - 1;
    if (
      lineCount > 0 &&
      (sourceStartIndex < 0 ||
        sourceEndIndex < sourceStartIndex ||
        sourceEndIndex >= sourceLines.length)
    ) {
      result.push({ ...row, text: errorRowText(lineCount) });
      continue;
    }

    result.push({
      ...row,
      text: expandedRowText(lineCount),
    });

    for (let offset = 0; offset < lineCount; offset += 1) {
      const oldLineNumber = row.oldRange[0] + offset;
      const newLineNumber = row.newRange[0] + offset;
      const sourceLineNumber = (side === "old" ? oldLineNumber : newLineNumber) - 1;
      if (sourceLineNumber < 0 || sourceLineNumber >= sourceLines.length) {
        break;
      }

      const text = sourceLines[sourceLineNumber];
      const spans = sourceLineSpans?.(text, sourceLineNumber) ?? spansFor(text);

      result.push(
        layout === "split"
          ? buildSplitContextRow(
              row.fileId,
              row.hunkIndex,
              row.position,
              offset,
              oldLineNumber,
              newLineNumber,
              spans,
            )
          : buildStackContextRow(
              row.fileId,
              row.hunkIndex,
              row.position,
              offset,
              oldLineNumber,
              newLineNumber,
              spans,
            ),
      );
    }
  }

  return result;
}
