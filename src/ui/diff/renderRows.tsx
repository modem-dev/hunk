import { memo, type ReactNode } from "react";
import type { DiffFile } from "../../core/types";
import type { AppTheme } from "../themes";
import {
  resolveSplitCellGeometry,
  resolveSplitPaneWidths,
  resolveStackCellGeometry,
} from "./codeColumns";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./pierre";

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

/** Parse a hex color string into RGB components. */
function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Blend a color toward a background at a given ratio (0 = bg, 1 = fg). */
function blendHex(fg: string, bg: string, ratio: number) {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const mix = (a: number, z: number) => Math.round(z + (a - z) * ratio);
  const r = mix(f.r, b.r);
  const g = mix(f.g, b.g);
  const bl = mix(f.b, b.b);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0")}`;
}

const INACTIVE_RAIL_BLEND = 0.35;

/** Dim a rail color for inactive hunks by blending toward the panel background. */
function dimRailColor(color: string, theme: AppTheme) {
  return blendHex(color, theme.panel, INACTIVE_RAIL_BLEND);
}

/** The rail marker is always visible. */
function marker() {
  return "▌";
}

/** Return the neutral active-hunk rail color for the current theme. */
function neutralRailColor(theme: AppTheme) {
  return theme.lineNumberFg;
}

/** Pick the stack-view rail color for one rendered row. */
function stackRailColor(kind: StackLineCell["kind"], theme: AppTheme, selected: boolean) {
  let color: string;

  if (kind === "addition") {
    color = theme.addedSignColor;
  } else if (kind === "deletion") {
    color = theme.removedSignColor;
  } else {
    color = neutralRailColor(theme);
  }

  return selected ? color : dimRailColor(color, theme);
}

/** Pick the left split-view rail color from the old-side cell state. */
function splitLeftRailColor(kind: SplitLineCell["kind"], theme: AppTheme, selected: boolean) {
  const color = kind === "deletion" ? theme.removedSignColor : neutralRailColor(theme);
  return selected ? color : dimRailColor(color, theme);
}

/** Pick the right split-view rail color from the new-side cell state. */
function splitRightRailColor(kind: SplitLineCell["kind"], theme: AppTheme, selected: boolean) {
  const color = kind === "addition" ? theme.addedSignColor : neutralRailColor(theme);
  return selected ? color : dimRailColor(color, theme);
}

/** Pick split-view colors from the semantic diff cell kind. */
function splitCellPalette(kind: SplitLineCell["kind"], theme: AppTheme) {
  if (kind === "addition") {
    return {
      gutterBg: theme.addedBg,
      contentBg: theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: theme.removedBg,
      contentBg: theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  if (kind === "empty") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.panelAlt,
      signColor: theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

/** Pick stack-view colors from the semantic diff cell kind. */
function stackCellPalette(kind: StackLineCell["kind"], theme: AppTheme) {
  if (kind === "addition") {
    return {
      gutterBg: theme.addedBg,
      contentBg: theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: theme.removedBg,
      contentBg: theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

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
  const oldNumber = cell.oldLineNumber
    ? String(cell.oldLineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);
  const newNumber = cell.newLineNumber
    ? String(cell.newLineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);
  const firstGutterText = (
    showLineNumbers ? `${oldNumber} ${newNumber} ${cell.sign}` : `${cell.sign} `
  ).padEnd(gutterWidth);
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

  const oldNumber = cell.oldLineNumber
    ? String(cell.oldLineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);
  const newNumber = cell.newLineNumber
    ? String(cell.newLineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);

  return (
    <>
      {prefix ? (
        <span key={`${keyPrefix}:prefix`} fg={prefix.fg} bg={prefix.bg}>
          {prefix.text}
        </span>
      ) : null}
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {(showLineNumbers ? `${oldNumber} ${newNumber} ${cell.sign}` : `${cell.sign} `).padEnd(
          gutterWidth,
        )}
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

  if (file.metadata.type === "new") {
    return "No textual hunks. The file is marked as new.";
  }

  if (file.metadata.type === "deleted") {
    return "No textual hunks. The file is marked as deleted.";
  }

  return "No textual hunks to render for this file.";
}

/** Render collapsed and hunk-header rows, including the optional AI badge target. */
function renderHeaderRow(
  row: Extract<DiffRow, { type: "collapsed" | "hunk-header" }>,
  width: number,
  theme: AppTheme,
  selected: boolean,
  annotated: boolean,
  anchorId?: string,
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
) {
  const badgeText = annotated ? "[AI]" : "";
  const badgeWidth = annotated ? badgeText.length + 1 : 0;
  const label =
    row.type === "collapsed"
      ? fitText(`··· ${row.text} ···`, Math.max(0, width - 1 - badgeWidth))
      : fitText(row.text, Math.max(0, width - 1 - badgeWidth));

  if (!annotated) {
    return (
      <box
        key={row.key}
        id={anchorId}
        style={{
          width: "100%",
          height: 1,
          backgroundColor: theme.panelAlt,
        }}
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
      <box
        style={{ width: badgeWidth, height: 1 }}
        onMouseUp={() => onOpenAgentNotesAtHunk?.(row.hunkIndex)}
      >
        <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>{` ${badgeText}`}</text>
      </box>
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
  annotated: boolean,
  anchorId?: string,
  noteGuideSide?: "old" | "new",
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
) {
  let baseRow: ReactNode;

  if (row.type === "collapsed") {
    baseRow = renderHeaderRow(
      row,
      width,
      theme,
      selected,
      annotated,
      anchorId,
      onOpenAgentNotesAtHunk,
    );
  } else if (row.type === "hunk-header") {
    baseRow = showHunkHeaders
      ? renderHeaderRow(row, width, theme, selected, annotated, anchorId, onOpenAgentNotesAtHunk)
      : null;
  } else if (row.type === "split-line") {
    const guideOnOldSide = noteGuideSide === "old";
    const guideOnNewSide = noteGuideSide === "new";

    // Reserve fixed columns for the diff rails and center separator slot.
    const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
    const rightRenderWidth = Math.max(0, rightWidth - (guideOnNewSide ? 1 : 0));
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
        <box id={anchorId} style={{ width: "100%", height: 1 }}>
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

            return (
              <box key={`${row.key}:wrap:${index}`} style={{ width: "100%", height: 1 }}>
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
            );
          })}
        </box>
      );
    }
  } else if (row.type === "stack-line") {
    const guideOnOldSide = noteGuideSide === "old";
    const guideOnNewSide = noteGuideSide === "new";
    const contentWidth = Math.max(0, width - (guideOnNewSide ? 1 : 0));
    const prefix = {
      text: guideOnOldSide ? "│" : marker(),
      fg: guideOnOldSide ? theme.noteBorder : stackRailColor(row.cell.kind, theme, selected),
      bg: theme.panel,
    };

    if (!wrapLines) {
      baseRow = (
        <box id={anchorId} style={{ width: "100%", height: 1 }}>
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
          {layout.lines.map((line, index) => (
            <box key={`${row.key}:wrap:${index}`} style={{ width: "100%", height: 1 }}>
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
          ))}
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
  annotated: boolean;
  anchorId?: string;
  noteGuideSide?: "old" | "new";
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
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
    annotated,
    anchorId,
    noteGuideSide,
    onOpenAgentNotesAtHunk,
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
      annotated,
      anchorId,
      noteGuideSide,
      onOpenAgentNotesAtHunk,
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
      previous.annotated === next.annotated &&
      previous.anchorId === next.anchorId &&
      previous.noteGuideSide === next.noteGuideSide
    );
  },
);
