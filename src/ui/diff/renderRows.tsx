import { memo, type ReactNode } from "react";
import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { AppTheme } from "../themes";
import { CODE_ROW_ADD_NOTE_BADGE_TEXT, CODE_ROW_ADD_NOTE_BADGE_WIDTH } from "./codeRowAffordance";
import {
  legacyPlannedDiffRow,
  planCodeRowLayout,
  type CodeRowLayoutPlan,
  type PlannedDiffReviewRow,
} from "./codeRowLayout";
import { reviewGapId } from "../../core/review/expansion";
import type { DiffRow } from "./diffRows";
import type { LineHighlightPaintIndex } from "./lineHighlightPaint";
import {
  diffRailMarker,
  dimRailColor,
  neutralRailColor,
  cursorLineHighlightBg,
  selectionHighlightBg,
  splitLeftRailColor,
  splitRightRailColor,
  stackRailColor,
} from "./rowStyle";
import { fitText } from "./plannedRowText";
import { codeCellView, FULL_CODE_CELL_COL_RANGE, type CodeCellHighlight } from "./CodeCellView";
import type { CopySelectedRowRange } from "../lib/diffSpatial";
import type { CursorLine } from "../../core/run/commandInputs";

const marker = diffRailMarker;

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

/** Choose whether copy selection or the cursor paints one half of a row. */
function pickRowHighlight(
  selection: CodeCellHighlight,
  cursor: CodeCellHighlight | undefined,
  hasSelection: boolean,
  onCursor: boolean,
) {
  if (hasSelection) return selection;
  return onCursor ? cursor : undefined;
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
          text: CODE_ROW_ADD_NOTE_BADGE_TEXT,
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
          onMouseUp={(event) => {
            markNestedRowMouseAction(event);
            badge.onClick();
          }}
        >
          <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>{` ${badge.text}`}</text>
        </box>
      ))}
    </box>
  );
}

const nestedRowMouseActions = new WeakSet<TuiMouseEvent>();

/** Mark an event so the parent completes mouse cleanup without selecting the containing line. */
export function markNestedRowMouseAction(event: TuiMouseEvent) {
  nestedRowMouseActions.add(event);
}

/** Return whether a nested control, rather than the diff line, owns this mouse event. */
export function isNestedRowMouseAction(event: TuiMouseEvent) {
  return nestedRowMouseActions.has(event);
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
      style={{ width: CODE_ROW_ADD_NOTE_BADGE_WIDTH, height: 1 }}
      onMouseUp={(event) => {
        markNestedRowMouseAction(event);
        onStartUserNoteAtHunk?.(hunkIndex, target);
      }}
    >
      <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>
        {CODE_ROW_ADD_NOTE_BADGE_TEXT}
      </text>
    </box>
  );
}

/** Fill the reserved wrapped-row hover column so row backgrounds do not visibly shrink. */
function renderAddNoteSpacer(key: string, width: number, bg: string) {
  if (width <= 0) {
    return null;
  }

  return (
    <box key={key} style={{ width, height: 1 }}>
      <text content={codeCellView.spacerContent(width, bg)} />
    </box>
  );
}

/** Render one diff row. */
function renderRow(
  plannedRow: PlannedDiffReviewRow,
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
  showAddNoteBadge = false,
  onHoverRow?: (rowKey: string) => void,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
  onToggleGap?: (gapKey: string) => void,
) {
  // Extension marks repaint span backgrounds only; geometry inputs keep using the source row.
  const row = codeCellView.applyLineHighlights(plannedRow.row, lineHighlights, theme);
  const { anchorId } = plannedRow;
  const hasCopySelection = !!copySelectedRowRange;
  const reserveAddNoteColumn = Boolean(onStartUserNoteAtHunk);
  const codeRowLayout = planCodeRowLayout(plannedRow, {
    lineNumberDigits,
    reserveAddNoteColumn,
    showAddNoteBadge,
    showLineNumbers,
    width,
    wrapLines,
  });

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
  const selectionHighlight: CodeCellHighlight = {
    bg: (baseBg) => selectionHighlightBg(baseBg, theme),
    colRange: copySelectedRowRange,
  };
  const cursorRowHighlight: CodeCellHighlight | undefined = onCursorRow
    ? {
        bg: (baseBg) => cursorLineHighlightBg(baseBg, theme),
        colRange: cursorHighlight.style === "row" ? FULL_CODE_CELL_COL_RANGE : undefined,
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
    // The planner and row type are derived from the same complete planned row.
    const splitLayout = codeRowLayout as Extract<CodeRowLayoutPlan, { kind: "split" }>;
    const guideOnOldSide = splitLayout.noteGuideSide === "old";
    const guideOnNewSide = splitLayout.noteGuideSide === "new";
    const addNoteTarget: UserNoteLineTarget | undefined =
      row.right.lineNumber !== undefined
        ? { side: "new", line: row.right.lineNumber }
        : row.left.lineNumber !== undefined
          ? { side: "old", line: row.left.lineNumber }
          : undefined;

    const addBadgeWidth = splitLayout.addNoteBadgeWidth;
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
            {codeCellView.renderNowrapSplit({
              row,
              layout: splitLayout,
              lineNumberDigits,
              showLineNumbers,
              theme,
              horizontalOffset: codeHorizontalOffset,
              leftPrefix,
              rightPrefix,
              leftHighlight,
              rightHighlight,
              guideOnNewSide,
            })}
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
      const wrapped = codeCellView.createWrappedSplit({
        row,
        layout: splitLayout,
        lineNumberDigits,
        showLineNumbers,
        theme,
        leftPrefix,
        rightPrefix,
        leftHighlight,
        rightHighlight,
        guideOnNewSide,
      });

      baseRow = (
        <box id={anchorId} style={{ width: "100%", flexDirection: "column" }}>
          {Array.from({ length: wrapped.lineCount }, (_, index) => {
            const showBadgeOnLine = showAddNoteBadge && index === 0;
            const styledRow = wrapped.paintLine(index, showBadgeOnLine ? 0 : addBadgeWidth);

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
    // The planner and row type are derived from the same complete planned row.
    const stackLayout = codeRowLayout as Extract<CodeRowLayoutPlan, { kind: "stack" }>;
    const guideOnOldSide = stackLayout.noteGuideSide === "old";
    const guideOnNewSide = stackLayout.noteGuideSide === "new";
    const addNoteTarget: UserNoteLineTarget | undefined =
      row.cell.newLineNumber !== undefined
        ? { side: "new", line: row.cell.newLineNumber }
        : row.cell.oldLineNumber !== undefined
          ? { side: "old", line: row.cell.oldLineNumber }
          : undefined;
    const addBadgeWidth = stackLayout.addNoteBadgeWidth;
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
            {codeCellView.renderNowrapStack({
              row,
              layout: stackLayout,
              lineNumberDigits,
              showLineNumbers,
              theme,
              horizontalOffset: codeHorizontalOffset,
              prefix,
              highlight: cellHighlight,
              guideOnNewSide,
            })}
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
      const wrapped = codeCellView.createWrappedStack({
        row,
        layout: stackLayout,
        lineNumberDigits,
        showLineNumbers,
        theme,
        prefix,
        highlight: cellHighlight,
        guideOnNewSide,
      });

      baseRow = (
        <box id={anchorId} style={{ width: "100%", flexDirection: "column" }}>
          {Array.from({ length: wrapped.lineCount }, (_, index) => {
            const showBadgeOnLine = showAddNoteBadge && index === 0;
            const styledRow = wrapped.paintLine(index);

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
                      wrapped.contentBackground,
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
  /** Complete review-stream row; preferred when the caller owns the shared render plan. */
  plannedRow?: PlannedDiffReviewRow;
  /** Raw row fallback for renderer-only surfaces outside the shared review stream. */
  row?: DiffRow;
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
    plannedRow,
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
    const resolvedPlannedRow =
      plannedRow ?? (row ? legacyPlannedDiffRow(row, anchorId, noteGuideSide) : undefined);
    if (!resolvedPlannedRow) {
      return null;
    }

    return renderRow(
      resolvedPlannedRow,
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
      showAddNoteBadge,
      onHoverRow,
      onStartUserNoteAtHunk,
      onToggleGap,
    );
  },
  (previous, next) => {
    return (
      previous.plannedRow === next.plannedRow &&
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
