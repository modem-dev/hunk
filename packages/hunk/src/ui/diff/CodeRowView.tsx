/** Mounts split and unified code rows from the canonical code-row layout and paint plans. */
import type { UserNoteLineTarget } from "../../core/liveComments";
import { copySelectedRangeAtVisualLine, type CopySelectedRowRange } from "../lib/diffSpatial";
import type { AppTheme } from "../themes";
import {
  CODE_ROW_ADD_NOTE_BADGE_TEXT,
  CODE_ROW_ADD_NOTE_BADGE_WIDTH,
  resolveCodeRowNoteTarget,
} from "./codeRowAffordance";
import { planCodeRowLayout, type CodeRowLayoutPlan } from "./codeRowLayout";
import { codeCellView, FULL_CODE_CELL_COL_RANGE, type CodeCellHighlight } from "./CodeCellView";
import type { CursorHighlight } from "./cursorHighlight";
import type { LineHighlightPaintIndex } from "./lineHighlightPaint";
import type { CodeDiffRow, PlannedCodeReviewRow } from "./reviewRenderPlan";
import {
  cursorLineHighlightBg,
  diffRailMarker,
  selectionHighlightBg,
  splitLeftRailColor,
  splitRightRailColor,
  unifiedRailColor,
} from "./rowStyle";
import { markNestedRowMouseAction } from "./rowMouseActions";

export interface CodeRowViewProps {
  plannedRow: PlannedCodeReviewRow;
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  theme: AppTheme;
  selected: boolean;
  copySelectedRowRange?: CopySelectedRowRange;
  copySelectedSide?: "left" | "right";
  cursorHighlight?: CursorHighlight;
  lineHighlights?: LineHighlightPaintIndex;
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
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

/** Render the hover-only add-note target as a separate clickable hit area. */
function renderAddNoteButton(
  key: string,
  theme: AppTheme,
  hunkIndex: number,
  target: UserNoteLineTarget | undefined,
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void,
  overlayColumn?: number,
) {
  return (
    <box
      key={key}
      style={{
        width: CODE_ROW_ADD_NOTE_BADGE_WIDTH,
        height: 1,
        ...(overlayColumn !== undefined
          ? { position: "absolute" as const, left: overlayColumn, top: 0 }
          : {}),
      }}
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

/** Paint one range guide in the annotation gutter immediately outside diff content. */
function renderExternalRangeGuide(key: string, width: number, theme: AppTheme) {
  return (
    <box key={key} style={{ position: "absolute", left: width, top: 0, width: 1, height: 1 }}>
      <text fg={theme.noteBorder} bg={theme.panel}>
        │
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

/** Mount one split or unified code row with selection, cursor, guide, and affordance paint. */
export function CodeRowView({
  plannedRow,
  width,
  lineNumberDigits,
  showLineNumbers,
  wrapLines,
  codeHorizontalOffset,
  theme,
  selected,
  copySelectedRowRange,
  copySelectedSide,
  cursorHighlight,
  lineHighlights,
  showAddNoteBadge = false,
  onHoverRow,
  onStartUserNoteAtHunk,
}: CodeRowViewProps) {
  // Extension marks repaint span backgrounds only; geometry inputs keep using the source row.
  const row = codeCellView.applyLineHighlights(
    plannedRow.row,
    lineHighlights,
    theme,
  ) as CodeDiffRow;
  const { anchorId } = plannedRow;
  const codeRowLayout = planCodeRowLayout(plannedRow, {
    lineNumberDigits,
    reserveAddNoteColumn: Boolean(onStartUserNoteAtHunk),
    // Nowrap rows paint the hover affordance over their trailing cells so the note guide stays
    // fixed. Wrapped rows reserve the column because overlaying continuation text would hide code.
    showAddNoteBadge: wrapLines && showAddNoteBadge,
    showLineNumbers,
    width,
    wrapLines,
  }) as CodeRowLayoutPlan;

  // A split context row shows the same source line on both halves, so marking one of them would
  // read as half a row. Change rows keep the split, since the halves are different note targets.
  const splitContextRow =
    row.type === "split-line" && row.left.kind === "context" && row.right.kind === "context";
  const onCursorRow = cursorHighlight !== undefined;
  const cursorRowHighlight: CodeCellHighlight | undefined = onCursorRow
    ? {
        bg: (baseBg) => cursorLineHighlightBg(baseBg, theme),
        colRange: cursorHighlight.style === "row" ? FULL_CODE_CELL_COL_RANGE : undefined,
      }
    : undefined;
  /** Resolve copy-selection boundaries separately for each wrapped visual line when needed. */
  const highlightsAtVisualLine =
    copySelectedRowRange || cursorRowHighlight
      ? (visualLineIndex: number) => {
          const selectedRange = copySelectedRangeAtVisualLine(
            copySelectedRowRange,
            visualLineIndex,
          );
          const lineHasSelection = selectedRange !== undefined;
          const lineSelectionHighlight: CodeCellHighlight = {
            bg: (baseBg) => selectionHighlightBg(baseBg, theme),
            colRange: selectedRange,
          };
          return {
            left: pickRowHighlight(
              lineSelectionHighlight,
              cursorRowHighlight,
              lineHasSelection && copySelectedSide !== "right",
              onCursorRow && (splitContextRow || cursorHighlight.side === "old"),
            ),
            right: pickRowHighlight(
              lineSelectionHighlight,
              cursorRowHighlight,
              lineHasSelection && copySelectedSide !== "left",
              onCursorRow && (splitContextRow || cursorHighlight.side === "new"),
            ),
            unified: pickRowHighlight(
              lineSelectionHighlight,
              cursorRowHighlight,
              lineHasSelection,
              onCursorRow,
            ),
          };
        }
      : undefined;
  const firstLineHighlights = highlightsAtVisualLine?.(0);
  const leftHighlight = firstLineHighlights?.left;
  const rightHighlight = firstLineHighlights?.right;
  const cellHighlight = firstLineHighlights?.unified;

  if (row.type === "split-line") {
    // The planner and row type are derived from the same complete planned row.
    const splitLayout = codeRowLayout as Extract<CodeRowLayoutPlan, { kind: "split" }>;
    const hasRangeGuide = splitLayout.noteGuideSide !== undefined;
    const addNoteTarget = resolveCodeRowNoteTarget(row);

    const addBadgeWidth = splitLayout.addNoteBadgeWidth;
    const leftPrefix = {
      text: diffRailMarker(),
      fg: splitLeftRailColor(row.left.kind, theme, selected),
      bg: theme.panel,
    };
    const rightPrefix = {
      text: "▌",
      fg: splitRightRailColor(row.right.kind, theme, selected),
      bg: theme.panel,
    };

    if (!wrapLines) {
      return (
        <box
          id={anchorId}
          style={{
            position: "relative",
            width: "100%",
            height: 1,
            flexDirection: "row",
            overflow: "visible",
          }}
          onMouseMove={() => onHoverRow?.(row.key)}
        >
          <box style={{ width: "100%", height: 1 }}>
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
              guideOnNewSide: false,
            })}
          </box>
          {showAddNoteBadge
            ? renderAddNoteButton(
                `${row.key}:add-note`,
                theme,
                row.hunkIndex,
                addNoteTarget,
                onStartUserNoteAtHunk,
                Math.max(0, width - CODE_ROW_ADD_NOTE_BADGE_WIDTH),
              )
            : null}
          {hasRangeGuide ? renderExternalRangeGuide(`${row.key}:range-guide`, width, theme) : null}
        </box>
      );
    }

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
      guideOnNewSide: false,
    });

    return (
      <box id={anchorId} style={{ width: "100%", flexDirection: "column", overflow: "visible" }}>
        {Array.from({ length: wrapped.lineCount }, (_, index) => {
          const showBadgeOnLine = showAddNoteBadge && index === 0;
          const styledRow = wrapped.paintLine(
            index,
            showBadgeOnLine ? 0 : addBadgeWidth,
            highlightsAtVisualLine?.(index),
          );

          if (!showBadgeOnLine && !hasRangeGuide) {
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
              style={{
                position: "relative",
                width: "100%",
                height: 1,
                flexDirection: "row",
                overflow: "visible",
              }}
              onMouseMove={() => onHoverRow?.(row.key)}
            >
              {showBadgeOnLine ? (
                <>
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
                </>
              ) : (
                <text content={styledRow} />
              )}
              {hasRangeGuide
                ? renderExternalRangeGuide(`${row.key}:range-guide:${index}`, width, theme)
                : null}
            </box>
          );
        })}
      </box>
    );
  }

  // The planner and row type are derived from the same complete planned row.
  const unifiedLayout = codeRowLayout as Extract<CodeRowLayoutPlan, { kind: "unified" }>;
  const hasRangeGuide = unifiedLayout.noteGuideSide !== undefined;
  const addNoteTarget = resolveCodeRowNoteTarget(row);
  const addBadgeWidth = unifiedLayout.addNoteBadgeWidth;
  const prefix = {
    text: diffRailMarker(),
    fg: unifiedRailColor(row.cell.kind, theme, selected),
    bg: theme.panel,
  };

  if (!wrapLines) {
    return (
      <box
        id={anchorId}
        style={{
          position: "relative",
          width: "100%",
          height: 1,
          flexDirection: "row",
          overflow: "visible",
        }}
        onMouseMove={() => onHoverRow?.(row.key)}
      >
        <box style={{ width: "100%", height: 1 }}>
          {codeCellView.renderNowrapUnified({
            row,
            layout: unifiedLayout,
            lineNumberDigits,
            showLineNumbers,
            theme,
            horizontalOffset: codeHorizontalOffset,
            prefix,
            highlight: cellHighlight,
            guideOnNewSide: false,
          })}
        </box>
        {showAddNoteBadge
          ? renderAddNoteButton(
              `${row.key}:add-note`,
              theme,
              row.hunkIndex,
              addNoteTarget,
              onStartUserNoteAtHunk,
              Math.max(0, width - CODE_ROW_ADD_NOTE_BADGE_WIDTH),
            )
          : null}
        {hasRangeGuide ? renderExternalRangeGuide(`${row.key}:range-guide`, width, theme) : null}
      </box>
    );
  }

  const wrapped = codeCellView.createWrappedUnified({
    row,
    layout: unifiedLayout,
    lineNumberDigits,
    showLineNumbers,
    theme,
    prefix,
    highlight: cellHighlight,
    guideOnNewSide: false,
  });

  return (
    <box id={anchorId} style={{ width: "100%", flexDirection: "column", overflow: "visible" }}>
      {Array.from({ length: wrapped.lineCount }, (_, index) => {
        const showBadgeOnLine = showAddNoteBadge && index === 0;
        const styledRow = wrapped.paintLine(index, 0, highlightsAtVisualLine?.(index));

        if (!showBadgeOnLine && addBadgeWidth === 0 && !hasRangeGuide) {
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
            style={{
              position: "relative",
              width: "100%",
              height: 1,
              flexDirection: "row",
              overflow: "visible",
            }}
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
            {hasRangeGuide
              ? renderExternalRangeGuide(`${row.key}:range-guide:${index}`, width, theme)
              : null}
          </box>
        );
      })}
    </box>
  );
}
