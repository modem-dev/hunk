import { Fragment, isValidElement, memo, type ReactNode } from "react";
import { parseColor, StyledText, type TextChunk } from "@opentui/core";
import type { DiffFile } from "../../core/changeset/model";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { AppTheme } from "../themes";
import {
  resolveSplitCellGeometry,
  resolveSplitPaneWidths,
  resolveStackCellGeometry,
} from "./codeColumns";
import { reviewEmptyDiffReason, type ReviewEmptyDiffReason } from "../../core/review/document";
import { reviewGapId } from "../../core/review/expansion";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./diffRows";
import {
  applyLineHighlightsToSpans,
  lineHighlightPaintKey,
  type LineHighlightPaintIndex,
} from "./lineHighlightPaint";
import {
  diffRailMarker,
  dimRailColor,
  neutralRailColor,
  cursorLineHighlightBg,
  lineHighlightToneStyle,
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
import { wrapText } from "../lib/text";
import { sanitizeTerminalLine, sanitizeTerminalSpans } from "../../lib/terminalText";
import {
  isPrintableAsciiText,
  measureSanitizedTextWidth,
  measureSimpleSanitizedTextWidth,
  measureTextWidth,
  padText as padTextByWidth,
  sliceSanitizedTextByWidth,
  sliceTextByWidth,
  textClusters,
  wrapSanitizedTextByWidth,
} from "../lib/text";
import type { CopySelectedRowRange } from "../lib/diffSpatial";
import type { CursorLine } from "../../core/run/commandInputs";

export interface CursorHighlight {
  /** The render plan anchor of the row the cursor rests on, shared with reveal lookups. */
  stableKey: string;
  style: Exclude<CursorLine, "off">;
  /** Which half of a split row the cursor sits on, and where a note would anchor. */
  side: "old" | "new";
}

/** Report whether one planned row carries the anchor the cursor rests on. */
export function plannedRowMatchesCursor(
  row: { stableKey: string; stableAliasKeys?: readonly string[] },
  cursor: CursorHighlight | undefined,
) {
  return (
    cursor !== undefined &&
    (row.stableKey === cursor.stableKey || row.stableAliasKeys?.includes(cursor.stableKey) === true)
  );
}

interface RowHighlight {
  bg: (baseBg: string) => string;
  /** Global columns to blend; absent blends the gutter alone. */
  colRange?: CopySelectedRowRange;
}

/** Column span covering a row's whole content column, in the global columns selection uses. */
const FULL_ROW_COL_RANGE: CopySelectedRowRange = { startCol: 0, endCol: Number.MAX_SAFE_INTEGER };

/** Clamp a label to one terminal row with an ellipsis. */
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

/** Append a styled span while preserving color-run coalescing. */
function appendRenderSpan(target: RenderSpan[], span: RenderSpan) {
  const previous = target.at(-1);
  if (previous && previous.fg === span.fg && previous.bg === span.bg) {
    previous.text += span.text;
  } else {
    target.push(span);
  }
}

/** Return the first or last scalar in one non-empty string. */
function boundaryScalar(text: string, first: boolean) {
  if (first) {
    const codePoint = text.codePointAt(0);
    return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
  }

  let scalar = "";
  for (const candidate of text) {
    scalar = candidate;
  }
  return scalar;
}

/** Return whether a styled-span boundary may divide one grapheme cluster. */
function spansMaySplitGrapheme(spans: RenderSpan[]) {
  for (let index = 1; index < spans.length; index += 1) {
    const left = boundaryScalar(spans[index - 1]?.text ?? "", false);
    const right = boundaryScalar(spans[index]?.text ?? "", true);
    if (
      (left && measureSimpleSanitizedTextWidth(left) === null) ||
      (right && measureSimpleSanitizedTextWidth(right) === null)
    ) {
      return true;
    }
  }
  return false;
}

/** Merge indivisible graphemes while preserving the style where each cluster starts. */
function mergeCrossSpanGraphemes(spans: RenderSpan[]) {
  const normalized: RenderSpan[] = [];
  const text = spans.map((span) => span.text).join("");
  let sourceIndex = 0;
  let sourceEnd = spans[0]?.text.length ?? 0;
  let cursor = 0;

  for (const cluster of textClusters(text)) {
    while (cursor >= sourceEnd && sourceIndex < spans.length - 1) {
      sourceIndex += 1;
      sourceEnd += spans[sourceIndex]?.text.length ?? 0;
    }
    const source = spans[sourceIndex];
    if (source) {
      appendRenderSpan(normalized, { ...source, text: cluster });
    }
    cursor += cluster.length;
  }
  return normalized;
}

/** Merge only indivisible graphemes that may cross styled-span boundaries. */
function preserveCrossSpanGraphemes(spans: RenderSpan[]) {
  return spansMaySplitGrapheme(spans) ? mergeCrossSpanGraphemes(spans) : spans;
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

    const spanWidth = measureSanitizedTextWidth(span.text);
    if (spanWidth === 0) {
      appendRenderSpan(sliced, { ...span });
      continue;
    }

    if (remainingOffset >= spanWidth) {
      remainingOffset -= spanWidth;
      continue;
    }

    if (remainingOffset === 0 && spanWidth <= remaining) {
      // Preserve the full safe span without re-slicing its graphemes. Clone before coalescing so
      // appendRenderSpan can never mutate the caller-owned highlighted span object.
      appendRenderSpan(sliced, { ...span });
      remaining -= spanWidth;
      usedWidth += spanWidth;
      continue;
    }

    const visible = sliceSanitizedTextByWidth(span.text, remainingOffset, remaining);
    remainingOffset = 0;

    if (visible.text.length === 0) {
      continue;
    }

    const nextSpan = {
      ...span,
      text: visible.text,
    };

    appendRenderSpan(sliced, nextSpan);

    remaining -= visible.width;
    usedWidth += visible.width;
  }

  return {
    spans: sliced,
    usedWidth,
  };
}

const marker = diffRailMarker;
const addNoteBadgeText = "[+]";
const styledTextColorCache = new Map<string, ReturnType<typeof parseColor>>();
const addNoteSpacerContentCache = new Map<string, StyledText>();

/** Resolve one OpenTUI color while reusing immutable parsed theme values. */
function styledTextColor(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  let parsed = styledTextColorCache.get(value);
  if (!parsed) {
    parsed = parseColor(value);
    styledTextColorCache.set(value, parsed);
  }
  return parsed;
}

/** Convert a React span fragment into OpenTUI's direct styled-text run list. */
function styledTextFromSpanNodes(nodes: ReactNode[]) {
  const chunks: TextChunk[] = [];
  const collect = (node: ReactNode, fg?: string, bg?: string) => {
    if (node === null || node === undefined || typeof node === "boolean") {
      return;
    }
    if (typeof node === "string" || typeof node === "number") {
      chunks.push({
        __isChunk: true,
        text: String(node),
        fg: styledTextColor(fg),
        bg: styledTextColor(bg),
      });
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        collect(child, fg, bg);
      }
      return;
    }
    if (!isValidElement<{ children?: ReactNode; fg?: string; bg?: string }>(node)) {
      return;
    }
    if (node.type === Fragment) {
      collect(node.props.children, fg, bg);
      return;
    }
    if (node.type === "span") {
      collect(node.props.children, node.props.fg ?? fg, node.props.bg ?? bg);
    }
  };

  collect(nodes);
  return new StyledText(chunks);
}

/** Append a fixed-width inline span plan directly to StyledText chunks. */
function appendFixedInlineChunks(
  chunks: TextChunk[],
  spans: RenderSpan[],
  width: number,
  fallbackColor: string,
  fallbackBg: string,
  highlightBg?: (baseBg: string) => string,
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(spans, 0, width);
  const renderedBackground = (background: string) =>
    highlightBg ? highlightBg(background) : background;
  const paddingAmount = Math.max(0, width - usedWidth);
  const lastSpan = trimmed.at(-1);
  let paddingMerged = false;
  if (
    paddingAmount > 0 &&
    lastSpan &&
    (lastSpan.fg ?? fallbackColor) === fallbackColor &&
    (lastSpan.bg ?? fallbackBg) === fallbackBg
  ) {
    lastSpan.text += " ".repeat(paddingAmount);
    paddingMerged = true;
  }

  for (const span of trimmed) {
    chunks.push({
      __isChunk: true,
      text: span.text,
      fg: styledTextColor(span.fg ?? fallbackColor),
      bg: styledTextColor(renderedBackground(span.bg ?? fallbackBg)),
    });
  }
  if (!paddingMerged && paddingAmount > 0) {
    chunks.push({
      __isChunk: true,
      text: " ".repeat(paddingAmount),
      fg: styledTextColor(fallbackColor),
      bg: styledTextColor(renderedBackground(fallbackBg)),
    });
  }
}

/** Report whether a wrapped highlight can paint existing chunks without slicing token spans. */
function isChunkCompatibleWrappedHighlight(highlight: RowHighlight | undefined) {
  return !highlight?.colRange || highlight.colRange === FULL_ROW_COL_RANGE;
}

/** Append one wrapped cell without constructing intermediate React span elements. */
function appendWrappedCellChunks(
  chunks: TextChunk[],
  line: WrappedCellLine,
  palette: { numberColor: string; gutterBg: string; contentBg: string },
  contentWidth: number,
  theme: AppTheme,
  prefix: { text: string; fg: string; bg: string },
  highlight?: RowHighlight,
) {
  const renderedBackground = (background: string) =>
    highlight ? highlight.bg(background) : background;
  const contentHighlightBg = highlight?.colRange === FULL_ROW_COL_RANGE ? highlight.bg : undefined;
  chunks.push(
    {
      __isChunk: true,
      text: prefix.text,
      fg: styledTextColor(prefix.fg),
      bg: styledTextColor(renderedBackground(prefix.bg)),
    },
    {
      __isChunk: true,
      text: line.gutterText,
      fg: styledTextColor(palette.numberColor),
      bg: styledTextColor(renderedBackground(palette.gutterBg)),
    },
  );
  appendFixedInlineChunks(
    chunks,
    line.spans,
    contentWidth,
    theme.syntaxColors.default,
    palette.contentBg,
    contentHighlightBg,
  );
}

/** Reserve the hover affordance column in wrapped rows so hover cannot reflow code. */
function wrappedAddNoteReserveWidth(wrapLines: boolean, reserveAddNoteColumn = false) {
  return wrapLines && reserveAddNoteColumn ? addNoteBadgeText.length : 0;
}

/** Render a fixed-width inline span sequence for one diff cell. */
function renderInlineSpans(
  spans: RenderSpan[],
  width: number,
  fallbackColor: string,
  fallbackBg: string,
  keyPrefix: string,
  horizontalOffset = 0,
  highlightBg?: (baseBg: string) => string,
  selectionColRange?: { start: number; end: number },
  spansAreSanitized = false,
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(
    spansAreSanitized ? spans : sanitizeTerminalSpans(spans),
    horizontalOffset,
    width,
  );
  // A whole-row cursor covers this complete rendered window, so it can recolor each existing span
  // directly. Treating it like a partial copy selection would remeasure and split every token — a
  // particularly expensive duplicate width pass for long wrapped CJK lines.
  const fullHighlightBg =
    highlightBg &&
    selectionColRange &&
    selectionColRange.start <= 0 &&
    selectionColRange.end >= width
      ? highlightBg
      : undefined;
  const needsBlending = !fullHighlightBg && highlightBg && selectionColRange;
  const renderedBackground = (background: string) =>
    fullHighlightBg ? fullHighlightBg(background) : background;
  const paddingAmount = Math.max(0, width - usedWidth);
  let paddingMerged = false;
  const lastSpan = trimmed.at(-1);
  if (
    !needsBlending &&
    paddingAmount > 0 &&
    lastSpan &&
    (lastSpan.fg ?? fallbackColor) === fallbackColor &&
    (lastSpan.bg ?? fallbackBg) === fallbackBg
  ) {
    // sliceSpansWindow always returns owned span objects, so padding can share the final native node.
    lastSpan.text += " ".repeat(paddingAmount);
    paddingMerged = true;
  }

  // Build the final element list by splitting spans at selection boundaries so the highlight
  // applies at character-level precision rather than whole-token granularity.
  const elements: ReactNode[] = [];
  let colPos = 0;
  let elementIndex = 0;

  for (const span of trimmed) {
    if (!needsBlending) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={span.fg ?? fallbackColor}
          bg={renderedBackground(span.bg ?? fallbackBg)}
        >
          {span.text}
        </span>,
      );
      continue;
    }

    const spanWidth = measureTextWidth(span.text);
    const spanStart = colPos;
    const spanEnd = colPos + spanWidth;
    colPos = spanEnd;

    if (spanEnd <= selectionColRange.start || spanStart >= selectionColRange.end) {
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
    const localSelEnd = Math.min(spanWidth, selectionColRange.end - spanStart);

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
    const prefix = sliceTextByWidth(span.text, 0, localSelStart).text;
    const selected = sliceTextByWidth(span.text, localSelStart, localSelEnd - localSelStart).text;
    const suffix = sliceTextByWidth(span.text, localSelEnd, spanWidth - localSelEnd).text;

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
          bg={highlightBg(span.bg ?? fallbackBg)}
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
    // The padding starts at colPos (which is now the terminal-cell width consumed by
    // the rendered spans) and extends to `width`.
    const padStart = colPos;
    const padEnd = colPos + Math.max(0, width - usedWidth);
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
            <span key={`${keyPrefix}:pad-sel`} fg={fallbackColor} bg={highlightBg(fallbackBg)}>
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
  } else if (!paddingMerged && paddingAmount > 0) {
    // Keep a separate padding span when the final content style differs from the cell fallback.
    elements.push(
      <span key={`${keyPrefix}:pad`} fg={fallbackColor} bg={renderedBackground(fallbackBg)}>
        {" ".repeat(paddingAmount)}
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

// Repeated offset slicing is faster for short spans, while its repeated grapheme traversal turns
// quadratic once one span crosses many visual lines. Switch only where the linear planner wins
// decisively so ordinary wrapped and nowrap text retain their established fast paths.
const SINGLE_PASS_WRAP_LINE_THRESHOLD = 8;

/** Wrap styled spans into visual lines while preserving color runs across splits. */
function wrapSpans(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return [[]] as RenderSpan[][];
  }

  const lines: RenderSpan[][] = [[]];
  let current = lines[0]!;
  let remaining = width;
  const safeSpans = sanitizeTerminalSpans(spans);
  let plannedSpans = safeSpans;
  let hasCompositionSensitiveSpan = false;
  let simpleSpanWidths: Array<number | null> = [];
  for (const span of safeSpans) {
    const spanWidth = measureSimpleSanitizedTextWidth(span.text);
    simpleSpanWidths.push(spanWidth);
    hasCompositionSensitiveSpan ||= spanWidth === null;
  }
  if (safeSpans.length > 1 && hasCompositionSensitiveSpan) {
    plannedSpans = mergeCrossSpanGraphemes(safeSpans);
    simpleSpanWidths = plannedSpans.map((span) => measureSimpleSanitizedTextWidth(span.text));
  }

  for (let spanIndex = 0; spanIndex < plannedSpans.length; spanIndex += 1) {
    const span = plannedSpans[spanIndex]!;
    const simpleSpanWidth = simpleSpanWidths[spanIndex] ?? null;
    const spanWidth = simpleSpanWidth ?? measureSanitizedTextWidth(span.text);
    if (spanWidth === 0) {
      appendRenderSpan(current, { ...span });
      continue;
    }

    if (
      spanWidth > width * SINGLE_PASS_WRAP_LINE_THRESHOLD ||
      simpleSpanWidth === null ||
      (width === 1 && !isPrintableAsciiText(span.text))
    ) {
      for (const chunk of wrapSanitizedTextByWidth(
        span.text,
        width,
        remaining,
        current.length > 0,
      )) {
        if (chunk.startsNewLine) {
          current = [];
          lines.push(current);
          remaining = width;
        }
        if (chunk.text.length > 0) {
          appendRenderSpan(current, { ...span, text: chunk.text });
        }
        remaining -= chunk.width;
      }
      continue;
    }

    let offset = 0;

    while (offset < spanWidth) {
      if (remaining <= 0) {
        current = [];
        lines.push(current);
        remaining = width;
      }

      const visible = sliceSanitizedTextByWidth(span.text, offset, remaining);
      if (visible.width === 0) {
        // Move to a fresh row only when this row already contains content. If the full row itself
        // is too narrow, keep the single attempted continuation aligned with geometry measurement.
        if (current.length > 0 || remaining < width) {
          current = [];
          lines.push(current);
          remaining = width;
        }
        const forced = sliceSanitizedTextByWidth(span.text, offset, width);
        if (forced.width === 0) {
          break;
        }
        const nextSpan = {
          ...span,
          text: forced.text,
        };
        current.push(nextSpan);
        offset += forced.width;
        remaining = Math.max(0, width - forced.width);
        continue;
      }

      const nextSpan = {
        ...span,
        text: visible.text,
      };
      appendRenderSpan(current, nextSpan);

      offset += visible.width;
      remaining -= visible.width;
    }
  }

  return lines;
}

/** Count wrapped visual lines without allocating the styled line arrays used by rendering. */
function measureWrappedSpansLineCount(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return 1;
  }

  let lineCount = 1;
  let remaining = width;
  let currentLineHasContent = false;
  const safeSpans = preserveCrossSpanGraphemes(sanitizeTerminalSpans(spans));
  for (const span of safeSpans) {
    // Preserve zero-width span presence across styled runs so a later over-wide grapheme makes the
    // same continuation decision as wrapSpans' concrete line arrays.
    for (const chunk of wrapSanitizedTextByWidth(
      span.text,
      width,
      remaining,
      currentLineHasContent,
    )) {
      if (chunk.startsNewLine) {
        lineCount += 1;
        remaining = width;
        currentLineHasContent = false;
      }
      remaining -= chunk.width;
      currentLineHasContent ||= chunk.text.length > 0;
    }
  }
  return lineCount;
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

  const visible = sliceTextByWidth(
    sanitizeTerminalSpans(spans)
      .map((span) => span.text)
      .join(""),
    Math.max(0, horizontalOffset),
    width,
  );

  return padTextByWidth(visible.text, Math.max(0, width));
}

/** Flatten styled spans to their visible text content. */
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
  return marker() + padTextByWidth(label, Math.max(0, width - 1));
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
      const normalizedLeft = padTextByWidth(`${leftPrefix}${leftLine.spansText}`, leftWidth);
      const normalizedRight = padTextByWidth(
        `${rightPrefix}${rightLine.spansText}`,
        rightRenderWidth,
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
    const normalized = padTextByWidth(visibleLine, Math.max(1, contentWidth + prefix.length));
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
 * Apply a highlight blend to a cell palette's gutter bg only.
 *
 * The content bg is intentionally left untouched here so renderInlineSpans can apply the same
 * blend uniformly across every rendered span (including syntax-emphasis spans that supply their
 * own bg). Pre-blending contentBg would cause the fallback path to double-blend.
 */
function applyHighlightPalette<P extends { gutterBg: string; contentBg: string }>(
  palette: P,
  highlightBg: (baseBg: string) => string,
): P {
  return {
    ...palette,
    gutterBg: highlightBg(palette.gutterBg),
  };
}

/**
 * Choose which highlight paints one half of a row.
 *
 * An active drag outranks the resting cursor, so copy selection keeps its exact extent.
 */
function pickRowHighlight(
  selection: RowHighlight,
  cursor: RowHighlight | undefined,
  hasSelection: boolean,
  onCursor: boolean,
) {
  if (hasSelection) {
    return selection;
  }
  return onCursor ? cursor : undefined;
}

/** Apply a highlight blend to a prefix descriptor. */
function applyHighlightPrefix<P extends { bg: string }>(
  prefix: P,
  highlightBg: (baseBg: string) => string,
): P {
  return {
    ...prefix,
    bg: highlightBg(prefix.bg),
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
  highlight?: RowHighlight,
  paneOffset = 0,
) {
  const basePalette = splitCellPalette(cell.kind, theme, cell.moveKind);
  const palette = highlight ? applyHighlightPalette(basePalette, highlight.bg) : basePalette;
  const resolvedPrefix = highlight && prefix ? applyHighlightPrefix(prefix, highlight.bg) : prefix;
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
  const colRange = highlight?.colRange;
  const localColRange =
    colRange && globalContentStart < colRange.endCol
      ? {
          start: Math.max(0, colRange.startCol - globalContentStart),
          end: Math.min(contentWidth, Math.max(0, colRange.endCol - globalContentStart + 1)),
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
        theme.syntaxColors.default,
        palette.contentBg,
        `${keyPrefix}:content`,
        contentOffset,
        highlight?.bg,
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
  highlight?: RowHighlight,
) {
  const basePalette = stackCellPalette(cell.kind, theme, cell.moveKind);
  const palette = highlight ? applyHighlightPalette(basePalette, highlight.bg) : basePalette;
  const resolvedPrefix = highlight && prefix ? applyHighlightPrefix(prefix, highlight.bg) : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;
  const { gutterWidth, contentWidth } = resolveStackCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );

  // Convert global selection column range to content-local range.
  const globalContentStart = prefixWidth + gutterWidth;
  const colRange = highlight?.colRange;
  const localColRange =
    colRange && globalContentStart < colRange.endCol
      ? {
          start: Math.max(0, colRange.startCol - globalContentStart),
          end: Math.min(contentWidth, Math.max(0, colRange.endCol - globalContentStart + 1)),
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
        theme.syntaxColors.default,
        palette.contentBg,
        `${keyPrefix}:content`,
        contentOffset,
        highlight?.bg,
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
  highlight?: RowHighlight,
  paneOffset = 0,
) {
  const resolvedPalette = highlight ? applyHighlightPalette(palette, highlight.bg) : palette;
  const resolvedPrefix = highlight ? applyHighlightPrefix(prefix, highlight.bg) : prefix;

  const prefixWidth = prefix.text.length;
  const gutterWidth = line.gutterText.length;
  const globalContentStart = paneOffset + prefixWidth + gutterWidth;
  const colRange = highlight?.colRange;
  const localColRange =
    colRange && globalContentStart < colRange.endCol
      ? {
          start: Math.max(0, colRange.startCol - globalContentStart),
          end: Math.min(contentWidth, Math.max(0, colRange.endCol - globalContentStart + 1)),
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
        theme.syntaxColors.default,
        resolvedPalette.contentBg,
        `${keyPrefix}:content`,
        0,
        highlight?.bg,
        localColRange,
        true,
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
  highlight?: RowHighlight,
) {
  const resolvedPalette = highlight ? applyHighlightPalette(palette, highlight.bg) : palette;
  const resolvedPrefix = highlight ? applyHighlightPrefix(prefix, highlight.bg) : prefix;

  const prefixWidth = prefix.text.length;
  const gutterWidth = line.gutterText.length;
  const globalContentStart = prefixWidth + gutterWidth;
  const colRange = highlight?.colRange;
  const localColRange =
    colRange && globalContentStart < colRange.endCol
      ? {
          start: Math.max(0, colRange.startCol - globalContentStart),
          end: Math.min(contentWidth, Math.max(0, colRange.endCol - globalContentStart + 1)),
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
        theme.syntaxColors.default,
        resolvedPalette.contentBg,
        `${keyPrefix}:content`,
        0,
        highlight?.bg,
        localColRange,
        true,
      )}
    </>
  );
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

/** Build the rendered label text for one collapsed gap row. */
function collapsedRowLabel(text: string, expandable: boolean) {
  if (!expandable) {
    return `··· ${text} ···`;
  }

  // The leading chevron hints that the row is interactive on terminals that
  // render Unicode glyphs. The label still reads naturally on plain VT100.
  return `▾ ${text}`;
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
  onToggleGap?: (gapKey: string) => void,
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
  const collapsedExpandable = row.type === "collapsed" && Boolean(onToggleGap);
  const labelText =
    row.type === "collapsed" ? collapsedRowLabel(row.text, collapsedExpandable) : row.text;
  const label = fitText(labelText, Math.max(0, width - 1 - badgeWidth));
  const handleCollapsedClick =
    row.type === "collapsed" && onToggleGap
      ? () => onToggleGap(reviewGapId(row.position, row.hunkIndex))
      : undefined;

  if (badges.length === 0) {
    return (
      <box
        key={row.key}
        id={anchorId}
        style={{
          width,
          height: 1,
          backgroundColor: theme.panelAlt,
        }}
        onMouseMove={() => onHoverRow?.(row.key)}
        onMouseOver={() => onHoverRow?.(row.key)}
        onMouseUp={handleCollapsedClick}
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
        width,
        height: 1,
        flexDirection: "row",
        backgroundColor: theme.panelAlt,
      }}
      onMouseMove={() => onHoverRow?.(row.key)}
      onMouseOver={() => onHoverRow?.(row.key)}
    >
      <box
        style={{ width: Math.max(0, width - badgeWidth), height: 1 }}
        onMouseUp={handleCollapsedClick}
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

/** Fill the reserved wrapped-row hover column so row backgrounds do not visibly shrink. */
function renderAddNoteSpacer(key: string, width: number, bg: string) {
  if (width <= 0) {
    return null;
  }

  const cacheKey = `${width}:${bg}`;
  let content = addNoteSpacerContentCache.get(cacheKey);
  if (!content) {
    content = new StyledText([
      {
        __isChunk: true,
        text: " ".repeat(width),
        bg: styledTextColor(bg),
      },
    ]);
    addNoteSpacerContentCache.set(cacheKey, content);
  }
  return (
    <box key={key} style={{ width, height: 1 }}>
      <text content={content} />
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
  _theme: AppTheme,
  reserveAddNoteColumn = false,
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
    const hoverReserveWidth = wrappedAddNoteReserveWidth(wrapLines, reserveAddNoteColumn);
    const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
    const leftGeometry = resolveSplitCellGeometry(
      leftWidth,
      lineNumberDigits,
      showLineNumbers,
      markerWidth,
    );
    const rightGeometry = resolveSplitCellGeometry(
      Math.max(0, rightWidth - hoverReserveWidth),
      lineNumberDigits,
      showLineNumbers,
      markerWidth,
    );

    return Math.max(
      measureWrappedSpansLineCount(row.left.spans, leftGeometry.contentWidth),
      measureWrappedSpansLineCount(row.right.spans, rightGeometry.contentWidth),
    );
  }

  if (row.type !== "stack-line") {
    return 1;
  }

  if (!wrapLines) {
    return 1;
  }

  const cellGeometry = resolveStackCellGeometry(
    Math.max(0, width - wrappedAddNoteReserveWidth(wrapLines, reserveAddNoteColumn)),
    lineNumberDigits,
    showLineNumbers,
    marker().length,
  );
  return measureWrappedSpansLineCount(row.cell.spans, cellGeometry.contentWidth);
}

/** Repaint one split cell's spans over its extension highlight ranges, if any. */
function withSplitCellLineHighlights(
  cell: SplitLineCell,
  side: "old" | "new",
  lineHighlights: LineHighlightPaintIndex,
  theme: AppTheme,
): SplitLineCell {
  if (cell.kind === "empty" || cell.lineNumber === undefined) {
    return cell;
  }
  const ranges = lineHighlights.get(lineHighlightPaintKey(side, cell.lineNumber));
  if (!ranges) {
    return cell;
  }
  const contentBg = splitCellPalette(cell.kind, theme, cell.moveKind).contentBg;
  return {
    ...cell,
    spans: applyLineHighlightsToSpans(cell.spans, ranges, (tone) =>
      lineHighlightToneStyle(tone, contentBg, theme),
    ),
  };
}

/**
 * Apply extension line highlights to one row's cells before rendering.
 *
 * Paint-time by design: text is never changed, so the returned row measures
 * and wraps identically to the original, and the shared row plan, geometry,
 * and highlighted-diff caches never see highlights at all. Cells are copied
 * because their span arrays are shared cached objects.
 */
function withRowLineHighlights(
  row: DiffRow,
  lineHighlights: LineHighlightPaintIndex | undefined,
  theme: AppTheme,
): DiffRow {
  if (!lineHighlights || lineHighlights.size === 0) {
    return row;
  }

  if (row.type === "split-line") {
    const left = withSplitCellLineHighlights(row.left, "old", lineHighlights, theme);
    const right = withSplitCellLineHighlights(row.right, "new", lineHighlights, theme);
    return left === row.left && right === row.right ? row : { ...row, left, right };
  }

  if (row.type === "stack-line") {
    const cell = row.cell;
    // Context cells carry both numbers pointing at one merged range list, so
    // consulting the new side first never hides an old-side mark.
    const ranges =
      (cell.newLineNumber !== undefined
        ? lineHighlights.get(lineHighlightPaintKey("new", cell.newLineNumber))
        : undefined) ??
      (cell.oldLineNumber !== undefined
        ? lineHighlights.get(lineHighlightPaintKey("old", cell.oldLineNumber))
        : undefined);
    if (!ranges) {
      return row;
    }
    const contentBg = stackCellPalette(cell.kind, theme, cell.moveKind).contentBg;
    return {
      ...row,
      cell: {
        ...cell,
        spans: applyLineHighlightsToSpans(cell.spans, ranges, (tone) =>
          lineHighlightToneStyle(tone, contentBg, theme),
        ),
      },
    };
  }

  return row;
}

/** Render one diff row. */
function renderRow(
  sourceRow: DiffRow,
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
  cursorHighlight: CursorHighlight | undefined,
  lineHighlights: LineHighlightPaintIndex | undefined,
  anchorId?: string,
  noteGuideSide?: "old" | "new",
  showAddNoteBadge = false,
  onHoverRow?: (rowKey: string) => void,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
  onToggleGap?: (gapKey: string) => void,
) {
  // Extension marks repaint span backgrounds only; geometry inputs keep using the source row.
  const row = withRowLineHighlights(sourceRow, lineHighlights, theme);
  const hasCopySelection = !!copySelectedRowRange;
  const reserveAddNoteColumn = Boolean(onStartUserNoteAtHunk);

  // For split rows, the user's drag is anchored to one column-half of the diff. Apply the
  // selection-highlight blend only to that side so it is clear which file (A or B) the
  // selection represents.
  const hasLeftSelection = hasCopySelection && copySelectedSide !== "right";
  const hasRightSelection = hasCopySelection && copySelectedSide !== "left";

  // A split context row shows the same source line on both halves, so marking one of them would
  // read as half a row. Change rows keep the split, since the halves are different note targets.
  const splitContextRow =
    row.type === "split-line" && row.left.kind === "context" && row.right.kind === "context";
  const onCursorRow = cursorHighlight !== undefined;
  const selectionHighlight: RowHighlight = {
    bg: (baseBg) => selectionHighlightBg(baseBg, theme),
    colRange: copySelectedRowRange,
  };
  const cursorRowHighlight: RowHighlight | undefined = onCursorRow
    ? {
        bg: (baseBg) => cursorLineHighlightBg(baseBg, theme),
        colRange: cursorHighlight.style === "row" ? FULL_ROW_COL_RANGE : undefined,
      }
    : undefined;
  const leftHighlight = pickRowHighlight(
    selectionHighlight,
    cursorRowHighlight,
    hasLeftSelection,
    onCursorRow && (splitContextRow || cursorHighlight.side === "old"),
  );
  const rightHighlight = pickRowHighlight(
    selectionHighlight,
    cursorRowHighlight,
    hasRightSelection,
    onCursorRow && (splitContextRow || cursorHighlight.side === "new"),
  );
  const cellHighlight = pickRowHighlight(
    selectionHighlight,
    cursorRowHighlight,
    hasCopySelection,
    onCursorRow,
  );
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
      onToggleGap,
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
    const addBadgeWidth =
      showAddNoteBadge || (wrapLines && reserveAddNoteColumn) ? addNoteBadgeText.length : 0;
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
                leftHighlight,
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
                rightHighlight,
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
            let styledRow: StyledText;
            if (
              !isChunkCompatibleWrappedHighlight(leftHighlight) ||
              !isChunkCompatibleWrappedHighlight(rightHighlight)
            ) {
              styledRow = styledTextFromSpanNodes([
                renderWrappedSplitCellLine(
                  leftLine,
                  leftLayout.palette,
                  leftContentWidth,
                  theme,
                  `${row.key}:left:${index}`,
                  leftPrefix,
                  leftHighlight,
                  0,
                ),
                renderWrappedSplitCellLine(
                  rightLine,
                  rightLayout.palette,
                  rightContentWidth,
                  theme,
                  `${row.key}:right:${index}`,
                  rightPrefix,
                  rightHighlight,
                  leftWidth,
                ),
                guideOnNewSide ? (
                  <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
                    │
                  </span>
                ) : null,
              ]);
            } else {
              const chunks: TextChunk[] = [];
              appendWrappedCellChunks(
                chunks,
                leftLine,
                leftLayout.palette,
                leftContentWidth,
                theme,
                leftPrefix,
                leftHighlight,
              );
              appendWrappedCellChunks(
                chunks,
                rightLine,
                rightLayout.palette,
                rightContentWidth,
                theme,
                rightPrefix,
                rightHighlight,
              );
              if (guideOnNewSide) {
                chunks.push({
                  __isChunk: true,
                  text: "│",
                  fg: styledTextColor(theme.noteBorder),
                });
              }
              styledRow = new StyledText(chunks);
            }
            if (!showBadgeOnLine && addBadgeWidth > 0) {
              styledRow.chunks.push({
                __isChunk: true,
                text: " ".repeat(addBadgeWidth),
                bg: styledTextColor(rightLayout.palette.contentBg),
              });
            }

            if (!showBadgeOnLine) {
              return (
                <text
                  key={`${row.key}:wrap:${index}`}
                  content={styledRow}
                  onMouseMove={() => onHoverRow?.(row.key)}
                />
              );
            }
            return (
              <box
                key={`${row.key}:wrap:${index}`}
                style={{ width: "100%", height: 1, flexDirection: "row" }}
                onMouseMove={() => onHoverRow?.(row.key)}
              >
                <box style={{ width: Math.max(0, width - addBadgeWidth), height: 1 }}>
                  <text content={styledRow} />
                </box>
                {renderAddNoteButton(
                  `${row.key}:add-note:${index}`,
                  theme,
                  row.hunkIndex,
                  addNoteTarget,
                  onStartUserNoteAtHunk,
                )}
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
    const addBadgeWidth =
      showAddNoteBadge || (wrapLines && reserveAddNoteColumn) ? addNoteBadgeText.length : 0;
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
                cellHighlight,
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
            let styledRow: StyledText;
            if (isChunkCompatibleWrappedHighlight(cellHighlight)) {
              const chunks: TextChunk[] = [];
              appendWrappedCellChunks(
                chunks,
                line,
                layout.palette,
                wrappedContentWidth,
                theme,
                prefix,
                cellHighlight,
              );
              if (guideOnNewSide) {
                chunks.push({
                  __isChunk: true,
                  text: "│",
                  fg: styledTextColor(theme.noteBorder),
                });
              }
              styledRow = new StyledText(chunks);
            } else {
              styledRow = styledTextFromSpanNodes([
                renderWrappedStackCellLine(
                  line,
                  layout.palette,
                  wrappedContentWidth,
                  theme,
                  `${row.key}:stack:${index}`,
                  prefix,
                  cellHighlight,
                ),
                guideOnNewSide ? (
                  <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
                    │
                  </span>
                ) : null,
              ]);
            }

            return (
              <box
                key={`${row.key}:wrap:${index}`}
                style={{ width: "100%", height: 1, flexDirection: "row" }}
                onMouseMove={() => onHoverRow?.(row.key)}
              >
                <box
                  style={{
                    width: addBadgeWidth > 0 ? Math.max(0, width - addBadgeWidth) : "100%",
                    height: 1,
                  }}
                >
                  <text content={styledRow} />
                </box>
                {showBadgeOnLine
                  ? renderAddNoteButton(
                      `${row.key}:add-note:${index}`,
                      theme,
                      row.hunkIndex,
                      addNoteTarget,
                      onStartUserNoteAtHunk,
                    )
                  : renderAddNoteSpacer(
                      `${row.key}:add-note-spacer:${index}`,
                      addBadgeWidth,
                      layout.palette.contentBg,
                    )}
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
  cursorHighlight?: CursorHighlight;
  /** Extension marks for this row's file, resolved to terminal columns. */
  lineHighlights?: LineHighlightPaintIndex;
  anchorId?: string;
  noteGuideSide?: "old" | "new";
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onToggleGap?: (gapKey: string) => void;
}

/**
 * Render one diff row, memoized to avoid unnecessary rerenders.
 *
 * The comparator checks every handler by reference, so callers (DiffSectionBody) must pass
 * identity-stable callbacks — e.g. one shared onHoverRow that receives the row key — or the memo
 * silently degrades to re-rendering every visible row per parent render.
 */
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
    cursorHighlight,
    lineHighlights,
    anchorId,
    noteGuideSide,
    showAddNoteBadge,
    onHoverRow,
    onStartUserNoteAtHunk,
    onToggleGap,
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
      cursorHighlight,
      lineHighlights,
      anchorId,
      noteGuideSide,
      showAddNoteBadge,
      onHoverRow,
      onStartUserNoteAtHunk,
      onToggleGap,
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
      previous.cursorHighlight === next.cursorHighlight &&
      previous.lineHighlights === next.lineHighlights &&
      previous.anchorId === next.anchorId &&
      previous.noteGuideSide === next.noteGuideSide &&
      previous.showAddNoteBadge === next.showAddNoteBadge &&
      previous.onHoverRow === next.onHoverRow &&
      previous.onStartUserNoteAtHunk === next.onStartUserNoteAtHunk &&
      previous.onToggleGap === next.onToggleGap
    );
  },
);
