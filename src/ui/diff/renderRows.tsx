import { memo, type ReactNode } from "react";
import type { DiffFile, UserNoteLineTarget } from "../../core/types";
import type { AppTheme } from "../themes";
import {
  resolveSplitCellGeometry,
  resolveSplitPaneWidths,
  resolveStackCellGeometry,
} from "./codeColumns";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./pierre";
import {
  diffRailMarker,
  dimRailColor,
  neutralRailColor,
  selectionHighlightBg,
  splitCellPalette,
  splitGutterText,
  splitLeftRailColor,
  splitRightRailColor,
  stackCellPalette,
  stackGutterText,
  stackRailColor,
} from "./rowStyle";
import { type PlannedReviewRow } from "./reviewRenderPlan";
import { inlineNoteTitle } from "../components/panes/AgentInlineNote";
import { wrapText } from "../lib/agentPopover";
import type { CopySelectedRowRange } from "../components/panes/copySelection";

/** Clamp a label to one terminal row with an ellipsis. */
export function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width === 1) {
    return "…";
  }

  return `${text.slice(0, width - 1)}…`;
}

/** Slice styled spans to one visible window while preserving color runs. */
function sliceSpansWindow(spans: RenderSpan[], offset: number, width: number) {
  if (width <= 0) {
    return {
      spans: [] as RenderSpan[],
      usedWidth: 0,
    };
  }

  const sliced: RenderSpan[] = [];
  let remainingOffset = Math.max(0, offset);
  let remaining = width;
  let usedWidth = 0;

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    if (remainingOffset >= span.text.length) {
      remainingOffset -= span.text.length;
      continue;
    }

    const start = remainingOffset;
    const text = span.text.slice(start, start + remaining);
    remainingOffset = 0;

    if (text.length === 0) {
      continue;
    }

    const nextSpan = {
      ...span,
      text,
    };

    const previous = sliced.at(-1);
    if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
      previous.text += nextSpan.text;
    } else {
      sliced.push(nextSpan);
    }

    remaining -= text.length;
    usedWidth += text.length;
  }

  return {
    spans: sliced,
    usedWidth,
  };
}

const marker = diffRailMarker;
const addNoteBadgeText = "[+]";

/** Render a fixed-width inline span sequence for one diff cell. */
function renderInlineSpans(
  spans: RenderSpan[],
  width: number,
  fallbackColor: string,
  fallbackBg: string,
  keyPrefix: string,
  horizontalOffset = 0,
  selectionTheme?: AppTheme,
  selectionColRange?: { start: number; end: number },
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(spans, horizontalOffset, width);
  const needsBlending = selectionTheme && selectionColRange;

  // Build the final element list by splitting spans at selection boundaries so the highlight
  // applies at character-level precision rather than whole-token granularity.
  const elements: ReactNode[] = [];
  let colPos = 0;
  let elementIndex = 0;

  for (const span of trimmed) {
    const spanStart = colPos;
    const spanEnd = colPos + span.text.length;
    colPos = spanEnd;

    if (
      !needsBlending ||
      spanEnd <= selectionColRange.start ||
      spanStart >= selectionColRange.end
    ) {
      // Span is entirely outside the selection — render with original styling.
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={span.fg ?? fallbackColor}
          bg={span.bg ?? fallbackBg}
        >
          {span.text}
        </span>,
      );
      continue;
    }

    // Compute the split offsets within this span's text.
    const localSelStart = Math.max(0, selectionColRange.start - spanStart);
    const localSelEnd = Math.min(span.text.length, selectionColRange.end - spanStart);

    if (localSelStart >= localSelEnd) {
      // No overlap after clamping — render original.
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={span.fg ?? fallbackColor}
          bg={span.bg ?? fallbackBg}
        >
          {span.text}
        </span>,
      );
      continue;
    }

    // Split the span at selection boundaries for character-level precision.
    const prefix = span.text.slice(0, localSelStart);
    const selected = span.text.slice(localSelStart, localSelEnd);
    const suffix = span.text.slice(localSelEnd);

    if (prefix) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={span.fg ?? fallbackColor}
          bg={span.bg ?? fallbackBg}
        >
          {prefix}
        </span>,
      );
    }
    if (selected) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={span.fg ?? fallbackColor}
          bg={selectionHighlightBg(span.bg ?? fallbackBg, selectionTheme)}
        >
          {selected}
        </span>,
      );
    }
    if (suffix) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={span.fg ?? fallbackColor}
          bg={span.bg ?? fallbackBg}
        >
          {suffix}
        </span>,
      );
    }
  }

  // Trailing padding after all spans.
  if (needsBlending) {
    // Compute how much of the padding falls within the selection.
    // The padding starts at colPos (which is now sum of all span text lengths =
    // usedWidth after slicing) and extends to `width`.
    const padStart = colPos;
    const padEnd = colPos + Math.max(0, width - usedWidth);
    const paddingAmount = Math.max(0, width - usedWidth);

    if (paddingAmount > 0) {
      if (padStart < selectionColRange.end && padEnd > selectionColRange.start) {
        // Split padding into outside/before, selected, and after.
        const beforeSel = Math.max(0, selectionColRange.start - padStart);
        const inSel =
          Math.min(paddingAmount, selectionColRange.end - padStart) - Math.max(0, beforeSel);
        const afterSel = paddingAmount - beforeSel - Math.max(0, inSel);

        if (beforeSel > 0) {
          elements.push(
            <span key={`${keyPrefix}:pad-before`} fg={fallbackColor} bg={fallbackBg}>
              {" ".repeat(beforeSel)}
            </span>,
          );
        }
        if (inSel > 0) {
          elements.push(
            <span
              key={`${keyPrefix}:pad-sel`}
              fg={fallbackColor}
              bg={selectionHighlightBg(fallbackBg, selectionTheme)}
            >
              {" ".repeat(inSel)}
            </span>,
          );
        }
        if (afterSel > 0) {
          elements.push(
            <span key={`${keyPrefix}:pad-after`} fg={fallbackColor} bg={fallbackBg}>
              {" ".repeat(afterSel)}
            </span>,
          );
        }
      } else {
        elements.push(
          <span key={`${keyPrefix}:pad`} fg={fallbackColor} bg={fallbackBg}>
            {" ".repeat(paddingAmount)}
          </span>,
        );
      }
    }
  } else if (width - usedWidth > 0) {
    // No blending — always render a separate padding span.
    elements.push(
      <span key={`${keyPrefix}:pad`} fg={fallbackColor} bg={fallbackBg}>
        {" ".repeat(width - usedWidth)}
      </span>,
    );
  }

  return <>{elements}</>;
}

interface WrappedCellLine {
  gutterText: string;
  spans: RenderSpan[];
}

interface WrappedCellLayout {
  gutterWidth: number;
  contentWidth: number;
  palette: ReturnType<typeof splitCellPalette> | ReturnType<typeof stackCellPalette>;
  lines: WrappedCellLine[];
}

/** Wrap styled spans into visual lines while preserving color runs across splits. */
function wrapSpans(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return [[]] as RenderSpan[][];
  }

  const lines: RenderSpan[][] = [[]];
  let current = lines[0]!;
  let remaining = width;

  for (const span of spans) {
    let offset = 0;

    while (offset < span.text.length) {
      if (remaining <= 0) {
        current = [];
        lines.push(current);
        remaining = width;
      }

      const text = span.text.slice(offset, offset + remaining);
      if (text.length === 0) {
        break;
      }

      const nextSpan = {
        ...span,
        text,
      };
      const previous = current.at(-1);
      if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
        previous.text += nextSpan.text;
      } else {
        current.push(nextSpan);
      }

      offset += text.length;
      remaining -= text.length;
    }
  }

  return lines;
}

/** Build wrapped split-cell gutter/content lines while keeping continuation gutters blank. */
function buildWrappedSplitCell(
  cell: SplitLineCell,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth: number,
  theme: AppTheme,
) {
  const palette = splitCellPalette(cell.kind, theme);
  const { gutterWidth, contentWidth } = resolveSplitCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );
  const firstGutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    gutterWidth,
  );
  const wrappedSpans = wrapSpans(cell.spans, contentWidth);

  return {
    gutterWidth,
    contentWidth,
    palette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
}

/** Build wrapped stack-cell gutter/content lines while keeping continuation gutters blank. */
function buildWrappedStackCell(
  cell: StackLineCell,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth: number,
  theme: AppTheme,
) {
  const palette = stackCellPalette(cell.kind, theme);
  const { gutterWidth, contentWidth } = resolveStackCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );
  const firstGutterText = stackGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    gutterWidth,
  );
  const wrappedSpans = wrapSpans(cell.spans, contentWidth);

  return {
    gutterWidth,
    contentWidth,
    palette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
}

/** Convert a list of spans to fixed-width plain text while preserving logical clipping. */
function spansToPlainText(spans: RenderSpan[], width: number, horizontalOffset = 0) {
  if (width <= 0) {
    return "";
  }

  const visibleText = spans
    .map((span) => span.text)
    .join("")
    .slice(Math.max(0, horizontalOffset), Math.max(0, horizontalOffset) + width);

  return visibleText.padEnd(Math.max(0, width), " ");
}

/** Flatten styled spans to their visible text content. */
function spansText(spans: RenderSpan[]) {
  return spans.map((span) => span.text).join("");
}

/** Return one cell's code text without rail, gutter, sign, or line-number decorations. */
function cellCodeText(spans: RenderSpan[], horizontalOffset = 0) {
  return spansText(spans).slice(Math.max(0, horizontalOffset));
}

function buildPlainSplitCellLines(
  cell: SplitLineCell,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth: number,
  theme: AppTheme,
  wrapLines: boolean,
  codeHorizontalOffset = 0,
) {
  if (!wrapLines) {
    const { gutterWidth, contentWidth } = resolveSplitCellGeometry(
      width,
      lineNumberDigits,
      showLineNumbers,
      prefixWidth,
    );
    const gutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth);

    return [
      {
        contentWidth,
        gutterWidth,
        spansText: gutterText + spansToPlainText(cell.spans, contentWidth, codeHorizontalOffset),
      },
    ];
  }

  const layout = buildWrappedSplitCell(
    cell,
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
    theme,
  );

  // Mirror the TUI renderer, which does not apply horizontal scrolling to wrapped rows.
  // Keeping the plain-text path aligned avoids visual/clipboard drift.
  return layout.lines.map((line) => ({
    contentWidth: layout.contentWidth,
    gutterWidth: layout.gutterWidth,
    spansText: line.gutterText + spansToPlainText(line.spans, layout.contentWidth),
  }));
}

function buildPlainStackCellLines(
  cell: StackLineCell,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth: number,
  theme: AppTheme,
  wrapLines: boolean,
  codeHorizontalOffset = 0,
) {
  if (!wrapLines) {
    const { gutterWidth, contentWidth } = resolveStackCellGeometry(
      width,
      lineNumberDigits,
      showLineNumbers,
      prefixWidth,
    );
    const gutterText = stackGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth);

    return [
      {
        contentWidth,
        gutterWidth,
        spansText: gutterText + spansToPlainText(cell.spans, contentWidth, codeHorizontalOffset),
      },
    ];
  }

  const layout = buildWrappedStackCell(
    cell,
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
    theme,
  );

  // Mirror the TUI renderer, which does not apply horizontal scrolling to wrapped rows.
  return layout.lines.map((line) => ({
    contentWidth: layout.contentWidth,
    gutterWidth: layout.gutterWidth,
    spansText: line.gutterText + spansToPlainText(line.spans, layout.contentWidth),
  }));
}

/** Render the marker + label that hunk-header and collapsed rows share in plain-text form. */
function renderHeaderRowText(text: string, width: number) {
  const label = fitText(text, Math.max(0, width - 1));
  return marker() + label.padEnd(Math.max(0, width - 1), " ");
}

interface PlannedRowTextOptions {
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  theme: AppTheme;
  // When set, split-line rows produce text only for this side. Stack rows ignore the filter.
  side?: "left" | "right";
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
    theme,
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

  const preparedRow = row.row;

  if (preparedRow.type === "hunk-header") {
    return showHunkHeaders ? [renderHeaderRowText(preparedRow.text, width)] : [];
  }

  if (preparedRow.type === "collapsed") {
    return [renderHeaderRowText(`··· ${preparedRow.text} ···`, width)];
  }

  if (preparedRow.type === "split-line") {
    const guideOnOldSide = row.noteGuideSide === "old";
    const guideOnNewSide = row.noteGuideSide === "new";
    const leftPrefix = guideOnOldSide ? "│" : marker();
    const rightPrefix = "▌";
    const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
    const rightRenderWidth = Math.max(0, rightWidth - (guideOnNewSide ? 1 : 0));

    const leftCell = buildPlainSplitCellLines(
      preparedRow.left,
      leftWidth,
      lineNumberDigits,
      showLineNumbers,
      leftPrefix.length,
      theme,
      wrapLines,
      codeHorizontalOffset,
    );
    const rightCell = buildPlainSplitCellLines(
      preparedRow.right,
      rightRenderWidth,
      lineNumberDigits,
      showLineNumbers,
      rightPrefix.length,
      theme,
      wrapLines,
      codeHorizontalOffset,
    );
    const visualLineCount = Math.max(leftCell.length, rightCell.length);
    const leftGutterWidth = leftCell[0]?.gutterWidth ?? 0;
    const rightGutterWidth = rightCell[0]?.gutterWidth ?? 0;
    const leftPrefixPad = leftPrefix.length;
    const rightPrefixPad = rightPrefix.length;
    const leftContentWidth = resolvePlainContentWidth(leftWidth, leftPrefixPad, leftGutterWidth);
    const rightContentWidth = resolvePlainContentWidth(
      rightRenderWidth,
      rightPrefixPad,
      rightGutterWidth,
    );

    return Array.from({ length: visualLineCount }, (_, index) => {
      const leftLine = leftCell[index] ?? {
        gutterWidth: leftGutterWidth,
        contentWidth: leftContentWidth,
        spansText: " ".repeat(Math.max(0, leftWidth - leftPrefixPad)),
      };
      const rightLine = rightCell[index] ?? {
        gutterWidth: rightGutterWidth,
        contentWidth: rightContentWidth,
        spansText: " ".repeat(Math.max(0, rightRenderWidth - rightPrefixPad)),
      };
      const normalizedLeft = (
        `${leftPrefix}${leftLine.spansText}` +
        " ".repeat(Math.max(0, leftWidth - leftLine.spansText.length))
      ).slice(0, Math.max(0, leftWidth));
      const normalizedRight = (
        `${rightPrefix}${rightLine.spansText}` +
        " ".repeat(Math.max(0, rightRenderWidth - rightLine.spansText.length))
      ).slice(0, Math.max(0, rightRenderWidth));

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

  const guideOnOldSide = row.noteGuideSide === "old";
  const guideOnNewSide = row.noteGuideSide === "new";
  const contentWidth = Math.max(0, width - (guideOnNewSide ? 1 : 0));
  const prefix = guideOnOldSide ? "│" : marker();
  const cellLines = buildPlainStackCellLines(
    preparedRow.cell,
    contentWidth,
    lineNumberDigits,
    showLineNumbers,
    prefix.length,
    theme,
    wrapLines,
    codeHorizontalOffset,
  );

  return cellLines.map((line) => {
    const visibleLine = `${prefix}${line.spansText}`;
    const normalized = visibleLine.padEnd(Math.max(1, contentWidth + prefix.length), " ");
    return `${normalized}${guideOnNewSide ? "│" : ""}`;
  });
}

/**
 * Render only code content for one planned row, excluding gutters, headers, notes, and filenames.
 *
 * Split context rows (left.text === right.text) are deduplicated to a single line because both
 * sides of an unchanged context row carry identical text and shipping it twice in the clipboard
 * would be noise. If the renderer ever distinguishes left/right context via styling that bleeds
 * into the span text itself, this dedupe should be revisited.
 */
export function renderCodeOnlyPlannedRowText(
  row: PlannedReviewRow,
  options: PlannedRowTextOptions,
) {
  const { width, lineNumberDigits, showLineNumbers, wrapLines, codeHorizontalOffset, theme, side } =
    options;

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

    return buildWrappedStackCell(
      preparedRow.cell,
      width,
      lineNumberDigits,
      showLineNumbers,
      marker().length,
      theme,
    )
      .lines.map((line) => spansText(line.spans))
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

  const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
  const leftLayout = buildWrappedSplitCell(
    preparedRow.left,
    leftWidth,
    lineNumberDigits,
    showLineNumbers,
    marker().length,
    theme,
  );
  const rightLayout = buildWrappedSplitCell(
    preparedRow.right,
    rightWidth,
    lineNumberDigits,
    showLineNumbers,
    1,
    theme,
  );
  const visualLineCount = Math.max(leftLayout.lines.length, rightLayout.lines.length);
  const lines: string[] = [];

  for (let index = 0; index < visualLineCount; index += 1) {
    const leftText =
      preparedRow.left.kind === "empty" ? "" : spansText(leftLayout.lines[index]?.spans ?? []);
    const rightText =
      preparedRow.right.kind === "empty" ? "" : spansText(rightLayout.lines[index]?.spans ?? []);

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

/** Resolve the code content width after fixed rail and gutter columns. */
function resolvePlainContentWidth(totalWidth: number, prefixWidth: number, gutterWidth: number) {
  return Math.max(0, totalWidth - prefixWidth - gutterWidth);
}

/**
 * Apply the selection-highlight blend to a cell palette's gutter bg only.
 *
 * The content bg is intentionally left untouched here so renderInlineSpans can apply the same
 * blend uniformly across every rendered span (including syntax-emphasis spans that supply their
 * own bg). Pre-blending contentBg would cause the fallback path to double-blend.
 */
function applySelectionPalette<P extends { gutterBg: string; contentBg: string }>(
  palette: P,
  theme: AppTheme,
): P {
  return {
    ...palette,
    gutterBg: selectionHighlightBg(palette.gutterBg, theme),
  };
}

/** Apply the selection-highlight blend to a prefix descriptor. */
function applySelectionPrefix<P extends { bg: string }>(prefix: P, theme: AppTheme): P {
  return {
    ...prefix,
    bg: selectionHighlightBg(prefix.bg, theme),
  };
}

/** Render one split-view cell as prefix + gutter + content spans. */
function renderSplitCell(
  cell: SplitLineCell,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  theme: AppTheme,
  keyPrefix: string,
  contentOffset = 0,
  prefix?: {
    text: string;
    fg: string;
    bg: string;
  },
  selected = false,
  selectionColRange?: CopySelectedRowRange,
  paneOffset = 0,
) {
  const basePalette = splitCellPalette(cell.kind, theme);
  const palette = selected ? applySelectionPalette(basePalette, theme) : basePalette;
  const resolvedPrefix = selected && prefix ? applySelectionPrefix(prefix, theme) : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;
  const { gutterWidth, contentWidth } = resolveSplitCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );
  const gutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth);

  // Convert global selection column range to content-local range.
  const globalContentStart = paneOffset + prefixWidth + gutterWidth;
  const localColRange =
    selectionColRange && globalContentStart < selectionColRange.endCol
      ? {
          start: Math.max(0, selectionColRange.startCol - globalContentStart),
          end: Math.min(
            contentWidth,
            Math.max(0, selectionColRange.endCol - globalContentStart + 1),
          ),
        }
      : undefined;

  return (
    <>
      {resolvedPrefix ? (
        <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
          {resolvedPrefix.text}
        </span>
      ) : null}
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {gutterText}
      </span>
      {renderInlineSpans(
        cell.spans,
        contentWidth,
        theme.text,
        palette.contentBg,
        `${keyPrefix}:content`,
        contentOffset,
        selected ? theme : undefined,
        localColRange,
      )}
    </>
  );
}

/** Render one stack-view cell as prefix + combined gutter + content spans. */
function renderStackCell(
  cell: StackLineCell,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  theme: AppTheme,
  keyPrefix: string,
  contentOffset = 0,
  prefix?: {
    text: string;
    fg: string;
    bg: string;
  },
  selected = false,
  selectionColRange?: CopySelectedRowRange,
) {
  const basePalette = stackCellPalette(cell.kind, theme);
  const palette = selected ? applySelectionPalette(basePalette, theme) : basePalette;
  const resolvedPrefix = selected && prefix ? applySelectionPrefix(prefix, theme) : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;
  const { gutterWidth, contentWidth } = resolveStackCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );

  // Convert global selection column range to content-local range.
  const globalContentStart = prefixWidth + gutterWidth;
  const localColRange =
    selectionColRange && globalContentStart < selectionColRange.endCol
      ? {
          start: Math.max(0, selectionColRange.startCol - globalContentStart),
          end: Math.min(
            contentWidth,
            Math.max(0, selectionColRange.endCol - globalContentStart + 1),
          ),
        }
      : undefined;

  return (
    <>
      {resolvedPrefix ? (
        <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
          {resolvedPrefix.text}
        </span>
      ) : null}
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {stackGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth)}
      </span>
      {renderInlineSpans(
        cell.spans,
        contentWidth,
        theme.text,
        palette.contentBg,
        `${keyPrefix}:content`,
        contentOffset,
        selected ? theme : undefined,
        localColRange,
      )}
    </>
  );
}

/** Render one already-wrapped split cell line with its persistent rail/separator prefix. */
function renderWrappedSplitCellLine(
  line: WrappedCellLine,
  palette: ReturnType<typeof splitCellPalette>,
  contentWidth: number,
  theme: AppTheme,
  keyPrefix: string,
  prefix: {
    text: string;
    fg: string;
    bg: string;
  },
  selected = false,
  selectionColRange?: CopySelectedRowRange,
  paneOffset = 0,
) {
  const resolvedPalette = selected ? applySelectionPalette(palette, theme) : palette;
  const resolvedPrefix = selected ? applySelectionPrefix(prefix, theme) : prefix;

  const prefixWidth = prefix.text.length;
  const gutterWidth = line.gutterText.length;
  const globalContentStart = paneOffset + prefixWidth + gutterWidth;
  const localColRange =
    selectionColRange && globalContentStart < selectionColRange.endCol
      ? {
          start: Math.max(0, selectionColRange.startCol - globalContentStart),
          end: Math.min(
            contentWidth,
            Math.max(0, selectionColRange.endCol - globalContentStart + 1),
          ),
        }
      : undefined;

  return (
    <>
      <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
        {resolvedPrefix.text}
      </span>
      <span
        key={`${keyPrefix}:gutter`}
        fg={resolvedPalette.numberColor}
        bg={resolvedPalette.gutterBg}
      >
        {line.gutterText}
      </span>
      {renderInlineSpans(
        line.spans,
        contentWidth,
        theme.text,
        resolvedPalette.contentBg,
        `${keyPrefix}:content`,
        0,
        selected ? theme : undefined,
        localColRange,
      )}
    </>
  );
}

/** Render one already-wrapped stack cell line with its persistent rail prefix. */
function renderWrappedStackCellLine(
  line: WrappedCellLine,
  palette: ReturnType<typeof stackCellPalette>,
  contentWidth: number,
  theme: AppTheme,
  keyPrefix: string,
  prefix: {
    text: string;
    fg: string;
    bg: string;
  },
  selected = false,
  selectionColRange?: CopySelectedRowRange,
) {
  const resolvedPalette = selected ? applySelectionPalette(palette, theme) : palette;
  const resolvedPrefix = selected ? applySelectionPrefix(prefix, theme) : prefix;

  const prefixWidth = prefix.text.length;
  const gutterWidth = line.gutterText.length;
  const globalContentStart = prefixWidth + gutterWidth;
  const localColRange =
    selectionColRange && globalContentStart < selectionColRange.endCol
      ? {
          start: Math.max(0, selectionColRange.startCol - globalContentStart),
          end: Math.min(
            contentWidth,
            Math.max(0, selectionColRange.endCol - globalContentStart + 1),
          ),
        }
      : undefined;

  return (
    <>
      <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
        {resolvedPrefix.text}
      </span>
      <span
        key={`${keyPrefix}:gutter`}
        fg={resolvedPalette.numberColor}
        bg={resolvedPalette.gutterBg}
      >
        {line.gutterText}
      </span>
      {renderInlineSpans(
        line.spans,
        contentWidth,
        theme.text,
        resolvedPalette.contentBg,
        `${keyPrefix}:content`,
        0,
        selected ? theme : undefined,
        localColRange,
      )}
    </>
  );
}

/** Explain why a file still appears in the review stream even when it has no textual hunks. */
export function diffMessage(file: DiffFile) {
  if (file.metadata.type === "rename-pure") {
    return "No textual hunks. This change only renames the file.";
  }

  if (file.isBinary) {
    return "Binary file skipped";
  }

  if (file.isTooLarge) {
    return "File too large to render automatically.";
  }

  if (file.metadata.type === "new") {
    return "No textual hunks. The file is marked as new.";
  }

  if (file.metadata.type === "deleted") {
    return "No textual hunks. The file is marked as deleted.";
  }

  return "No textual hunks to render for this file.";
}

/** Render collapsed and hunk-header rows, including the optional add-note target. */
function renderHeaderRow(
  row: Extract<DiffRow, { type: "collapsed" | "hunk-header" }>,
  width: number,
  theme: AppTheme,
  selected: boolean,
  anchorId?: string,
  showAddNoteBadge = false,
  onHoverRow?: (rowKey: string) => void,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
) {
  const badges = [
    showAddNoteBadge
      ? {
          key: "user-note",
          text: "[+]",
          onClick: () => onStartUserNoteAtHunk?.(row.hunkIndex),
        }
      : null,
  ].filter((badge): badge is { key: string; text: string; onClick: () => void } => Boolean(badge));
  const badgeWidth = badges.reduce((total, badge) => total + badge.text.length + 1, 0);
  const label =
    row.type === "collapsed"
      ? fitText(`··· ${row.text} ···`, Math.max(0, width - 1 - badgeWidth))
      : fitText(row.text, Math.max(0, width - 1 - badgeWidth));

  if (badges.length === 0) {
    return (
      <box
        key={row.key}
        id={anchorId}
        style={{
          width: "100%",
          height: 1,
          backgroundColor: theme.panelAlt,
        }}
        onMouseMove={() => onHoverRow?.(row.key)}
      >
        <text>
          <span
            fg={selected ? neutralRailColor(theme) : dimRailColor(neutralRailColor(theme), theme)}
            bg={theme.panelAlt}
          >
            {marker()}
          </span>
          <span
            fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral}
            bg={theme.panelAlt}
          >
            {label}
          </span>
        </text>
      </box>
    );
  }

  return (
    <box
      key={row.key}
      id={anchorId}
      style={{
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: theme.panelAlt,
      }}
      onMouseMove={() => onHoverRow?.(row.key)}
    >
      <box style={{ width: Math.max(0, width - badgeWidth), height: 1 }}>
        <text>
          <span
            fg={selected ? neutralRailColor(theme) : dimRailColor(neutralRailColor(theme), theme)}
            bg={theme.panelAlt}
          >
            {marker()}
          </span>
          <span
            fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral}
            bg={theme.panelAlt}
          >
            {label}
          </span>
        </text>
      </box>
      {badges.map((badge) => (
        <box
          key={badge.key}
          style={{ width: badge.text.length + 1, height: 1 }}
          onMouseUp={badge.onClick}
        >
          <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>{` ${badge.text}`}</text>
        </box>
      ))}
    </box>
  );
}

/** Render the hover-only add-note target as a separate clickable hit area. */
function renderAddNoteButton(
  key: string,
  theme: AppTheme,
  hunkIndex: number,
  target: UserNoteLineTarget | undefined,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
) {
  return (
    <box
      key={key}
      style={{ width: addNoteBadgeText.length, height: 1 }}
      onMouseUp={() => onStartUserNoteAtHunk?.(hunkIndex, target)}
    >
      <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>
        {addNoteBadgeText}
      </text>
    </box>
  );
}

/** Measure how many terminal rows one rendered diff row occupies. */
export function measureRenderedRowHeight(
  row: DiffRow,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  showHunkHeaders: boolean,
  wrapLines: boolean,
  theme: AppTheme,
) {
  if (row.type === "hunk-header") {
    return showHunkHeaders ? 1 : 0;
  }

  if (row.type === "collapsed") {
    return 1;
  }

  if (row.type === "split-line") {
    if (!wrapLines) {
      return 1;
    }

    const markerWidth = 1;
    const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
    const leftLayout = buildWrappedSplitCell(
      row.left,
      leftWidth,
      lineNumberDigits,
      showLineNumbers,
      markerWidth,
      theme,
    );
    const rightLayout = buildWrappedSplitCell(
      row.right,
      rightWidth,
      lineNumberDigits,
      showLineNumbers,
      markerWidth,
      theme,
    );

    return Math.max(leftLayout.lines.length, rightLayout.lines.length);
  }

  if (row.type !== "stack-line") {
    return 1;
  }

  if (!wrapLines) {
    return 1;
  }

  const layout = buildWrappedStackCell(
    row.cell,
    width,
    lineNumberDigits,
    showLineNumbers,
    marker().length,
    theme,
  );
  return layout.lines.length;
}

/** Render one diff row. */
function renderRow(
  row: DiffRow,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  showHunkHeaders: boolean,
  wrapLines: boolean,
  codeHorizontalOffset: number,
  theme: AppTheme,
  selected: boolean,
  copySelectedRowRange: CopySelectedRowRange | undefined,
  copySelectedSide: "left" | "right" | undefined,
  anchorId?: string,
  noteGuideSide?: "old" | "new",
  showAddNoteBadge = false,
  onHoverRow?: (rowKey: string) => void,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
) {
  const hasCopySelection = !!copySelectedRowRange;

  // For split rows, the user's drag is anchored to one column-half of the diff. Apply the
  // selection-highlight blend only to that side so it is clear which file (A or B) the
  // selection represents.
  const hasLeftSelection = hasCopySelection && copySelectedSide !== "right";
  const hasRightSelection = hasCopySelection && copySelectedSide !== "left";
  let baseRow: ReactNode;

  if (row.type === "collapsed") {
    baseRow = renderHeaderRow(
      row,
      width,
      theme,
      selected || hasCopySelection,
      anchorId,
      showAddNoteBadge,
      onHoverRow,
      onStartUserNoteAtHunk,
    );
  } else if (row.type === "hunk-header") {
    baseRow = showHunkHeaders
      ? renderHeaderRow(
          row,
          width,
          theme,
          selected || hasCopySelection,
          anchorId,
          showAddNoteBadge,
          onHoverRow,
          onStartUserNoteAtHunk,
        )
      : null;
  } else if (row.type === "split-line") {
    const guideOnOldSide = noteGuideSide === "old";
    const guideOnNewSide = noteGuideSide === "new";
    const addNoteTarget: UserNoteLineTarget | undefined =
      row.right.lineNumber !== undefined
        ? { side: "new", line: row.right.lineNumber }
        : row.left.lineNumber !== undefined
          ? { side: "old", line: row.left.lineNumber }
          : undefined;

    // Reserve fixed columns for the diff rails, center separator slot, and hover affordance.
    const addBadgeWidth = showAddNoteBadge ? addNoteBadgeText.length : 0;
    const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
    const rightRenderWidth = Math.max(0, rightWidth - (guideOnNewSide ? 1 : 0) - addBadgeWidth);
    const leftPrefix = {
      text: guideOnOldSide ? "│" : marker(),
      fg: guideOnOldSide
        ? theme.noteBorder
        : splitLeftRailColor(row.left.kind, theme, selected || hasCopySelection),
      bg: theme.panel,
    };
    const rightPrefix = {
      text: "▌",
      fg: splitRightRailColor(row.right.kind, theme, selected || hasCopySelection),
      bg: theme.panel,
    };

    if (!wrapLines) {
      baseRow = (
        <box
          id={anchorId}
          style={{ width: "100%", height: 1, flexDirection: "row" }}
          onMouseMove={() => onHoverRow?.(row.key)}
        >
          <box
            style={{
              width: showAddNoteBadge ? Math.max(0, width - addBadgeWidth) : "100%",
              height: 1,
            }}
          >
            <text>
              {renderSplitCell(
                row.left,
                leftWidth,
                lineNumberDigits,
                showLineNumbers,
                theme,
                `${row.key}:left`,
                codeHorizontalOffset,
                leftPrefix,
                hasLeftSelection,
                hasLeftSelection ? copySelectedRowRange : undefined,
                0,
              )}
              {renderSplitCell(
                row.right,
                rightRenderWidth,
                lineNumberDigits,
                showLineNumbers,
                theme,
                `${row.key}:right`,
                codeHorizontalOffset,
                rightPrefix,
                hasRightSelection,
                hasRightSelection ? copySelectedRowRange : undefined,
                leftWidth,
              )}
              {guideOnNewSide ? (
                <span key={`${row.key}:note-guide`} fg={theme.noteBorder}>
                  │
                </span>
              ) : null}
            </text>
          </box>
          {showAddNoteBadge
            ? renderAddNoteButton(
                `${row.key}:add-note`,
                theme,
                row.hunkIndex,
                addNoteTarget,
                onStartUserNoteAtHunk,
              )
            : null}
        </box>
      );
    } else {
      const leftLayout = buildWrappedSplitCell(
        row.left,
        leftWidth,
        lineNumberDigits,
        showLineNumbers,
        leftPrefix.text.length,
        theme,
      );
      const rightLayout = buildWrappedSplitCell(
        row.right,
        rightRenderWidth,
        lineNumberDigits,
        showLineNumbers,
        rightPrefix.text.length,
        theme,
      );
      const leftContentWidth = Math.max(
        0,
        leftWidth - leftPrefix.text.length - leftLayout.gutterWidth,
      );
      const rightContentWidth = Math.max(
        0,
        rightRenderWidth - rightPrefix.text.length - rightLayout.gutterWidth,
      );
      const visualLineCount = Math.max(leftLayout.lines.length, rightLayout.lines.length);

      baseRow = (
        <box id={anchorId} style={{ width: "100%", flexDirection: "column" }}>
          {Array.from({ length: visualLineCount }, (_, index) => {
            const leftLine = leftLayout.lines[index] ?? {
              gutterText: " ".repeat(leftLayout.gutterWidth),
              spans: [],
            };
            const rightLine = rightLayout.lines[index] ?? {
              gutterText: " ".repeat(rightLayout.gutterWidth),
              spans: [],
            };

            const showBadgeOnLine = showAddNoteBadge && index === 0;

            return (
              <box
                key={`${row.key}:wrap:${index}`}
                style={{ width: "100%", height: 1, flexDirection: "row" }}
                onMouseMove={() => onHoverRow?.(row.key)}
              >
                <box
                  style={{
                    width: showBadgeOnLine ? Math.max(0, width - addBadgeWidth) : "100%",
                    height: 1,
                  }}
                >
                  <text>
                    {renderWrappedSplitCellLine(
                      leftLine,
                      leftLayout.palette,
                      leftContentWidth,
                      theme,
                      `${row.key}:left:${index}`,
                      leftPrefix,
                      hasLeftSelection,
                      hasLeftSelection ? copySelectedRowRange : undefined,
                      0,
                    )}
                    {renderWrappedSplitCellLine(
                      rightLine,
                      rightLayout.palette,
                      rightContentWidth,
                      theme,
                      `${row.key}:right:${index}`,
                      rightPrefix,
                      hasRightSelection,
                      hasRightSelection ? copySelectedRowRange : undefined,
                      leftWidth,
                    )}
                    {guideOnNewSide ? (
                      <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
                        │
                      </span>
                    ) : null}
                  </text>
                </box>
                {showBadgeOnLine
                  ? renderAddNoteButton(
                      `${row.key}:add-note:${index}`,
                      theme,
                      row.hunkIndex,
                      addNoteTarget,
                      onStartUserNoteAtHunk,
                    )
                  : null}
              </box>
            );
          })}
        </box>
      );
    }
  } else if (row.type === "stack-line") {
    const guideOnOldSide = noteGuideSide === "old";
    const guideOnNewSide = noteGuideSide === "new";
    const addNoteTarget: UserNoteLineTarget | undefined =
      row.cell.newLineNumber !== undefined
        ? { side: "new", line: row.cell.newLineNumber }
        : row.cell.oldLineNumber !== undefined
          ? { side: "old", line: row.cell.oldLineNumber }
          : undefined;
    const addBadgeWidth = showAddNoteBadge ? addNoteBadgeText.length : 0;
    const contentWidth = Math.max(0, width - (guideOnNewSide ? 1 : 0) - addBadgeWidth);
    const prefix = {
      text: guideOnOldSide ? "│" : marker(),
      fg: guideOnOldSide
        ? theme.noteBorder
        : stackRailColor(row.cell.kind, theme, selected || hasCopySelection),
      bg: theme.panel,
    };

    if (!wrapLines) {
      baseRow = (
        <box
          id={anchorId}
          style={{ width: "100%", height: 1, flexDirection: "row" }}
          onMouseMove={() => onHoverRow?.(row.key)}
        >
          <box
            style={{
              width: showAddNoteBadge ? Math.max(0, width - addBadgeWidth) : "100%",
              height: 1,
            }}
          >
            <text>
              {renderStackCell(
                row.cell,
                contentWidth,
                lineNumberDigits,
                showLineNumbers,
                theme,
                `${row.key}:stack`,
                codeHorizontalOffset,
                prefix,
                hasCopySelection,
                hasCopySelection ? copySelectedRowRange : undefined,
              )}
              {guideOnNewSide ? (
                <span key={`${row.key}:note-guide`} fg={theme.noteBorder}>
                  │
                </span>
              ) : null}
            </text>
          </box>
          {showAddNoteBadge
            ? renderAddNoteButton(
                `${row.key}:add-note`,
                theme,
                row.hunkIndex,
                addNoteTarget,
                onStartUserNoteAtHunk,
              )
            : null}
        </box>
      );
    } else {
      const layout = buildWrappedStackCell(
        row.cell,
        contentWidth,
        lineNumberDigits,
        showLineNumbers,
        prefix.text.length,
        theme,
      );
      const wrappedContentWidth = Math.max(
        0,
        contentWidth - prefix.text.length - layout.gutterWidth,
      );

      baseRow = (
        <box id={anchorId} style={{ width: "100%", flexDirection: "column" }}>
          {layout.lines.map((line, index) => {
            const showBadgeOnLine = showAddNoteBadge && index === 0;

            return (
              <box
                key={`${row.key}:wrap:${index}`}
                style={{ width: "100%", height: 1, flexDirection: "row" }}
                onMouseMove={() => onHoverRow?.(row.key)}
              >
                <box
                  style={{
                    width: showBadgeOnLine ? Math.max(0, width - addBadgeWidth) : "100%",
                    height: 1,
                  }}
                >
                  <text>
                    {renderWrappedStackCellLine(
                      line,
                      layout.palette,
                      wrappedContentWidth,
                      theme,
                      `${row.key}:stack:${index}`,
                      prefix,
                      hasCopySelection,
                      hasCopySelection ? copySelectedRowRange : undefined,
                    )}
                    {guideOnNewSide ? (
                      <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
                        │
                      </span>
                    ) : null}
                  </text>
                </box>
                {showBadgeOnLine
                  ? renderAddNoteButton(
                      `${row.key}:add-note:${index}`,
                      theme,
                      row.hunkIndex,
                      addNoteTarget,
                      onStartUserNoteAtHunk,
                    )
                  : null}
              </box>
            );
          })}
        </box>
      );
    }
  } else {
    baseRow = (
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>Unsupported row.</text>
      </box>
    );
  }

  return baseRow;
}

interface DiffRowViewProps {
  row: DiffRow;
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  theme: AppTheme;
  selected: boolean;
  copySelectedRowRange?: CopySelectedRowRange;
  copySelectedSide?: "left" | "right";
  anchorId?: string;
  noteGuideSide?: "old" | "new";
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
}

/** Render one diff row, memoized to avoid unnecessary rerenders. */
export const DiffRowView = memo(
  function DiffRowViewComponent({
    row,
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    codeHorizontalOffset,
    theme,
    selected,
    copySelectedRowRange,
    copySelectedSide,
    anchorId,
    noteGuideSide,
    showAddNoteBadge,
    onHoverRow,
    onStartUserNoteAtHunk,
  }: DiffRowViewProps) {
    return renderRow(
      row,
      width,
      lineNumberDigits,
      showLineNumbers,
      showHunkHeaders,
      wrapLines,
      codeHorizontalOffset,
      theme,
      selected,
      copySelectedRowRange,
      copySelectedSide,
      anchorId,
      noteGuideSide,
      showAddNoteBadge,
      onHoverRow,
      onStartUserNoteAtHunk,
    );
  },
  (previous, next) => {
    return (
      previous.row === next.row &&
      previous.width === next.width &&
      previous.lineNumberDigits === next.lineNumberDigits &&
      previous.showLineNumbers === next.showLineNumbers &&
      previous.showHunkHeaders === next.showHunkHeaders &&
      previous.wrapLines === next.wrapLines &&
      previous.codeHorizontalOffset === next.codeHorizontalOffset &&
      previous.theme === next.theme &&
      previous.selected === next.selected &&
      previous.copySelectedRowRange === next.copySelectedRowRange &&
      previous.copySelectedSide === next.copySelectedSide &&
      previous.anchorId === next.anchorId &&
      previous.noteGuideSide === next.noteGuideSide &&
      previous.showAddNoteBadge === next.showAddNoteBadge &&
      previous.onHoverRow === next.onHoverRow &&
      previous.onStartUserNoteAtHunk === next.onStartUserNoteAtHunk
    );
  },
);
