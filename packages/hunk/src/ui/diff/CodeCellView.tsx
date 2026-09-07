/**
 * Paints split and stack diff code cells through React and OpenTUI.
 * Canonical code-row and styled-span plans continue to own geometry and wrapping.
 */
import { Fragment, isValidElement, memo, type ReactNode } from "react";
import { parseColor, StyledText, type TextChunk } from "@opentui/core";
import type { AppTheme } from "../themes";
import type { CodeCellLayoutPlan, CodeRowLayoutPlan } from "./codeRowLayout";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./diffRows";
import {
  applyLineHighlightsToSpans,
  lineHighlightPaintKey,
  type LineHighlightPaintIndex,
} from "./lineHighlightPaint";
import {
  lineHighlightToneStyle,
  splitCellPalette,
  splitGutterText,
  stackCellPalette,
  stackGutterText,
} from "./rowStyle";
import { sanitizeTerminalSpans } from "../../lib/terminalText";
import { measureTextWidth, sliceTextByWidth } from "../lib/text";
import { sliceSpansWindow, wrapSpans } from "./styledSpanLayout";
import type { CopySelectedRowRange } from "../lib/diffSpatial";

/** Describes a row highlight passed from review selection policy into cell painting. */
export interface CodeCellHighlight {
  bg: (baseBg: string) => string;
  /** Global columns to blend; absent blends the gutter alone. */
  colRange?: CopySelectedRowRange;
}

/** Selects the complete content window while preserving wrapped direct-chunk compatibility. */
export const FULL_CODE_CELL_COL_RANGE: CopySelectedRowRange = {
  startCol: 0,
  endCol: Number.MAX_SAFE_INTEGER,
};

interface CellPrefix {
  text: string;
  fg: string;
  bg: string;
}

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

/** Resolve paint-only foreground effects against the background the terminal will draw. */
function renderedSpanForeground(span: RenderSpan, fallbackColor: string, renderedBg: string) {
  const sourceFg = span.fg ?? fallbackColor;
  return span.transformFg ? span.transformFg(sourceFg, renderedBg) : sourceFg;
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
    const background = renderedBackground(span.bg ?? fallbackBg);
    chunks.push({
      __isChunk: true,
      text: span.text,
      fg: styledTextColor(renderedSpanForeground(span, fallbackColor, background)),
      bg: styledTextColor(background),
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

/** Append one horizontally windowed nowrap cell directly to OpenTUI styled-text chunks. */
function appendPlainInlineChunks(
  chunks: TextChunk[],
  spans: RenderSpan[],
  width: number,
  horizontalOffset: number,
  fallbackColor: string,
  fallbackBg: string,
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(
    sanitizeTerminalSpans(spans),
    horizontalOffset,
    width,
  );
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
    const background = span.bg ?? fallbackBg;
    chunks.push({
      __isChunk: true,
      text: span.text,
      fg: styledTextColor(renderedSpanForeground(span, fallbackColor, background)),
      bg: styledTextColor(background),
    });
  }
  if (!paddingMerged && paddingAmount > 0) {
    chunks.push({
      __isChunk: true,
      text: " ".repeat(paddingAmount),
      fg: styledTextColor(fallbackColor),
      bg: styledTextColor(fallbackBg),
    });
  }
}

/** Append one unhighlighted split cell without constructing React span fibers. */
function appendPlainSplitCellChunks(
  chunks: TextChunk[],
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  theme: AppTheme,
  contentOffset: number,
  prefix: CellPrefix,
) {
  const palette = splitCellPalette(cell.kind, theme, cell.moveKind);
  chunks.push(
    {
      __isChunk: true,
      text: prefix.text,
      fg: styledTextColor(prefix.fg),
      bg: styledTextColor(prefix.bg),
    },
    {
      __isChunk: true,
      text: splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(geometry.gutterWidth),
      fg: styledTextColor(palette.numberColor),
      bg: styledTextColor(palette.gutterBg),
    },
  );
  appendPlainInlineChunks(
    chunks,
    cell.spans,
    geometry.contentWidth,
    contentOffset,
    theme.syntaxColors.default,
    palette.contentBg,
  );
}

/** Append one unhighlighted stack cell without constructing React span fibers. */
function appendPlainStackCellChunks(
  chunks: TextChunk[],
  cell: StackLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  theme: AppTheme,
  contentOffset: number,
  prefix: CellPrefix,
) {
  const palette = stackCellPalette(cell.kind, theme, cell.moveKind);
  chunks.push(
    {
      __isChunk: true,
      text: prefix.text,
      fg: styledTextColor(prefix.fg),
      bg: styledTextColor(prefix.bg),
    },
    {
      __isChunk: true,
      text: stackGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(geometry.gutterWidth),
      fg: styledTextColor(palette.numberColor),
      bg: styledTextColor(palette.gutterBg),
    },
  );
  appendPlainInlineChunks(
    chunks,
    cell.spans,
    geometry.contentWidth,
    contentOffset,
    theme.syntaxColors.default,
    palette.contentBg,
  );
}

/** Report whether a wrapped highlight can paint existing chunks without slicing token spans. */
function isChunkCompatibleWrappedHighlight(highlight: CodeCellHighlight | undefined) {
  return !highlight?.colRange || highlight.colRange === FULL_CODE_CELL_COL_RANGE;
}

/** Append one wrapped cell without constructing intermediate React span elements. */
function appendWrappedCellChunks(
  chunks: TextChunk[],
  line: WrappedCellLine,
  palette: { numberColor: string; gutterBg: string; contentBg: string },
  contentWidth: number,
  theme: AppTheme,
  prefix: { text: string; fg: string; bg: string },
  highlight?: CodeCellHighlight,
) {
  const renderedBackground = (background: string) =>
    highlight ? highlight.bg(background) : background;
  const contentHighlightBg =
    highlight?.colRange === FULL_CODE_CELL_COL_RANGE ? highlight.bg : undefined;
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
    const baseBackground = span.bg ?? fallbackBg;
    if (!needsBlending) {
      const background = renderedBackground(baseBackground);
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={renderedSpanForeground(span, fallbackColor, background)}
          bg={background}
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
          fg={renderedSpanForeground(span, fallbackColor, baseBackground)}
          bg={baseBackground}
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
          fg={renderedSpanForeground(span, fallbackColor, baseBackground)}
          bg={baseBackground}
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
          fg={renderedSpanForeground(span, fallbackColor, baseBackground)}
          bg={baseBackground}
        >
          {prefix}
        </span>,
      );
    }
    if (selected) {
      const selectedBackground = highlightBg(baseBackground);
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={renderedSpanForeground(span, fallbackColor, selectedBackground)}
          bg={selectedBackground}
        >
          {selected}
        </span>,
      );
    }
    if (suffix) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={renderedSpanForeground(span, fallbackColor, baseBackground)}
          bg={baseBackground}
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

/** Build wrapped split-cell gutter/content lines while keeping continuation gutters blank. */
function buildWrappedSplitCell(
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  theme: AppTheme,
) {
  const palette = splitCellPalette(cell.kind, theme, cell.moveKind);
  const firstGutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    geometry.gutterWidth,
  );
  const wrappedSpans = wrapSpans(cell.spans, geometry.contentWidth);

  return {
    gutterWidth: geometry.gutterWidth,
    contentWidth: geometry.contentWidth,
    palette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(geometry.gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
}

/** Build wrapped stack-cell gutter/content lines while keeping continuation gutters blank. */
function buildWrappedStackCell(
  cell: StackLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  theme: AppTheme,
) {
  const palette = stackCellPalette(cell.kind, theme, cell.moveKind);
  const firstGutterText = stackGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    geometry.gutterWidth,
  );
  const wrappedSpans = wrapSpans(cell.spans, geometry.contentWidth);

  return {
    gutterWidth: geometry.gutterWidth,
    contentWidth: geometry.contentWidth,
    palette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(geometry.gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
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

/** Render selection-invariant split-cell content behind its independently painted rail. */
const SplitCellContent = memo(function SplitCellContent({
  cell,
  gutterWidth,
  contentWidth,
  lineNumberDigits,
  showLineNumbers,
  theme,
  keyPrefix,
  contentOffset,
  prefixWidth,
  highlight,
  paneOffset,
}: {
  cell: SplitLineCell;
  gutterWidth: number;
  contentWidth: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  theme: AppTheme;
  keyPrefix: string;
  contentOffset: number;
  prefixWidth: number;
  highlight?: CodeCellHighlight;
  paneOffset: number;
}) {
  const basePalette = splitCellPalette(cell.kind, theme, cell.moveKind);
  const palette = highlight ? applyHighlightPalette(basePalette, highlight.bg) : basePalette;
  const gutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth);
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
});

/** Render one split-view cell while letting a rail-only selection change skip its code spans. */
function renderSplitCell(
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
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
  highlight?: CodeCellHighlight,
  paneOffset = 0,
) {
  const resolvedPrefix = highlight && prefix ? applyHighlightPrefix(prefix, highlight.bg) : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;

  return (
    <>
      {resolvedPrefix ? (
        <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
          {resolvedPrefix.text}
        </span>
      ) : null}
      <SplitCellContent
        key={`${keyPrefix}:body`}
        cell={cell}
        gutterWidth={geometry.gutterWidth}
        contentWidth={geometry.contentWidth}
        lineNumberDigits={lineNumberDigits}
        showLineNumbers={showLineNumbers}
        theme={theme}
        keyPrefix={keyPrefix}
        contentOffset={contentOffset}
        prefixWidth={prefixWidth}
        highlight={highlight}
        paneOffset={paneOffset}
      />
    </>
  );
}

/** Render selection-invariant stack-cell content behind its independently painted rail. */
const StackCellContent = memo(function StackCellContent({
  cell,
  gutterWidth,
  contentWidth,
  lineNumberDigits,
  showLineNumbers,
  theme,
  keyPrefix,
  contentOffset,
  prefixWidth,
  highlight,
}: {
  cell: StackLineCell;
  gutterWidth: number;
  contentWidth: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  theme: AppTheme;
  keyPrefix: string;
  contentOffset: number;
  prefixWidth: number;
  highlight?: CodeCellHighlight;
}) {
  const basePalette = stackCellPalette(cell.kind, theme, cell.moveKind);
  const palette = highlight ? applyHighlightPalette(basePalette, highlight.bg) : basePalette;
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
});

/** Render one stack-view cell while letting a rail-only selection change skip its code spans. */
function renderStackCell(
  cell: StackLineCell,
  geometry: CodeCellLayoutPlan,
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
  highlight?: CodeCellHighlight,
) {
  const resolvedPrefix = highlight && prefix ? applyHighlightPrefix(prefix, highlight.bg) : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;

  return (
    <>
      {resolvedPrefix ? (
        <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
          {resolvedPrefix.text}
        </span>
      ) : null}
      <StackCellContent
        key={`${keyPrefix}:body`}
        cell={cell}
        gutterWidth={geometry.gutterWidth}
        contentWidth={geometry.contentWidth}
        lineNumberDigits={lineNumberDigits}
        showLineNumbers={showLineNumbers}
        theme={theme}
        keyPrefix={keyPrefix}
        contentOffset={contentOffset}
        prefixWidth={prefixWidth}
        highlight={highlight}
      />
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
  highlight?: CodeCellHighlight,
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
  highlight?: CodeCellHighlight,
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

/** Repaint one split cell's spans over its geometry-neutral extension highlight ranges. */
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

interface NowrapSplitCodeCellsOptions {
  row: Extract<DiffRow, { type: "split-line" }>;
  layout: Extract<CodeRowLayoutPlan, { kind: "split" }>;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  theme: AppTheme;
  horizontalOffset: number;
  leftPrefix: CellPrefix;
  rightPrefix: CellPrefix;
  leftHighlight?: CodeCellHighlight;
  rightHighlight?: CodeCellHighlight;
  guideOnNewSide: boolean;
}

/** Paint one nowrap split row, retaining the direct-chunk path when neither side is highlighted. */
function renderNowrapSplitCodeCells({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  theme,
  horizontalOffset,
  leftPrefix,
  rightPrefix,
  leftHighlight,
  rightHighlight,
  guideOnNewSide,
}: NowrapSplitCodeCellsOptions) {
  if (!leftHighlight && !rightHighlight) {
    const chunks: TextChunk[] = [];
    appendPlainSplitCellChunks(
      chunks,
      row.left,
      layout.left,
      lineNumberDigits,
      showLineNumbers,
      theme,
      horizontalOffset,
      leftPrefix,
    );
    appendPlainSplitCellChunks(
      chunks,
      row.right,
      layout.right,
      lineNumberDigits,
      showLineNumbers,
      theme,
      horizontalOffset,
      rightPrefix,
    );
    appendNoteGuideChunk(chunks, guideOnNewSide, theme);
    return <text key={`${row.key}:plain`} content={new StyledText(chunks)} />;
  }

  return (
    <text key={`${row.key}:painted`}>
      {renderSplitCell(
        row.left,
        layout.left,
        lineNumberDigits,
        showLineNumbers,
        theme,
        `${row.key}:left`,
        horizontalOffset,
        leftPrefix,
        leftHighlight,
        0,
      )}
      {renderSplitCell(
        row.right,
        layout.right,
        lineNumberDigits,
        showLineNumbers,
        theme,
        `${row.key}:right`,
        horizontalOffset,
        rightPrefix,
        rightHighlight,
        layout.left.width,
      )}
      {guideOnNewSide ? (
        <span key={`${row.key}:note-guide`} fg={theme.noteBorder}>
          │
        </span>
      ) : null}
    </text>
  );
}

interface NowrapStackCodeCellOptions {
  row: Extract<DiffRow, { type: "stack-line" }>;
  layout: Extract<CodeRowLayoutPlan, { kind: "stack" }>;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  theme: AppTheme;
  horizontalOffset: number;
  prefix: CellPrefix;
  highlight?: CodeCellHighlight;
  guideOnNewSide: boolean;
}

/** Paint one nowrap stack row, retaining the direct-chunk path when it is unhighlighted. */
function renderNowrapStackCodeCell({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  theme,
  horizontalOffset,
  prefix,
  highlight,
  guideOnNewSide,
}: NowrapStackCodeCellOptions) {
  if (!highlight) {
    const chunks: TextChunk[] = [];
    appendPlainStackCellChunks(
      chunks,
      row.cell,
      layout.cell,
      lineNumberDigits,
      showLineNumbers,
      theme,
      horizontalOffset,
      prefix,
    );
    appendNoteGuideChunk(chunks, guideOnNewSide, theme);
    return <text key={`${row.key}:plain`} content={new StyledText(chunks)} />;
  }

  return (
    <text key={`${row.key}:painted`}>
      {renderStackCell(
        row.cell,
        layout.cell,
        lineNumberDigits,
        showLineNumbers,
        theme,
        `${row.key}:stack`,
        horizontalOffset,
        prefix,
        highlight,
      )}
      {guideOnNewSide ? (
        <span key={`${row.key}:note-guide`} fg={theme.noteBorder}>
          │
        </span>
      ) : null}
    </text>
  );
}

/** Append the optional note guide to a direct OpenTUI chunk list. */
function appendNoteGuideChunk(chunks: TextChunk[], enabled: boolean, theme: AppTheme) {
  if (!enabled) return;
  chunks.push({ __isChunk: true, text: "│", fg: styledTextColor(theme.noteBorder) });
}

export interface WrappedCodeCells {
  /** Number of visual lines derived from canonical styled-span wrapping. */
  lineCount: number;
  /** Background used to fill any separately mounted add-note spacer. */
  contentBackground: string;
  /** Paint one visual line, optionally extending it behind a reserved badge column. */
  paintLine: (index: number, trailingWidth?: number) => StyledText;
}

interface WrappedSplitCodeCellsOptions extends Omit<
  NowrapSplitCodeCellsOptions,
  "horizontalOffset"
> {}

/** Build a wrapped split-row painter whose line count and chunks share one wrapped layout. */
function createWrappedSplitCodeCells({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  theme,
  leftPrefix,
  rightPrefix,
  leftHighlight,
  rightHighlight,
  guideOnNewSide,
}: WrappedSplitCodeCellsOptions): WrappedCodeCells {
  const leftLayout = buildWrappedSplitCell(
    row.left,
    layout.left,
    lineNumberDigits,
    showLineNumbers,
    theme,
  );
  const rightLayout = buildWrappedSplitCell(
    row.right,
    layout.right,
    lineNumberDigits,
    showLineNumbers,
    theme,
  );
  const lineCount = Math.max(leftLayout.lines.length, rightLayout.lines.length);

  return {
    lineCount,
    contentBackground: rightLayout.palette.contentBg,
    paintLine(index, trailingWidth = 0) {
      const leftLine = leftLayout.lines[index] ?? {
        gutterText: " ".repeat(leftLayout.gutterWidth),
        spans: [],
      };
      const rightLine = rightLayout.lines[index] ?? {
        gutterText: " ".repeat(rightLayout.gutterWidth),
        spans: [],
      };
      let styledRow: StyledText;
      if (
        !isChunkCompatibleWrappedHighlight(leftHighlight) ||
        !isChunkCompatibleWrappedHighlight(rightHighlight)
      ) {
        styledRow = styledTextFromSpanNodes([
          renderWrappedSplitCellLine(
            leftLine,
            leftLayout.palette,
            layout.left.contentWidth,
            theme,
            `${row.key}:left:${index}`,
            leftPrefix,
            leftHighlight,
            0,
          ),
          renderWrappedSplitCellLine(
            rightLine,
            rightLayout.palette,
            layout.right.contentWidth,
            theme,
            `${row.key}:right:${index}`,
            rightPrefix,
            rightHighlight,
            layout.left.width,
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
          layout.left.contentWidth,
          theme,
          leftPrefix,
          leftHighlight,
        );
        appendWrappedCellChunks(
          chunks,
          rightLine,
          rightLayout.palette,
          layout.right.contentWidth,
          theme,
          rightPrefix,
          rightHighlight,
        );
        appendNoteGuideChunk(chunks, guideOnNewSide, theme);
        styledRow = new StyledText(chunks);
      }
      appendTrailingChunks(styledRow, trailingWidth, rightLayout.palette.contentBg);
      return styledRow;
    },
  };
}

interface WrappedStackCodeCellOptions extends Omit<
  NowrapStackCodeCellOptions,
  "horizontalOffset"
> {}

/** Build a wrapped stack-row painter whose line count and chunks share one wrapped layout. */
function createWrappedStackCodeCell({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  theme,
  prefix,
  highlight,
  guideOnNewSide,
}: WrappedStackCodeCellOptions): WrappedCodeCells {
  const wrapped = buildWrappedStackCell(
    row.cell,
    layout.cell,
    lineNumberDigits,
    showLineNumbers,
    theme,
  );

  return {
    lineCount: wrapped.lines.length,
    contentBackground: wrapped.palette.contentBg,
    paintLine(index, trailingWidth = 0) {
      const line = wrapped.lines[index]!;
      let styledRow: StyledText;
      if (isChunkCompatibleWrappedHighlight(highlight)) {
        const chunks: TextChunk[] = [];
        appendWrappedCellChunks(
          chunks,
          line,
          wrapped.palette,
          layout.cell.contentWidth,
          theme,
          prefix,
          highlight,
        );
        appendNoteGuideChunk(chunks, guideOnNewSide, theme);
        styledRow = new StyledText(chunks);
      } else {
        styledRow = styledTextFromSpanNodes([
          renderWrappedStackCellLine(
            line,
            wrapped.palette,
            layout.cell.contentWidth,
            theme,
            `${row.key}:stack:${index}`,
            prefix,
            highlight,
          ),
          guideOnNewSide ? (
            <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
              │
            </span>
          ) : null,
        ]);
      }
      appendTrailingChunks(styledRow, trailingWidth, wrapped.palette.contentBg);
      return styledRow;
    },
  };
}

/** Append fixed background padding to an already-painted wrapped row. */
function appendTrailingChunks(content: StyledText, width: number, background: string) {
  if (width <= 0) return;
  content.chunks.push({
    __isChunk: true,
    text: " ".repeat(width),
    bg: styledTextColor(background),
  });
}

/** Return cached OpenTUI content for an independently mounted code-cell spacer. */
function spacerContent(width: number, background: string) {
  const cacheKey = `${width}:${background}`;
  let content = addNoteSpacerContentCache.get(cacheKey);
  if (!content) {
    content = new StyledText([
      {
        __isChunk: true,
        text: " ".repeat(width),
        bg: styledTextColor(background),
      },
    ]);
    addNoteSpacerContentCache.set(cacheKey, content);
  }
  return content;
}

/** Expose the focused code-cell painting boundary used by the review-row renderer. */
export const codeCellView = {
  applyLineHighlights: withRowLineHighlights,
  createWrappedSplit: createWrappedSplitCodeCells,
  createWrappedStack: createWrappedStackCodeCell,
  renderNowrapSplit: renderNowrapSplitCodeCells,
  renderNowrapStack: renderNowrapStackCodeCell,
  spacerContent,
};
