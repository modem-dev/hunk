import { memo, type ReactNode } from "react";
import type { DiffFile, UserNoteLineTarget } from "../../core/types";
import type { AppTheme } from "../themes";
import {
  resolveSplitCellGeometry,
  resolveSplitPaneWidths,
  resolveStackCellGeometry,
} from "./codeColumns";
import { displayWidth, sliceByDisplayWidth } from "./displayWidth";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./pierre";
import {
  diffRailMarker,
  dimRailColor,
  neutralRailColor,
  splitCellPalette,
  splitLeftRailColor,
  splitRightRailColor,
  stackCellPalette,
  stackGutterText,
  stackRailColor,
} from "./rowStyle";

/** Clamp a label to one terminal row with an ellipsis. */
export function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (displayWidth(text) <= width) {
    return text;
  }

  if (width === 1) {
    return "…";
  }

  return `${sliceByDisplayWidth(text, 0, width - 1).text}…`;
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

    const spanColumns = displayWidth(span.text);
    if (remainingOffset >= spanColumns) {
      remainingOffset -= spanColumns;
      continue;
    }

    const slice = sliceByDisplayWidth(span.text, remainingOffset, remaining);
    remainingOffset = 0;

    if (slice.text.length === 0) {
      // A wide grapheme straddled the window edge; the alignment-padding the
      // caller adds will cover the half-cell, so keep walking.
      remaining -= slice.trailingDropped;
      usedWidth += slice.trailingDropped;
      continue;
    }

    const nextSpan = {
      ...span,
      text: slice.text,
    };

    const previous = sliced.at(-1);
    if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
      previous.text += nextSpan.text;
    } else {
      sliced.push(nextSpan);
    }

    remaining -= slice.consumedColumns;
    usedWidth += slice.consumedColumns;
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
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(spans, horizontalOffset, width);
  let padding = Math.max(0, width - usedWidth);

  if (padding > 0) {
    const lastSpan = trimmed.at(-1);

    // Fold trailing padding into the last span when the colors already match.
    // That keeps the output identical while avoiding one extra rendered span.
    if (
      lastSpan &&
      (lastSpan.fg ?? fallbackColor) === fallbackColor &&
      (lastSpan.bg ?? fallbackBg) === fallbackBg
    ) {
      lastSpan.text += " ".repeat(padding);
      padding = 0;
    }
  }

  return (
    <>
      {trimmed.map((span, index) => (
        <span
          key={`${keyPrefix}:${index}`}
          fg={span.fg ?? fallbackColor}
          bg={span.bg ?? fallbackBg}
        >
          {span.text}
        </span>
      ))}
      {padding > 0 ? (
        <span
          key={`${keyPrefix}:padding`}
          fg={fallbackColor}
          bg={fallbackBg}
        >{`${" ".repeat(padding)}`}</span>
      ) : null}
    </>
  );
}

interface WrappedCellLine {
  gutterText: string;
  spans: RenderSpan[];
}

interface WrappedCellLayout {
  gutterWidth: number;
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

  const appendToCurrent = (span: RenderSpan, text: string) => {
    const nextSpan = { ...span, text };
    const previous = current.at(-1);
    if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
      previous.text += nextSpan.text;
    } else {
      current.push(nextSpan);
    }
  };

  for (const span of spans) {
    let pending = "";
    let pendingColumns = 0;

    const flushPending = () => {
      if (pending.length === 0) return;
      appendToCurrent(span, pending);
      remaining -= pendingColumns;
      pending = "";
      pendingColumns = 0;
    };

    for (const grapheme of span.text) {
      const w = displayWidth(grapheme);

      if (pendingColumns + w > remaining) {
        // If the current line already has content (in this span or upstream),
        // wrap. If the line is fresh AND this single grapheme exceeds `width`,
        // place it alone and accept the overflow — matches the prior
        // code-unit behavior of letting an oversized character render past
        // its cell rather than disappearing.
        if (pending.length > 0 || remaining < width) {
          flushPending();
          current = [];
          lines.push(current);
          remaining = width;
        }
      }

      pending += grapheme;
      pendingColumns += w;
    }

    flushPending();
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
  const firstGutterText = showLineNumbers
    ? `${cell.lineNumber ? String(cell.lineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits)} ${cell.sign}`.padEnd(
        gutterWidth,
      )
    : `${cell.sign} `.padEnd(gutterWidth);
  const wrappedSpans = wrapSpans(cell.spans, contentWidth);

  return {
    gutterWidth,
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
    palette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
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
) {
  const palette = splitCellPalette(cell.kind, theme);
  const prefixWidth = prefix?.text.length ?? 0;
  const { gutterWidth, contentWidth } = resolveSplitCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );
  const gutterText = showLineNumbers
    ? `${cell.lineNumber ? String(cell.lineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits)} ${cell.sign}`.padEnd(
        gutterWidth,
      )
    : `${cell.sign} `.padEnd(gutterWidth);

  return (
    <>
      {prefix ? (
        <span key={`${keyPrefix}:prefix`} fg={prefix.fg} bg={prefix.bg}>
          {prefix.text}
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
) {
  const palette = stackCellPalette(cell.kind, theme);
  const prefixWidth = prefix?.text.length ?? 0;
  const { gutterWidth, contentWidth } = resolveStackCellGeometry(
    width,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );

  return (
    <>
      {prefix ? (
        <span key={`${keyPrefix}:prefix`} fg={prefix.fg} bg={prefix.bg}>
          {prefix.text}
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
) {
  return (
    <>
      <span key={`${keyPrefix}:prefix`} fg={prefix.fg} bg={prefix.bg}>
        {prefix.text}
      </span>
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {line.gutterText}
      </span>
      {renderInlineSpans(
        line.spans,
        contentWidth,
        theme.text,
        palette.contentBg,
        `${keyPrefix}:content`,
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
) {
  return (
    <>
      <span key={`${keyPrefix}:prefix`} fg={prefix.fg} bg={prefix.bg}>
        {prefix.text}
      </span>
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {line.gutterText}
      </span>
      {renderInlineSpans(
        line.spans,
        contentWidth,
        theme.text,
        palette.contentBg,
        `${keyPrefix}:content`,
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
  anchorId?: string,
  noteGuideSide?: "old" | "new",
  showAddNoteBadge = false,
  onHoverRow?: (rowKey: string) => void,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
) {
  let baseRow: ReactNode;

  if (row.type === "collapsed") {
    baseRow = renderHeaderRow(
      row,
      width,
      theme,
      selected,
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
          selected,
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
      fg: guideOnOldSide ? theme.noteBorder : splitLeftRailColor(row.left.kind, theme, selected),
      bg: theme.panel,
    };
    const rightPrefix = {
      text: "▌",
      fg: splitRightRailColor(row.right.kind, theme, selected),
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
                    )}
                    {renderWrappedSplitCellLine(
                      rightLine,
                      rightLayout.palette,
                      rightContentWidth,
                      theme,
                      `${row.key}:right:${index}`,
                      rightPrefix,
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
      fg: guideOnOldSide ? theme.noteBorder : stackRailColor(row.cell.kind, theme, selected),
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
      previous.anchorId === next.anchorId &&
      previous.noteGuideSide === next.noteGuideSide &&
      previous.showAddNoteBadge === next.showAddNoteBadge &&
      previous.onHoverRow === next.onHoverRow &&
      previous.onStartUserNoteAtHunk === next.onStartUserNoteAtHunk
    );
  },
);
