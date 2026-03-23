import { useMemo } from "react";
import type { DiffFile, LayoutMode } from "../../core/types";
import { AgentInlineNote, AgentInlineNoteGuideCap } from "../components/panes/AgentInlineNote";
import { type VisibleAgentNote } from "../lib/agentAnnotations";
import type { AppTheme } from "../themes";
import { buildSplitRows, buildStackRows } from "./pierre";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { diffMessage, DiffRowView, findMaxLineNumber, fitText } from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

/** Render a file diff in split or stack mode, with inline agent notes inserted between diff rows. */
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
  const resolvedHighlighted = useHighlightedDiff({
    file,
    appearance: theme.appearance,
    onHighlightReady,
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
            selectedHunkIndex,
            showHunkHeaders,
            visibleAgentNotes,
          })
        : [],
    [file, rows, selectedHunkIndex, showHunkHeaders, visibleAgentNotes],
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
        if (plannedRow.kind === "inline-note") {
          return (
            <AgentInlineNote
              key={plannedRow.key}
              annotation={plannedRow.annotation}
              anchorSide={plannedRow.anchorSide}
              layout={layout}
              noteCount={plannedRow.noteCount}
              noteIndex={plannedRow.noteIndex}
              theme={theme}
              width={width}
              onClose={
                onDismissAgentNote ? () => onDismissAgentNote(plannedRow.annotationId) : undefined
              }
            />
          );
        }

        if (plannedRow.kind === "note-guide-cap") {
          return (
            <AgentInlineNoteGuideCap
              key={plannedRow.key}
              side={plannedRow.side}
              theme={theme}
              width={width}
            />
          );
        }

        return (
          <DiffRowView
            key={plannedRow.key}
            row={plannedRow.row}
            width={width}
            lineNumberDigits={lineNumberDigits}
            showLineNumbers={showLineNumbers}
            showHunkHeaders={showHunkHeaders}
            wrapLines={wrapLines}
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
