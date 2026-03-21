import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentAnnotation, DiffFile, LayoutMode } from "../../core/types";
import { AgentCard } from "../components/panes/AgentCard";
import { annotationLocationLabel, type VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { AppTheme } from "../themes";
import {
  buildSplitRows,
  buildStackRows,
  loadHighlightedDiff,
  type DiffRow,
  type HighlightedDiffCode,
  type RenderSpan,
  type SplitLineCell,
  type StackLineCell,
} from "./pierre";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];
const SHARED_HIGHLIGHTED_DIFF_CACHE = new Map<string, HighlightedDiffCode>();
const SHARED_HIGHLIGHT_PROMISES = new Map<string, Promise<HighlightedDiffCode>>();

/** Clamp a label to one terminal row with an ellipsis. */
function fitText(text: string, width: number) {
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

/** Trim styled spans to a fixed width while preserving color runs. */
function trimSpans(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return {
      spans: [] as RenderSpan[],
      usedWidth: 0,
    };
  }

  const trimmed: RenderSpan[] = [];
  let remaining = width;
  let usedWidth = 0;

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    const text = span.text.slice(0, remaining);
    if (text.length === 0) {
      continue;
    }

    const nextSpan = {
      ...span,
      text,
    };

    const previous = trimmed.at(-1);
    if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
      previous.text += nextSpan.text;
    } else {
      trimmed.push(nextSpan);
    }

    remaining -= text.length;
    usedWidth += text.length;
  }

  return {
    spans: trimmed,
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
) {
  const { spans: trimmed, usedWidth } = trimSpans(spans, width);
  let padding = Math.max(0, width - usedWidth);

  if (padding > 0) {
    const lastSpan = trimmed.at(-1);

    // Fold trailing padding into the last span when the colors already match.
    // That keeps the output identical while avoiding one extra rendered span.
    if (lastSpan && (lastSpan.fg ?? fallbackColor) === fallbackColor && (lastSpan.bg ?? fallbackBg) === fallbackBg) {
      lastSpan.text += " ".repeat(padding);
      padding = 0;
    }
  }

  return (
    <>
      {trimmed.map((span, index) => (
        <span key={`${keyPrefix}:${index}`} fg={span.fg ?? fallbackColor} bg={span.bg ?? fallbackBg}>
          {span.text}
        </span>
      ))}
      {padding > 0 ? <span key={`${keyPrefix}:padding`} fg={fallbackColor} bg={fallbackBg}>{`${" ".repeat(padding)}`}</span> : null}
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
  const availableWidth = Math.max(0, width - prefixWidth);
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? lineNumberDigits + 3 : 2);
  const contentWidth = Math.max(0, availableWidth - gutterWidth);
  const firstGutterText = showLineNumbers
    ? `${cell.lineNumber ? String(cell.lineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits)} ${cell.sign}`.padEnd(gutterWidth)
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
  const availableWidth = Math.max(0, width - prefixWidth);
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? lineNumberDigits * 2 + 5 : 2);
  const contentWidth = Math.max(0, availableWidth - gutterWidth);
  const oldNumber = cell.oldLineNumber ? String(cell.oldLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);
  const newNumber = cell.newLineNumber ? String(cell.newLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);
  const firstGutterText = (showLineNumbers ? `${oldNumber} ${newNumber} ${cell.sign}` : `${cell.sign} `).padEnd(gutterWidth);
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
  prefix?: {
    text: string;
    fg: string;
    bg: string;
  },
) {
  const palette = splitCellPalette(cell.kind, theme);
  const prefixWidth = prefix?.text.length ?? 0;
  const availableWidth = Math.max(0, width - prefixWidth);
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? lineNumberDigits + 3 : 2);
  const contentWidth = Math.max(0, availableWidth - gutterWidth);
  const gutterText = showLineNumbers
    ? `${cell.lineNumber ? String(cell.lineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits)} ${cell.sign}`.padEnd(gutterWidth)
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
      {renderInlineSpans(cell.spans, contentWidth, theme.text, palette.contentBg, `${keyPrefix}:content`)}
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
  prefix?: {
    text: string;
    fg: string;
    bg: string;
  },
) {
  const palette = stackCellPalette(cell.kind, theme);
  const prefixWidth = prefix?.text.length ?? 0;
  const availableWidth = Math.max(0, width - prefixWidth);
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? lineNumberDigits * 2 + 5 : 2);
  const contentWidth = Math.max(0, availableWidth - gutterWidth);

  const oldNumber = cell.oldLineNumber ? String(cell.oldLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);
  const newNumber = cell.newLineNumber ? String(cell.newLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);

  return (
    <>
      {prefix ? (
        <span key={`${keyPrefix}:prefix`} fg={prefix.fg} bg={prefix.bg}>
          {prefix.text}
        </span>
      ) : null}
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {(showLineNumbers ? `${oldNumber} ${newNumber} ${cell.sign}` : `${cell.sign} `).padEnd(gutterWidth)}
      </span>
      {renderInlineSpans(cell.spans, contentWidth, theme.text, palette.contentBg, `${keyPrefix}:content`)}
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
      {renderInlineSpans(line.spans, contentWidth, theme.text, palette.contentBg, `${keyPrefix}:content`)}
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
      {renderInlineSpans(line.spans, contentWidth, theme.text, palette.contentBg, `${keyPrefix}:content`)}
    </>
  );
}

/** Explain why a file still appears in the review stream even when it has no textual hunks. */
function diffMessage(file: DiffFile) {
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

/** Find the widest line-number column needed for this file. */
function findMaxLineNumber(file: DiffFile) {
  let highest = 0;

  for (const hunk of file.metadata.hunks) {
    highest = Math.max(highest, hunk.deletionStart + hunk.deletionCount, hunk.additionStart + hunk.additionCount);
  }

  return Math.max(highest, 1);
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
          <span fg={selected ? neutralRailColor(theme) : dimRailColor(neutralRailColor(theme), theme)} bg={theme.panelAlt}>
            {marker()}
          </span>
          <span fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral} bg={theme.panelAlt}>
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
          <span fg={selected ? neutralRailColor(theme) : dimRailColor(neutralRailColor(theme), theme)} bg={theme.panelAlt}>
            {marker()}
          </span>
          <span fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral} bg={theme.panelAlt}>
            {label}
          </span>
        </text>
      </box>
      <box style={{ width: badgeWidth, height: 1 }} onMouseUp={() => onOpenAgentNotesAtHunk?.(row.hunkIndex)}>
        <text fg={theme.accent}>{badgeText}</text>
      </box>
    </box>
  );
}

/** Resolve the visual anchor line for an annotation when one exists. */
function noteAnchor(annotation: AgentAnnotation) {
  if (annotation.newRange) {
    return {
      side: "new" as const,
      lineNumber: annotation.newRange[0],
    };
  }

  if (annotation.oldRange) {
    return {
      side: "old" as const,
      lineNumber: annotation.oldRange[0],
    };
  }

  return null;
}

/** Check whether a rendered row is the visual anchor for a note. */
function rowMatchesNote(row: Extract<DiffRow, { type: "split-line" | "stack-line" }>, note: VisibleAgentNote) {
  const anchor = noteAnchor(note.annotation);
  if (!anchor) {
    return false;
  }

  if (row.type === "split-line") {
    return anchor.side === "new" ? row.right.lineNumber === anchor.lineNumber : row.left.lineNumber === anchor.lineNumber;
  }

  return anchor.side === "new" ? row.cell.newLineNumber === anchor.lineNumber : row.cell.oldLineNumber === anchor.lineNumber;
}

/** Attach visible notes to rows in the selected hunk, falling back to the first visible row when needed. */
function buildAnchoredNotes(rows: DiffRow[], visibleAgentNotes: VisibleAgentNote[], selectedHunkIndex: number, showHunkHeaders: boolean) {
  const anchoredNotes = new Map<string, VisibleAgentNote[]>();

  if (visibleAgentNotes.length === 0 || selectedHunkIndex < 0) {
    return anchoredNotes;
  }

  const selectedHunkRows = rows.filter((row) => row.hunkIndex === selectedHunkIndex);
  const lineRows = selectedHunkRows.filter(
    (row): row is Extract<DiffRow, { type: "split-line" | "stack-line" }> => row.type === "split-line" || row.type === "stack-line",
  );
  const headerRow = selectedHunkRows.find((row) => row.type === "hunk-header");
  const firstVisibleRow = showHunkHeaders ? headerRow ?? lineRows[0] : lineRows[0] ?? headerRow;

  for (const note of visibleAgentNotes) {
    const anchorRow = lineRows.find((row) => rowMatchesNote(row, note));
    const targetKey = anchorRow?.key ?? firstVisibleRow?.key;
    if (!targetKey) {
      continue;
    }

    const current = anchoredNotes.get(targetKey) ?? [];
    current.push(note);
    anchoredNotes.set(targetKey, current);
  }

  return anchoredNotes;
}

/** Render the visible note cards anchored near their target rows. */
function renderAnchoredNotes(
  anchoredNotes: VisibleAgentNote[],
  file: DiffFile,
  width: number,
  theme: AppTheme,
  onDismissAgentNote?: (id: string) => void,
) {
  if (anchoredNotes.length === 0) {
    return null;
  }

  const noteWidth = Math.min(Math.max(28, Math.floor(width * 0.46)), Math.max(28, width - 6));

  return (
    <box
      style={{
        width: "100%",
        flexDirection: "column",
        gap: 1,
        paddingRight: 2,
        alignItems: "flex-end",
      }}
    >
      {anchoredNotes.map((note) => (
        <AgentCard
          key={note.id}
          locationLabel={annotationLocationLabel(file, note.annotation)}
          rationale={note.annotation.rationale}
          summary={note.annotation.summary}
          theme={theme}
          width={noteWidth}
          onClose={onDismissAgentNote ? () => onDismissAgentNote(note.id) : undefined}
        />
      ))}
    </box>
  );
}

/** Render one diff row plus any visible note cards anchored to it. */
function renderRow(
  row: DiffRow,
  file: DiffFile,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  showHunkHeaders: boolean,
  wrapLines: boolean,
  theme: AppTheme,
  selected: boolean,
  annotated: boolean,
  anchoredNotes: VisibleAgentNote[],
  anchorId?: string,
  onDismissAgentNote?: (id: string) => void,
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
) {
  let baseRow: ReactNode;

  if (row.type === "collapsed") {
    baseRow = renderHeaderRow(row, width, theme, selected, annotated, anchorId, onOpenAgentNotesAtHunk);
  } else if (row.type === "hunk-header") {
    baseRow = showHunkHeaders ? renderHeaderRow(row, width, theme, selected, annotated, anchorId, onOpenAgentNotesAtHunk) : null;
  } else if (row.type === "split-line") {
    const markerWidth = 1;
    const separatorWidth = 1;

    // Reserve fixed columns for the left rail and center separator slot.
    // Active-hunk rows recolor that separator slot as the right-side rail without changing width.
    const usableWidth = Math.max(0, width - markerWidth - separatorWidth);
    const leftWidth = Math.max(0, markerWidth + Math.floor(usableWidth / 2));
    const rightWidth = Math.max(0, separatorWidth + usableWidth - Math.floor(usableWidth / 2));
    const leftPrefix = {
      text: marker(),
      fg: splitLeftRailColor(row.left.kind, theme, selected),
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
            {renderSplitCell(row.left, leftWidth, lineNumberDigits, showLineNumbers, theme, `${row.key}:left`, leftPrefix)}
            {renderSplitCell(row.right, rightWidth, lineNumberDigits, showLineNumbers, theme, `${row.key}:right`, rightPrefix)}
          </text>
        </box>
      );
    } else {
      const leftLayout = buildWrappedSplitCell(row.left, leftWidth, lineNumberDigits, showLineNumbers, leftPrefix.text.length, theme);
      const rightLayout = buildWrappedSplitCell(row.right, rightWidth, lineNumberDigits, showLineNumbers, rightPrefix.text.length, theme);
      const leftContentWidth = Math.max(0, leftWidth - leftPrefix.text.length - leftLayout.gutterWidth);
      const rightContentWidth = Math.max(0, rightWidth - rightPrefix.text.length - rightLayout.gutterWidth);
      const visualLineCount = Math.max(leftLayout.lines.length, rightLayout.lines.length);

      baseRow = (
        <box id={anchorId} style={{ width: "100%", flexDirection: "column" }}>
          {Array.from({ length: visualLineCount }, (_, index) => {
            const leftLine = leftLayout.lines[index] ?? { gutterText: " ".repeat(leftLayout.gutterWidth), spans: [] };
            const rightLine = rightLayout.lines[index] ?? { gutterText: " ".repeat(rightLayout.gutterWidth), spans: [] };

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
                </text>
              </box>
            );
          })}
        </box>
      );
    }
  } else if (row.type === "stack-line") {
    const prefix = {
      text: marker(),
      fg: stackRailColor(row.cell.kind, theme, selected),
      bg: theme.panel,
    };

    if (!wrapLines) {
      baseRow = (
        <box id={anchorId} style={{ width: "100%", height: 1 }}>
          <text>{renderStackCell(row.cell, width, lineNumberDigits, showLineNumbers, theme, `${row.key}:stack`, prefix)}</text>
        </box>
      );
    } else {
      const layout = buildWrappedStackCell(row.cell, width, lineNumberDigits, showLineNumbers, prefix.text.length, theme);
      const contentWidth = Math.max(0, width - prefix.text.length - layout.gutterWidth);

      baseRow = (
        <box id={anchorId} style={{ width: "100%", flexDirection: "column" }}>
          {layout.lines.map((line, index) => (
            <box key={`${row.key}:wrap:${index}`} style={{ width: "100%", height: 1 }}>
              <text>{renderWrappedStackCellLine(line, layout.palette, contentWidth, theme, `${row.key}:stack:${index}`, prefix)}</text>
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

  // Most rows do not have note cards, so keep the common path as small as possible.
  if (anchoredNotes.length === 0) {
    return baseRow;
  }

  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {baseRow}
      {renderAnchoredNotes(anchoredNotes, file, width, theme, onDismissAgentNote)}
    </box>
  );
}

interface DiffRowViewProps {
  row: DiffRow;
  file: DiffFile;
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  theme: AppTheme;
  selected: boolean;
  annotated: boolean;
  anchoredNotes: VisibleAgentNote[];
  anchorId?: string;
  onDismissAgentNote?: (id: string) => void;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
}

/** Render one diff row, memoized to avoid unnecessary rerenders. */
const DiffRowView = memo(
  function DiffRowViewComponent({
    row,
    file,
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    theme,
    selected,
    annotated,
    anchoredNotes,
    anchorId,
    onDismissAgentNote,
    onOpenAgentNotesAtHunk,
  }: DiffRowViewProps) {
    return renderRow(
      row,
      file,
      width,
      lineNumberDigits,
      showLineNumbers,
      showHunkHeaders,
      wrapLines,
      theme,
      selected,
      annotated,
      anchoredNotes,
      anchorId,
      onDismissAgentNote,
      onOpenAgentNotesAtHunk,
    );
  },
  (previous, next) => {
    // Row and anchored-note identity are intentionally stable across many navigation updates.
    return (
      previous.row === next.row &&
      previous.file === next.file &&
      previous.width === next.width &&
      previous.lineNumberDigits === next.lineNumberDigits &&
      previous.showLineNumbers === next.showLineNumbers &&
      previous.showHunkHeaders === next.showHunkHeaders &&
      previous.wrapLines === next.wrapLines &&
      previous.theme === next.theme &&
      previous.selected === next.selected &&
      previous.annotated === next.annotated &&
      previous.anchoredNotes === next.anchoredNotes &&
      previous.anchorId === next.anchorId
    );
  },
);

/** Render a file diff in split or stack mode, with optional inline agent notes. */
export function PierreDiffView({
  annotatedHunkIndices = EMPTY_ANNOTATED_HUNK_INDICES,
  file,
  layout,
  onDismissAgentNote,
  onOpenAgentNotesAtHunk,
  onHighlightReady,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  width,
  selectedHunkIndex,
  shouldLoadHighlight = true,
  scrollable = true,
}: {
  annotatedHunkIndices?: Set<number>;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onDismissAgentNote?: (id: string) => void;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
  onHighlightReady?: () => void;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  width: number;
  selectedHunkIndex: number;
  shouldLoadHighlight?: boolean;
  scrollable?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedDiffCode | null>(null);
  const [highlightedCacheKey, setHighlightedCacheKey] = useState<string | null>(null);
  const appearanceCacheKey = file ? `${theme.appearance}:${file.id}` : null;

  // Selected files load immediately; background prefetch can opt neighboring files in later.
  const pendingHighlight = useMemo(() => {
    if (!shouldLoadHighlight || !file || !appearanceCacheKey || SHARED_HIGHLIGHTED_DIFF_CACHE.has(appearanceCacheKey)) {
      return null;
    }

    const existing = SHARED_HIGHLIGHT_PROMISES.get(appearanceCacheKey);
    if (existing) {
      return existing;
    }

    const pending = loadHighlightedDiff(file, theme.appearance);
    SHARED_HIGHLIGHT_PROMISES.set(appearanceCacheKey, pending);
    return pending;
  }, [appearanceCacheKey, file, shouldLoadHighlight, theme.appearance]);

  useLayoutEffect(() => {
    if (!file || !appearanceCacheKey) {
      setHighlighted(null);
      setHighlightedCacheKey(null);
      return;
    }

    if (highlightedCacheKey === appearanceCacheKey) {
      return;
    }

    const cached = SHARED_HIGHLIGHTED_DIFF_CACHE.get(appearanceCacheKey);
    if (cached) {
      setHighlighted(cached);
      setHighlightedCacheKey(appearanceCacheKey);
      return;
    }

    if (!shouldLoadHighlight) {
      return;
    }

    let cancelled = false;
    setHighlighted(null);

    pendingHighlight
      ?.then((nextHighlighted) => {
        if (cancelled) {
          return;
        }

        SHARED_HIGHLIGHT_PROMISES.delete(appearanceCacheKey);
        SHARED_HIGHLIGHTED_DIFF_CACHE.set(appearanceCacheKey, nextHighlighted);
        setHighlighted(nextHighlighted);
        setHighlightedCacheKey(appearanceCacheKey);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        SHARED_HIGHLIGHT_PROMISES.delete(appearanceCacheKey);
        const fallback = {
          deletionLines: [],
          additionLines: [],
        } satisfies HighlightedDiffCode;
        SHARED_HIGHLIGHTED_DIFF_CACHE.set(appearanceCacheKey, fallback);
        setHighlighted(fallback);
        setHighlightedCacheKey(appearanceCacheKey);
      });

    return () => {
      cancelled = true;
    };
  }, [appearanceCacheKey, file, highlightedCacheKey, pendingHighlight, shouldLoadHighlight]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  const resolvedHighlighted =
    appearanceCacheKey && highlightedCacheKey === appearanceCacheKey
      ? highlighted
      : appearanceCacheKey
        ? (SHARED_HIGHLIGHTED_DIFF_CACHE.get(appearanceCacheKey) ?? null)
        : null;
  const notifiedHighlightKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onHighlightReady || !appearanceCacheKey || !resolvedHighlighted) {
      return;
    }

    if (notifiedHighlightKeyRef.current === appearanceCacheKey) {
      return;
    }

    notifiedHighlightKeyRef.current = appearanceCacheKey;
    onHighlightReady();
  }, [appearanceCacheKey, onHighlightReady, resolvedHighlighted]);

  if (!file) {
    return (
      <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1 }}>
        <text fg={theme.muted}>{fitText("No file selected.", Math.max(1, width - 2))}</text>
      </box>
    );
  }

  if (file.metadata.hunks.length === 0) {
    return (
      <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
        <text fg={theme.muted}>{fitText(diffMessage(file), Math.max(1, width - 2))}</text>
      </box>
    );
  }

  const rows = useMemo(
    () => (layout === "split" ? buildSplitRows(file, resolvedHighlighted, theme) : buildStackRows(file, resolvedHighlighted, theme)),
    [file, layout, resolvedHighlighted, theme],
  );
  const anchoredNotes = useMemo(
    () => buildAnchoredNotes(rows, visibleAgentNotes, selectedHunkIndex, showHunkHeaders),
    [rows, selectedHunkIndex, showHunkHeaders, visibleAgentNotes],
  );
  const hunkAnchorIds = useMemo(() => {
    const anchors = new Map<string, string>();
    const seenHunks = new Set<number>();

    for (const row of rows) {
      if (seenHunks.has(row.hunkIndex)) {
        continue;
      }

      if (showHunkHeaders) {
        if (row.type !== "hunk-header") {
          continue;
        }
      } else if (row.type === "collapsed" || row.type === "hunk-header") {
        continue;
      }

      anchors.set(row.key, diffHunkId(row.fileId, row.hunkIndex));
      seenHunks.add(row.hunkIndex);
    }

    return anchors;
  }, [rows, showHunkHeaders]);
  const lineNumberDigits = useMemo(() => String(findMaxLineNumber(file)).length, [file]);
  const content = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {rows.map((row) => (
        <DiffRowView
          key={row.key}
          row={row}
          file={file}
          width={width}
          lineNumberDigits={lineNumberDigits}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={showHunkHeaders}
          wrapLines={wrapLines}
          theme={theme}
          selected={row.hunkIndex === selectedHunkIndex}
          annotated={row.type === "hunk-header" && annotatedHunkIndices.has(row.hunkIndex)}
          anchoredNotes={anchoredNotes.get(row.key) ?? EMPTY_VISIBLE_AGENT_NOTES}
          anchorId={hunkAnchorIds.get(row.key)}
          onDismissAgentNote={onDismissAgentNote}
          onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
        />
      ))}
    </box>
  );

  if (!scrollable) {
    return content;
  }

  return (
    <scrollbox width="100%" height="100%" scrollY={true} viewportCulling={true} focused={false}>
      {content}
    </scrollbox>
  );
}
