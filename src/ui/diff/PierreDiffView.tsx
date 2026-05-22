import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, LayoutMode, UserNoteLineTarget } from "../../core/types";
import { AgentInlineNote } from "../components/panes/AgentInlineNote";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import type { CopySelectedRowRange } from "../components/panes/copySelection";
import type { DiffSectionGeometry } from "../lib/diffSectionGeometry";
import { reviewRowId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { findMaxLineNumber } from "./codeColumns";
import { buildSplitRows, buildStackRows, type DiffRow } from "./pierre";
import { plannedReviewRowVisible } from "./plannedReviewRows";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { resolveVisiblePlannedRowWindow, type VisibleBodyBounds } from "./rowWindowing";
import { diffMessage, DiffRowView, fitText } from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];
const ADD_NOTE_IDLE_HIDE_DELAY_MS = 2000;

export interface ActiveAddNoteAffordance {
  hunkIndex: number;
  target?: UserNoteLineTarget;
}

/** Resolve the note insertion target represented by a visible add-note affordance. */
function addNoteAffordanceForRow(row: DiffRow): ActiveAddNoteAffordance {
  if (row.type === "split-line") {
    return {
      hunkIndex: row.hunkIndex,
      target:
        row.right.lineNumber !== undefined
          ? { side: "new", line: row.right.lineNumber }
          : row.left.lineNumber !== undefined
            ? { side: "old", line: row.left.lineNumber }
            : undefined,
    };
  }

  if (row.type === "stack-line") {
    return {
      hunkIndex: row.hunkIndex,
      target:
        row.cell.newLineNumber !== undefined
          ? { side: "new", line: row.cell.newLineNumber }
          : row.cell.oldLineNumber !== undefined
            ? { side: "old", line: row.cell.oldLineNumber }
            : undefined,
    };
  }

  return { hunkIndex: row.hunkIndex };
}

/** Render a file diff in split or stack mode, with inline agent notes inserted between diff rows. */
export function PierreDiffView({
  codeHorizontalOffset = 0,
  copySelectedRowRanges,
  copySelectedSide,
  file,
  layout,
  onHover,
  onActiveAddNoteAffordanceChange,
  onStartUserNoteAtHunk,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  hoverActive = true,
  hoverClearSignal = 0,
  width,
  selectedHunkIndex,
  sectionGeometry,
  shouldLoadHighlight = true,
  scrollable = true,
  visibleBodyBounds,
}: {
  codeHorizontalOffset?: number;
  copySelectedRowRanges?: Map<string, CopySelectedRowRange>;
  copySelectedSide?: "left" | "right";
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onHover?: () => void;
  onActiveAddNoteAffordanceChange?: (affordance: ActiveAddNoteAffordance | null) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  hoverActive?: boolean;
  hoverClearSignal?: number;
  width: number;
  selectedHunkIndex: number;
  sectionGeometry?: DiffSectionGeometry;
  shouldLoadHighlight?: boolean;
  scrollable?: boolean;
  visibleBodyBounds?: VisibleBodyBounds;
}) {
  const renderer = useRenderer();
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const hoverIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousHoverClearSignalRef = useRef(hoverClearSignal);

  const clearHoverIdleTimeout = useCallback(() => {
    if (hoverIdleTimeoutRef.current) {
      clearTimeout(hoverIdleTimeoutRef.current);
      hoverIdleTimeoutRef.current = null;
    }
  }, []);

  const clearHoveredRow = useCallback(() => {
    clearHoverIdleTimeout();
    setHoveredRowKey(null);
    onActiveAddNoteAffordanceChange?.(null);
  }, [clearHoverIdleTimeout, onActiveAddNoteAffordanceChange]);

  const activateHoveredRow = useCallback(
    (rowKey: string, affordance: ActiveAddNoteAffordance) => {
      setHoveredRowKey(rowKey);
      onActiveAddNoteAffordanceChange?.(affordance);
      clearHoverIdleTimeout();
      hoverIdleTimeoutRef.current = setTimeout(() => {
        setHoveredRowKey((current) => (current === rowKey ? null : current));
        onActiveAddNoteAffordanceChange?.(null);
        hoverIdleTimeoutRef.current = null;
      }, ADD_NOTE_IDLE_HIDE_DELAY_MS);
    },
    [clearHoverIdleTimeout, onActiveAddNoteAffordanceChange],
  );

  useEffect(() => {
    if (!hoverActive) {
      clearHoveredRow();
    }
  }, [clearHoveredRow, hoverActive]);

  useEffect(() => {
    if (previousHoverClearSignalRef.current === hoverClearSignal) {
      return;
    }

    previousHoverClearSignalRef.current = hoverClearSignal;
    clearHoveredRow();
  }, [clearHoveredRow, hoverClearSignal]);

  useEffect(() => {
    /** Hide hover-only affordances when terminal focus leaves Hunk. */
    renderer.on("blur", clearHoveredRow);
    return () => {
      renderer.off("blur", clearHoveredRow);
    };
  }, [clearHoveredRow, renderer]);

  useEffect(() => clearHoverIdleTimeout, [clearHoverIdleTimeout]);

  const resolvedHighlighted = useHighlightedDiff({
    file,
    appearance: theme.appearance,
    shouldLoadHighlight,
  });

  const rows = useMemo(
    () =>
      file
        ? layout === "split"
          ? buildSplitRows(file, resolvedHighlighted, theme)
          : buildStackRows(file, resolvedHighlighted, theme)
        : [],
    [file, layout, resolvedHighlighted, theme],
  );
  const plannedRows = useMemo(
    () =>
      file
        ? buildReviewRenderPlan({
            fileId: file.id,
            rows,
            showHunkHeaders,
            visibleAgentNotes,
          })
        : [],
    [file, rows, showHunkHeaders, visibleAgentNotes],
  );
  const lineNumberDigits = useMemo(() => String(file ? findMaxLineNumber(file) : 1).length, [file]);
  const visiblePlannedRowWindow = useMemo(() => {
    // Fall back to the full row list unless all three row-windowing inputs are ready:
    // - the complete planned row stream for this file
    // - measured per-row geometry for that same stream
    // - one file-local visible body slice from DiffPane
    // The helper relies on those structures staying in lockstep, so any missing input means
    // "render everything" instead of risking a mismatched partial slice.
    if (!sectionGeometry || !visibleBodyBounds) {
      return {
        bottomSpacerHeight: 0,
        plannedRows,
        topSpacerHeight: 0,
      };
    }

    // `visibleBodyBounds` is already relative to this file body, not the whole review stream.
    // Example: if DiffPane says "mount rows 120..260 within package-lock.json", this helper keeps
    // only the planned rows whose measured bounds overlap that interval.
    //
    // The return value is not just the sliced rows. It also includes spacer heights for the skipped
    // region above and below so the file still occupies its original total body height inside the
    // scroll stream. That lets navigation, sticky headers, and reveal math keep using the same
    // absolute geometry even though most rows are temporarily unmounted.
    return resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds,
    });
  }, [plannedRows, sectionGeometry, visibleBodyBounds]);

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

  const content = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {visiblePlannedRowWindow.topSpacerHeight > 0 ? (
        // Reserve the skipped height above the mounted slice so the file body keeps its original
        // absolute row positions inside the larger review stream.
        <box
          style={{
            width: "100%",
            height: visiblePlannedRowWindow.topSpacerHeight,
            backgroundColor: theme.panel,
          }}
        />
      ) : null}
      {visiblePlannedRowWindow.plannedRows.map((plannedRow) => {
        // Mirror the same visibility/id decisions used by the scroll-bound helpers so the mounted
        // tree can be measured by hunk later.
        const rowId = reviewRowId(plannedRow.key);
        const visible = plannedReviewRowVisible(plannedRow, {
          showHunkHeaders,
          layout,
          width,
        });

        if (!visible) {
          return null;
        }

        if (plannedRow.kind === "inline-note") {
          return (
            <box
              key={plannedRow.key}
              id={rowId}
              style={{ width: "100%", flexDirection: "column" }}
              onMouseOver={clearHoveredRow}
            >
              <AgentInlineNote
                annotation={plannedRow.annotation}
                anchorSide={plannedRow.anchorSide}
                draft={plannedRow.note.draft}
                file={file}
                layout={layout}
                noteCount={plannedRow.noteCount}
                noteIndex={plannedRow.noteIndex}
                onClose={plannedRow.note.onRemove}
                theme={theme}
                width={width}
              />
            </box>
          );
        }

        return (
          <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
            <DiffRowView
              row={plannedRow.row}
              width={width}
              lineNumberDigits={lineNumberDigits}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              codeHorizontalOffset={codeHorizontalOffset}
              theme={theme}
              selected={plannedRow.row.hunkIndex === selectedHunkIndex}
              copySelectedRowRange={copySelectedRowRanges?.get(plannedRow.key)}
              copySelectedSide={copySelectedSide}
              anchorId={plannedRow.anchorId}
              noteGuideSide={plannedRow.noteGuideSide}
              showAddNoteBadge={hoveredRowKey === plannedRow.key && Boolean(onStartUserNoteAtHunk)}
              onHoverRow={() => {
                onHover?.();
                activateHoveredRow(plannedRow.key, addNoteAffordanceForRow(plannedRow.row));
              }}
              onStartUserNoteAtHunk={onStartUserNoteAtHunk}
            />
          </box>
        );
      })}
      {visiblePlannedRowWindow.bottomSpacerHeight > 0 ? (
        // Mirror that reservation below the mounted slice so total file-body height stays stable.
        <box
          style={{
            width: "100%",
            height: visiblePlannedRowWindow.bottomSpacerHeight,
            backgroundColor: theme.panel,
          }}
        />
      ) : null}
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
