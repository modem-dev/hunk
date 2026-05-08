import { useMemo } from "react";
import type { DiffFile, LayoutMode } from "../../core/types";
import { AgentInlineNote, AgentInlineNoteGuideCap } from "../components/panes/AgentInlineNote";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { reviewRowId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { findMaxLineNumber } from "./codeColumns";
import { buildSplitRows, buildStackRows } from "./pierre";
import { plannedReviewRowVisible } from "./plannedReviewRows";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { diffMessage, DiffRowView, fitText } from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";
import type { DiffSectionGeometry } from "../lib/diffSectionGeometry";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

/** Render a file diff in split or stack mode, with inline agent notes inserted between diff rows. */
export function PierreDiffView({
  annotatedHunkIndices = EMPTY_ANNOTATED_HUNK_INDICES,
  codeHorizontalOffset = 0,
  file,
  layout,
  onOpenAgentNotesAtHunk,
  showLineNumbers = true,
  showHunkHeaders = true,
  showStructural = false,
  wrapLines = false,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  width,
  selectedHunkIndex,
  shouldLoadHighlight = true,
  scrollable = true,
  geometry,
  viewportTop,
  viewportHeight,
}: {
  annotatedHunkIndices?: Set<number>;
  codeHorizontalOffset?: number;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  showStructural?: boolean;
  wrapLines?: boolean;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  width: number;
  selectedHunkIndex: number;
  shouldLoadHighlight?: boolean;
  scrollable?: boolean;
  geometry?: DiffSectionGeometry;
  viewportTop?: number;
  viewportHeight?: number;
}) {
  const resolvedHighlighted = useHighlightedDiff({
    file,
    appearance: theme.appearance,
    shouldLoadHighlight,
  });

  const structuralMaps = useMemo(() => {
    if (!showStructural || !file?.structuralChanges) {
      return { oldLines: new Set<number>(), newLines: new Set<number>() };
    }

    const oldLines = new Set<number>();
    const newLines = new Set<number>();

    for (const change of file.structuralChanges) {
      if (change.type === "deletion") {
        for (let line = change.startLine; line <= change.endLine; line++) {
          oldLines.add(line);
        }
      } else if (change.type === "addition" || change.type === "modification") {
        for (let line = change.startLine; line <= change.endLine; line++) {
          newLines.add(line);
        }
      }
    }

    return { oldLines, newLines };
  }, [showStructural, file?.structuralChanges]);

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

  const visiblePlannedRows = useMemo(() => {
    if (
      !geometry ||
      viewportTop === undefined ||
      viewportHeight === undefined ||
      plannedRows.length === 0
    ) {
      return plannedRows;
    }

    const overscan = 8;
    const minVisibleY = Math.max(0, viewportTop - overscan);
    const maxVisibleY = viewportTop + viewportHeight + overscan;

    return plannedRows.filter((_, index) => {
      const bounds = geometry.rowBounds[index];
      if (!bounds) return true;
      const rowTop = bounds.top;
      const rowBottom = bounds.top + bounds.height;
      return rowBottom >= minVisibleY && rowTop <= maxVisibleY;
    });
  }, [geometry, viewportTop, viewportHeight, plannedRows]);

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
      {visiblePlannedRows.map((plannedRow) => {
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
            <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
              <AgentInlineNote
                annotation={plannedRow.annotation}
                anchorSide={plannedRow.anchorSide}
                layout={layout}
                noteCount={plannedRow.noteCount}
                noteIndex={plannedRow.noteIndex}
                theme={theme}
                width={width}
              />
            </box>
          );
        }

        if (plannedRow.kind === "note-guide-cap") {
          return (
            <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
              <AgentInlineNoteGuideCap side={plannedRow.side} theme={theme} width={width} />
            </box>
          );
        }

        let structuralChange = false;
        if (showStructural && plannedRow.kind === "diff-row") {
          const row = plannedRow.row;
          if (row.type === "split-line") {
            if (row.left.lineNumber)
              structuralChange = structuralMaps.oldLines.has(row.left.lineNumber);
            if (!structuralChange && row.right.lineNumber)
              structuralChange = structuralMaps.newLines.has(row.right.lineNumber);
          } else if (row.type === "stack-line") {
            if (row.cell.oldLineNumber)
              structuralChange = structuralMaps.oldLines.has(row.cell.oldLineNumber);
            if (!structuralChange && row.cell.newLineNumber)
              structuralChange = structuralMaps.newLines.has(row.cell.newLineNumber);
          }
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
              annotated={
                plannedRow.row.type === "hunk-header" &&
                annotatedHunkIndices.has(plannedRow.row.hunkIndex)
              }
              anchorId={plannedRow.anchorId}
              noteGuideSide={plannedRow.noteGuideSide}
              structuralChange={structuralChange}
              onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
            />
          </box>
        );
      })}
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
