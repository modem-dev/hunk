import type { AgentAnnotation, DiffFile } from "../../core/types";
import { AgentCard } from "../components/panes/AgentCard";
import { annotationLocationLabel, type VisibleAgentNote } from "../lib/agentAnnotations";
import { buildAgentPopoverContent, resolveAgentPopoverPlacement } from "../lib/agentPopover";
import type { AppTheme } from "../themes";
import type { DiffRow } from "./pierre";

interface SelectedOverlayNote {
  anchorColumn: number;
  anchorKey: string;
  note: VisibleAgentNote;
  noteCount: number;
  noteIndex: number;
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
function rowMatchesNote(
  row: Extract<DiffRow, { type: "split-line" | "stack-line" }>,
  note: VisibleAgentNote,
) {
  const anchor = noteAnchor(note.annotation);
  if (!anchor) {
    return false;
  }

  if (row.type === "split-line") {
    return anchor.side === "new"
      ? row.right.lineNumber === anchor.lineNumber
      : row.left.lineNumber === anchor.lineNumber;
  }

  return anchor.side === "new"
    ? row.cell.newLineNumber === anchor.lineNumber
    : row.cell.oldLineNumber === anchor.lineNumber;
}

/** Resolve the rendered row for the currently visible popover note. */
function findNoteAnchorRow(
  rows: DiffRow[],
  note: VisibleAgentNote,
  selectedHunkIndex: number,
  showHunkHeaders: boolean,
) {
  const selectedHunkRows = rows.filter((row) => row.hunkIndex === selectedHunkIndex);
  const lineRows = selectedHunkRows.filter(
    (row): row is Extract<DiffRow, { type: "split-line" | "stack-line" }> =>
      row.type === "split-line" || row.type === "stack-line",
  );
  const headerRow = selectedHunkRows.find((row) => row.type === "hunk-header");
  const firstVisibleRow = showHunkHeaders ? (headerRow ?? lineRows[0]) : (lineRows[0] ?? headerRow);

  return lineRows.find((row) => rowMatchesNote(row, note)) ?? firstVisibleRow;
}

/** Pick a horizontal anchor column for the floating note popover. */
function noteAnchorColumn(
  row: DiffRow,
  note: VisibleAgentNote,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (row.type === "split-line") {
    const markerWidth = 1;
    const separatorWidth = 1;
    const usableWidth = Math.max(0, width - markerWidth - separatorWidth);
    const leftWidth = Math.max(0, markerWidth + Math.floor(usableWidth / 2));
    const anchor = noteAnchor(note.annotation);
    return anchor?.side === "old" ? 1 : leftWidth + 1;
  }

  if (row.type === "stack-line") {
    return showLineNumbers ? Math.max(2, lineNumberDigits + 4) : 2;
  }

  return 2;
}

/** Resolve the single visible popover note for the selected hunk. */
export function buildSelectedOverlayNote(
  rows: DiffRow[],
  visibleAgentNotes: VisibleAgentNote[],
  selectedHunkIndex: number,
  showHunkHeaders: boolean,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (visibleAgentNotes.length === 0 || selectedHunkIndex < 0) {
    return null;
  }

  const note = visibleAgentNotes[0]!;
  const anchorRow = findNoteAnchorRow(rows, note, selectedHunkIndex, showHunkHeaders);
  if (!anchorRow) {
    return null;
  }

  return {
    anchorKey: anchorRow.key,
    anchorColumn: noteAnchorColumn(anchorRow, note, width, lineNumberDigits, showLineNumbers),
    note,
    noteIndex: 0,
    noteCount: visibleAgentNotes.length,
  } satisfies SelectedOverlayNote;
}

/** Render the framed floating popover for the currently visible agent note. */
export function renderAgentPopover(
  selectedOverlayNote: SelectedOverlayNote | null,
  file: DiffFile,
  width: number,
  contentHeight: number,
  rowMetrics: Map<string, { height: number; top: number }>,
  theme: AppTheme,
  onDismissAgentNote?: (id: string) => void,
) {
  if (!selectedOverlayNote) {
    return null;
  }

  const noteWidth = Math.min(Math.max(34, Math.floor(width * 0.42)), Math.max(12, width - 2));
  const locationLabel = annotationLocationLabel(file, selectedOverlayNote.note.annotation);
  const popover = buildAgentPopoverContent({
    summary: selectedOverlayNote.note.annotation.summary,
    rationale: selectedOverlayNote.note.annotation.rationale,
    locationLabel,
    noteIndex: selectedOverlayNote.noteIndex,
    noteCount: selectedOverlayNote.noteCount,
    width: noteWidth,
  });
  const anchorMetric = rowMetrics.get(selectedOverlayNote.anchorKey);
  if (!anchorMetric) {
    return null;
  }

  const placement = resolveAgentPopoverPlacement({
    anchorColumn: selectedOverlayNote.anchorColumn,
    anchorRowTop: anchorMetric.top,
    anchorRowHeight: anchorMetric.height,
    contentHeight,
    noteHeight: popover.height,
    noteWidth,
    viewportWidth: width,
  });

  return (
    <box style={{ position: "absolute", top: placement.top, left: placement.left, zIndex: 20 }}>
      <AgentCard
        locationLabel={locationLabel}
        noteCount={selectedOverlayNote.noteCount}
        noteIndex={selectedOverlayNote.noteIndex}
        rationale={selectedOverlayNote.note.annotation.rationale}
        summary={selectedOverlayNote.note.annotation.summary}
        theme={theme}
        width={noteWidth}
        onClose={
          onDismissAgentNote ? () => onDismissAgentNote(selectedOverlayNote.note.id) : undefined
        }
      />
    </box>
  );
}
