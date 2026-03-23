import type { AgentAnnotation } from "../../core/types";
import { annotationAnchor, type VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { DiffRow } from "./pierre";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

interface SelectedInlineNote {
  anchorKey: string;
  anchorSide?: "old" | "new";
  coveredRowKeys: Set<string>;
  endGuideAfterKey: string;
  note: VisibleAgentNote;
  noteCount: number;
  noteIndex: number;
}

type DiffLineRow = Extract<DiffRow, { type: "split-line" | "stack-line" }>;

export type PlannedReviewRow =
  | {
      kind: "diff-row";
      key: string;
      fileId: string;
      hunkIndex: number;
      row: DiffRow;
      anchorId?: string;
      noteGuideSide?: "old" | "new";
    }
  | {
      kind: "inline-note";
      key: string;
      fileId: string;
      hunkIndex: number;
      annotationId: string;
      annotation: AgentAnnotation;
      anchorSide?: "old" | "new";
      noteCount: number;
      noteIndex: number;
    }
  | {
      kind: "note-guide-cap";
      key: string;
      fileId: string;
      hunkIndex: number;
      side: "old" | "new";
    };

/** Check whether a rendered diff row visually covers the note anchor line. */
function rowMatchesNote(row: DiffLineRow, annotation: AgentAnnotation) {
  const anchor = annotationAnchor(annotation);
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

/** Check whether one rendered diff row falls inside the annotation range on either side. */
function rowOverlapsAnnotation(row: DiffLineRow, annotation: AgentAnnotation) {
  const matchesOld =
    annotation.oldRange &&
    (row.type === "split-line"
      ? row.left.lineNumber !== undefined &&
        row.left.lineNumber >= annotation.oldRange[0] &&
        row.left.lineNumber <= annotation.oldRange[1]
      : row.cell.oldLineNumber !== undefined &&
        row.cell.oldLineNumber >= annotation.oldRange[0] &&
        row.cell.oldLineNumber <= annotation.oldRange[1]);

  if (matchesOld) {
    return true;
  }

  return Boolean(
    annotation.newRange &&
    (row.type === "split-line"
      ? row.right.lineNumber !== undefined &&
        row.right.lineNumber >= annotation.newRange[0] &&
        row.right.lineNumber <= annotation.newRange[1]
      : row.cell.newLineNumber !== undefined &&
        row.cell.newLineNumber >= annotation.newRange[0] &&
        row.cell.newLineNumber <= annotation.newRange[1]),
  );
}

/** Resolve the rendered diff row before which the visible inline note should appear. */
function findInlineNoteAnchorRow(
  rows: DiffRow[],
  annotation: AgentAnnotation,
  selectedHunkIndex: number,
) {
  const selectedHunkRows = rows.filter((row) => row.hunkIndex === selectedHunkIndex);
  const lineRows = selectedHunkRows.filter(
    (row): row is DiffLineRow => row.type === "split-line" || row.type === "stack-line",
  );
  const headerRow = selectedHunkRows.find((row) => row.type === "hunk-header");

  return lineRows.find((row) => rowMatchesNote(row, annotation)) ?? lineRows[0] ?? headerRow;
}

/** Return the one visible note, plus the diff rows that should show its guide rail. */
function buildSelectedInlineNote(
  rows: DiffRow[],
  visibleAgentNotes: VisibleAgentNote[],
  selectedHunkIndex: number,
) {
  if (visibleAgentNotes.length === 0 || selectedHunkIndex < 0) {
    return null;
  }

  const note = visibleAgentNotes[0]!;
  const anchorRow = findInlineNoteAnchorRow(rows, note.annotation, selectedHunkIndex);
  if (!anchorRow) {
    return null;
  }

  const selectedHunkLineRows = rows.filter(
    (row): row is DiffLineRow =>
      row.hunkIndex === selectedHunkIndex &&
      (row.type === "split-line" || row.type === "stack-line"),
  );
  const coveredRows = selectedHunkLineRows.filter((row) =>
    rowOverlapsAnnotation(row, note.annotation),
  );
  const fallbackGuideRow =
    anchorRow.type === "split-line" || anchorRow.type === "stack-line"
      ? anchorRow
      : selectedHunkLineRows[0];
  const guideRows =
    coveredRows.length > 0 ? coveredRows : fallbackGuideRow ? [fallbackGuideRow] : [];
  const endGuideAfterKey = guideRows.at(-1)?.key ?? anchorRow.key;

  return {
    anchorKey: anchorRow.key,
    anchorSide: annotationAnchor(note.annotation)?.side,
    coveredRowKeys: new Set(guideRows.map((row) => row.key)),
    endGuideAfterKey,
    note,
    noteIndex: 0,
    noteCount: visibleAgentNotes.length,
  } satisfies SelectedInlineNote;
}

function rowCanAnchorHunk(row: DiffRow, showHunkHeaders: boolean) {
  if (showHunkHeaders) {
    return row.type === "hunk-header";
  }

  return row.type !== "collapsed" && row.type !== "hunk-header";
}

/** Build the explicit presentational row plan for one file diff body. */
export function buildReviewRenderPlan({
  fileId,
  rows,
  selectedHunkIndex,
  showHunkHeaders,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
}: {
  fileId: string;
  rows: DiffRow[];
  selectedHunkIndex: number;
  showHunkHeaders: boolean;
  visibleAgentNotes?: VisibleAgentNote[];
}) {
  const selectedInlineNote = buildSelectedInlineNote(rows, visibleAgentNotes, selectedHunkIndex);
  const plannedRows: PlannedReviewRow[] = [];
  const anchoredHunks = new Set<number>();

  for (const row of rows) {
    const shouldAnchorHunk =
      rowCanAnchorHunk(row, showHunkHeaders) && !anchoredHunks.has(row.hunkIndex);
    const anchorId = shouldAnchorHunk ? diffHunkId(fileId, row.hunkIndex) : undefined;

    if (shouldAnchorHunk) {
      anchoredHunks.add(row.hunkIndex);
    }

    if (selectedInlineNote?.anchorKey === row.key) {
      plannedRows.push({
        kind: "inline-note",
        key: `inline-note:${selectedInlineNote.note.id}:${row.key}`,
        fileId,
        hunkIndex: row.hunkIndex,
        annotationId: selectedInlineNote.note.id,
        annotation: selectedInlineNote.note.annotation,
        anchorSide: selectedInlineNote.anchorSide,
        noteCount: selectedInlineNote.noteCount,
        noteIndex: selectedInlineNote.noteIndex,
      });
    }

    plannedRows.push({
      kind: "diff-row",
      key: `diff-row:${row.key}`,
      fileId: row.fileId,
      hunkIndex: row.hunkIndex,
      row,
      anchorId,
      noteGuideSide: selectedInlineNote?.coveredRowKeys.has(row.key)
        ? selectedInlineNote.anchorSide
        : undefined,
    });

    if (selectedInlineNote?.endGuideAfterKey === row.key && selectedInlineNote.anchorSide) {
      plannedRows.push({
        kind: "note-guide-cap",
        key: `note-guide-cap:${selectedInlineNote.note.id}:${row.key}`,
        fileId,
        hunkIndex: row.hunkIndex,
        side: selectedInlineNote.anchorSide,
      });
    }
  }

  return plannedRows;
}
