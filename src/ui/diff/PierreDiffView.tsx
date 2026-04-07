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
  wrapLines = false,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  width,
  selectedHunkIndex,
  shouldLoadHighlight = true,
  scrollable = true,
}: {
  annotatedHunkIndices?: Set<number>;
  codeHorizontalOffset?: number;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
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
      {plannedRows.map((plannedRow) => {
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
