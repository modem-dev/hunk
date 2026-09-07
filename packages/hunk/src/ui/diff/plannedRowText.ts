/** Projects planned review rows to the plain text used by selection and clipboard surfaces. */
import type { DiffFile } from "../../core/changeset/model";
import { reviewEmptyDiffReason, type ReviewEmptyDiffReason } from "../../core/review/document";
import { sanitizeTerminalLine, sanitizeTerminalSpans } from "../../lib/terminalText";
import { inlineNoteTitle } from "../lib/agentAnnotations";
import {
  measureSanitizedTextWidth,
  padText,
  sliceSanitizedTextByWidth,
  sliceTextByWidth,
  wrapText,
} from "../lib/text";
import {
  planCodeRowLayout,
  type CodeCellLayoutPlan,
  type CodeRowLayoutPlan,
} from "./codeRowLayout";
import type { RenderSpan, SplitLineCell, StackLineCell } from "./diffRowModel";
import { diffRailMarker, splitGutterText, stackGutterText } from "./rowStyle";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import { wrapSpans } from "./styledSpanLayout";

/** Inputs that affect a planned row's plain-text projection. */
export interface PlannedRowTextOptions {
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  reserveAddNoteColumn?: boolean;
  showAddNoteBadge?: boolean;
  /** Limits split rows to one pane; stack rows ignore this filter. */
  side?: "left" | "right";
}

/** One plain cell line with the geometry needed to combine split panes. */
export interface PlainCellLine {
  contentWidth: number;
  gutterWidth: number;
  spansText: string;
}

/** Clamp a sanitized label to one terminal row with an ellipsis. */
export function fitText(text: string, width: number) {
  const safeText = sanitizeTerminalLine(text);
  if (width <= 0) {
    return "";
  }

  if (measureSanitizedTextWidth(safeText) <= width) {
    return safeText;
  }

  if (width === 1) {
    return "…";
  }

  return `${sliceSanitizedTextByWidth(safeText, 0, width - 1).text}…`;
}

/** Convert a list of spans to fixed-width plain text while preserving logical clipping. */
function spansToPlainText(spans: RenderSpan[], width: number, horizontalOffset = 0) {
  if (width <= 0) {
    return "";
  }

  const visible = sliceTextByWidth(
    sanitizeTerminalSpans(spans)
      .map((span) => span.text)
      .join(""),
    Math.max(0, horizontalOffset),
    width,
  );

  return padText(visible.text, Math.max(0, width));
}

/** Flatten styled spans to their sanitized visible text content. */
function spansText(spans: RenderSpan[]) {
  return sanitizeTerminalSpans(spans)
    .map((span) => span.text)
    .join("");
}

/** Return one cell's code text without rail, gutter, sign, or line-number decorations. */
function cellCodeText(spans: RenderSpan[], horizontalOffset = 0) {
  return sliceTextByWidth(spansText(spans), Math.max(0, horizontalOffset), Number.MAX_SAFE_INTEGER)
    .text;
}

/** Build split-cell lines from an existing code layout plan. */
export function buildPlainSplitCellLines(
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  wrapLines: boolean,
  codeHorizontalOffset = 0,
): PlainCellLine[] {
  const gutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    geometry.gutterWidth,
  );
  if (!wrapLines) {
    return [
      {
        contentWidth: geometry.contentWidth,
        gutterWidth: geometry.gutterWidth,
        spansText:
          gutterText + spansToPlainText(cell.spans, geometry.contentWidth, codeHorizontalOffset),
      },
    ];
  }

  // Wrapped rows never apply horizontal scrolling; use the same span layout as the TUI renderer.
  return wrapSpans(cell.spans, geometry.contentWidth).map((spans, index) => ({
    contentWidth: geometry.contentWidth,
    gutterWidth: geometry.gutterWidth,
    spansText:
      (index === 0 ? gutterText : " ".repeat(geometry.gutterWidth)) +
      spansToPlainText(spans, geometry.contentWidth),
  }));
}

/** Build stack-cell lines from an existing code layout plan. */
export function buildPlainStackCellLines(
  cell: StackLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  wrapLines: boolean,
  codeHorizontalOffset = 0,
): PlainCellLine[] {
  const gutterText = stackGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    geometry.gutterWidth,
  );
  if (!wrapLines) {
    return [
      {
        contentWidth: geometry.contentWidth,
        gutterWidth: geometry.gutterWidth,
        spansText:
          gutterText + spansToPlainText(cell.spans, geometry.contentWidth, codeHorizontalOffset),
      },
    ];
  }

  // Wrapped rows never apply horizontal scrolling; use the same span layout as the TUI renderer.
  return wrapSpans(cell.spans, geometry.contentWidth).map((spans, index) => ({
    contentWidth: geometry.contentWidth,
    gutterWidth: geometry.gutterWidth,
    spansText:
      (index === 0 ? gutterText : " ".repeat(geometry.gutterWidth)) +
      spansToPlainText(spans, geometry.contentWidth),
  }));
}

/** Render the marker and label shared by hunk-header and collapsed plain-text rows. */
export function renderHeaderRowText(text: string, width: number) {
  const label = fitText(text, Math.max(0, width - 1));
  return diffRailMarker() + padText(label, Math.max(0, width - 1));
}

/** Render one or more decorated plain-text lines for one planned row. */
export function renderDecoratedPlannedRowText(
  row: PlannedReviewRow,
  options: PlannedRowTextOptions,
) {
  const {
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    codeHorizontalOffset,
    side,
  } = options;

  if (width <= 0) {
    return [];
  }

  if (row.kind === "inline-note") {
    const title = inlineNoteTitle(row.annotation, row.noteIndex, row.noteCount);
    const summaryLines = wrapText(row.annotation.summary ?? "", width).map((line) =>
      fitText(line, width),
    );
    const rationaleLines = row.annotation.rationale
      ? wrapText(row.annotation.rationale, width).map((line) => fitText(line, width))
      : [];
    return [fitText(title, width), ...summaryLines, ...rationaleLines];
  }

  if (row.kind === "hunk-gap") {
    return Array.from({ length: row.height }, () => "");
  }

  const preparedRow = row.row;

  if (preparedRow.type === "hunk-header") {
    return showHunkHeaders ? [renderHeaderRowText(preparedRow.text, width)] : [];
  }

  if (preparedRow.type === "collapsed") {
    return [renderHeaderRowText(`··· ${preparedRow.text} ···`, width)];
  }

  if (preparedRow.type === "split-line") {
    const codeLayout = planCodeRowLayout(row, options) as Extract<
      CodeRowLayoutPlan,
      { kind: "split" }
    >;
    const guideOnOldSide = codeLayout.noteGuideSide === "old";
    const guideOnNewSide = codeLayout.noteGuideSide === "new";
    const leftPrefix = guideOnOldSide ? "│" : diffRailMarker();
    const rightPrefix = "▌";

    const leftCell = buildPlainSplitCellLines(
      preparedRow.left,
      codeLayout.left,
      lineNumberDigits,
      showLineNumbers,
      wrapLines,
      codeHorizontalOffset,
    );
    const rightCell = buildPlainSplitCellLines(
      preparedRow.right,
      codeLayout.right,
      lineNumberDigits,
      showLineNumbers,
      wrapLines,
      codeHorizontalOffset,
    );

    const visualLineCount = Math.max(leftCell.length, rightCell.length);
    return Array.from({ length: visualLineCount }, (_, index) => {
      const leftLine = leftCell[index] ?? {
        gutterWidth: codeLayout.left.gutterWidth,
        contentWidth: codeLayout.left.contentWidth,
        spansText: " ".repeat(Math.max(0, codeLayout.left.width - codeLayout.left.prefixWidth)),
      };
      const rightLine = rightCell[index] ?? {
        gutterWidth: codeLayout.right.gutterWidth,
        contentWidth: codeLayout.right.contentWidth,
        spansText: " ".repeat(Math.max(0, codeLayout.right.width - codeLayout.right.prefixWidth)),
      };
      const normalizedLeft = padText(`${leftPrefix}${leftLine.spansText}`, codeLayout.left.width);
      const normalizedRight = padText(
        `${rightPrefix}${rightLine.spansText}`,
        codeLayout.right.width,
      );

      if (side === "left") {
        return normalizedLeft;
      }
      if (side === "right") {
        return `${normalizedRight}${guideOnNewSide ? "│" : ""}`;
      }

      return `${normalizedLeft}${normalizedRight}${guideOnNewSide ? "│" : ""}`;
    });
  }

  if (preparedRow.type !== "stack-line") {
    return [];
  }

  const codeLayout = planCodeRowLayout(row, options) as Extract<
    CodeRowLayoutPlan,
    { kind: "stack" }
  >;
  const guideOnOldSide = codeLayout.noteGuideSide === "old";
  const guideOnNewSide = codeLayout.noteGuideSide === "new";
  const prefix = guideOnOldSide ? "│" : diffRailMarker();
  const cellLines = buildPlainStackCellLines(
    preparedRow.cell,
    codeLayout.cell,
    lineNumberDigits,
    showLineNumbers,
    wrapLines,
    codeHorizontalOffset,
  );

  return cellLines.map((line) => {
    const visibleLine = `${prefix}${line.spansText}`;
    const normalized = padText(visibleLine, Math.max(1, codeLayout.cell.width));
    return `${normalized}${guideOnNewSide ? "│" : ""}`;
  });
}

/**
 * Render only code content for one planned row, excluding gutters, headers, notes, and filenames.
 *
 * Split context rows with equal text are deduplicated because copying both unchanged panes would
 * add noise. Side-filtered projections retain only their requested pane.
 */
export function renderCodeOnlyPlannedRowText(
  row: PlannedReviewRow,
  options: PlannedRowTextOptions,
) {
  const { width, wrapLines, codeHorizontalOffset, side } = options;

  if (width <= 0 || row.kind !== "diff-row") {
    return [];
  }

  const preparedRow = row.row;
  if (preparedRow.type === "hunk-header" || preparedRow.type === "collapsed") {
    return [];
  }

  if (preparedRow.type === "stack-line") {
    if (!wrapLines) {
      return [cellCodeText(preparedRow.cell.spans, codeHorizontalOffset)].filter(Boolean);
    }

    const codeLayout = planCodeRowLayout(row, options) as Extract<
      CodeRowLayoutPlan,
      { kind: "stack" }
    >;
    return wrapSpans(preparedRow.cell.spans, codeLayout.cell.contentWidth)
      .map((spans) => spansText(spans))
      .filter(Boolean);
  }

  if (preparedRow.type !== "split-line") {
    return [];
  }

  if (!wrapLines) {
    const leftText =
      preparedRow.left.kind === "empty"
        ? ""
        : cellCodeText(preparedRow.left.spans, codeHorizontalOffset);
    const rightText =
      preparedRow.right.kind === "empty"
        ? ""
        : cellCodeText(preparedRow.right.spans, codeHorizontalOffset);

    if (side === "left") {
      return [leftText].filter(Boolean);
    }
    if (side === "right") {
      return [rightText].filter(Boolean);
    }

    if (leftText && rightText && leftText === rightText) {
      return [leftText];
    }

    return [leftText, rightText].filter(Boolean);
  }

  const codeLayout = planCodeRowLayout(row, options) as Extract<
    CodeRowLayoutPlan,
    { kind: "split" }
  >;
  const leftLines = wrapSpans(preparedRow.left.spans, codeLayout.left.contentWidth);
  const rightLines = wrapSpans(preparedRow.right.spans, codeLayout.right.contentWidth);
  const visualLineCount = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];

  for (let index = 0; index < visualLineCount; index += 1) {
    const leftText = preparedRow.left.kind === "empty" ? "" : spansText(leftLines[index] ?? []);
    const rightText = preparedRow.right.kind === "empty" ? "" : spansText(rightLines[index] ?? []);

    if (side === "left") {
      if (leftText) {
        lines.push(leftText);
      }
      continue;
    }
    if (side === "right") {
      if (rightText) {
        lines.push(rightText);
      }
      continue;
    }

    if (leftText && rightText && leftText === rightText) {
      lines.push(leftText);
    } else {
      if (leftText) {
        lines.push(leftText);
      }
      if (rightText) {
        lines.push(rightText);
      }
    }
  }

  return lines;
}

/** Review-stream wording for each shared reason a file renders no diff rows. */
export const DIFF_MESSAGES: Record<ReviewEmptyDiffReason, string> = {
  "rename-only": "No textual hunks. This change only renames the file.",
  binary: "Binary file skipped",
  "too-large": "File too large to render automatically.",
  "new-file": "No textual hunks. The file is marked as new.",
  "deleted-file": "No textual hunks. The file is marked as deleted.",
  "no-hunks": "No textual hunks to render for this file.",
};

/** Explain why a file still appears in the review stream even when it has no textual hunks. */
export function diffMessage(file: DiffFile) {
  return DIFF_MESSAGES[
    reviewEmptyDiffReason({
      changeKind: file.metadata.type,
      binary: Boolean(file.isBinary),
      tooLarge: Boolean(file.isTooLarge),
    })
  ];
}
