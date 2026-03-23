import type { AgentAnnotation } from "../../core/types";
import { annotationAnchor, type VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { DiffRow } from "./pierre";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];
const EMPTY_ROW_KEYS = new Set<string>();

type DiffLineRow = Extract<DiffRow, { type: "split-line" | "stack-line" }>;

interface InlineVisibleNotePlacement {
  anchorKey: string;
  anchorSide?: "old" | "new";
  endGuideAfterKey?: string;
  guidedRowKeys: Set<string>;
  hunkIndex: number;
  note: VisibleAgentNote;
  noteCount: number;
  noteIndex: number;
}

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

function lineRows(rows: DiffRow[]) {
  return rows.filter(
    (row): row is DiffLineRow => row.type === "split-line" || row.type === "stack-line",
  );
}

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

/**
 * Resolve the rendered diff row before which the inline note should appear.
 * Range-less notes intentionally anchor beside the first code row in the file,
 * not above hunk header metadata.
 */
function findInlineNoteAnchorRow(rows: DiffRow[], annotation: AgentAnnotation) {
  const fileLineRows = lineRows(rows);
  const headerRow = rows.find((row) => row.type === "hunk-header");

  return (
    fileLineRows.find((row) => rowMatchesNote(row, annotation)) ?? fileLineRows[0] ?? headerRow
  );
}

function buildInlineVisibleNotePlacements(rows: DiffRow[], visibleAgentNotes: VisibleAgentNote[]) {
  const fileLineRows = lineRows(rows);
  const placementsByAnchor = new Map<string, InlineVisibleNotePlacement[]>();

  for (const note of visibleAgentNotes) {
    const anchorRow = findInlineNoteAnchorRow(rows, note.annotation);
    if (!anchorRow) {
      continue;
    }

    const anchorSide = annotationAnchor(note.annotation)?.side;
    const coveredRows = fileLineRows.filter((row) => rowOverlapsAnnotation(row, note.annotation));
    const fallbackGuideRow = anchorSide ? anchorRow : undefined;
    const guideRows =
      coveredRows.length > 0 ? coveredRows : fallbackGuideRow ? [fallbackGuideRow] : [];
    const anchorPlacements = placementsByAnchor.get(anchorRow.key) ?? [];

    anchorPlacements.push({
      anchorKey: anchorRow.key,
      anchorSide,
      endGuideAfterKey: guideRows.at(-1)?.key,
      guidedRowKeys:
        guideRows.length > 0 ? new Set(guideRows.map((row) => row.key)) : EMPTY_ROW_KEYS,
      hunkIndex: anchorRow.hunkIndex,
      note,
      noteCount: 1,
      noteIndex: 0,
    });
    placementsByAnchor.set(anchorRow.key, anchorPlacements);
  }

  for (const placements of placementsByAnchor.values()) {
    placements.forEach((placement, index) => {
      placement.noteIndex = index;
      placement.noteCount = placements.length;
    });
  }

  return placementsByAnchor;
}

function buildNoteGuideSideByRowKey(placementsByAnchor: Map<string, InlineVisibleNotePlacement[]>) {
  const guideSideByRowKey = new Map<string, "old" | "new">();

  for (const placements of placementsByAnchor.values()) {
    for (const placement of placements) {
      if (!placement.anchorSide) {
        continue;
      }

      for (const rowKey of placement.guidedRowKeys) {
        if (!guideSideByRowKey.has(rowKey)) {
          guideSideByRowKey.set(rowKey, placement.anchorSide);
        }
      }
    }
  }

  return guideSideByRowKey;
}

function buildGuideCapsByRowKey(placementsByAnchor: Map<string, InlineVisibleNotePlacement[]>) {
  const guideCapsByRowKey = new Map<string, Set<"old" | "new">>();

  for (const placements of placementsByAnchor.values()) {
    for (const placement of placements) {
      if (!placement.anchorSide || !placement.endGuideAfterKey) {
        continue;
      }

      const rowCaps = guideCapsByRowKey.get(placement.endGuideAfterKey) ?? new Set<"old" | "new">();
      rowCaps.add(placement.anchorSide);
      guideCapsByRowKey.set(placement.endGuideAfterKey, rowCaps);
    }
  }

  return guideCapsByRowKey;
}

function rowCanAnchorHunk(row: DiffRow, showHunkHeaders: boolean) {
  if (showHunkHeaders) {
    return row.type === "hunk-header";
  }

  return row.type !== "collapsed" && row.type !== "hunk-header";
}

/**
 * Build the explicit presentational row plan for one file diff body.
 * The plan always preserves diff-row order and may insert inline notes plus
 * trailing guide caps for every visible note anchored in this file.
 */
export function buildReviewRenderPlan({
  fileId,
  rows,
  showHunkHeaders,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  selectedHunkIndex: _selectedHunkIndex,
}: {
  fileId: string;
  rows: DiffRow[];
  showHunkHeaders: boolean;
  visibleAgentNotes?: VisibleAgentNote[];
  selectedHunkIndex?: number;
}) {
  const placementsByAnchor = buildInlineVisibleNotePlacements(rows, visibleAgentNotes);
  const noteGuideSideByRowKey = buildNoteGuideSideByRowKey(placementsByAnchor);
  const guideCapsByRowKey = buildGuideCapsByRowKey(placementsByAnchor);
  const plannedRows: PlannedReviewRow[] = [];
  const anchoredHunks = new Set<number>();

  for (const row of rows) {
    const shouldAnchorHunk =
      rowCanAnchorHunk(row, showHunkHeaders) && !anchoredHunks.has(row.hunkIndex);
    const anchorId = shouldAnchorHunk ? diffHunkId(fileId, row.hunkIndex) : undefined;

    if (shouldAnchorHunk) {
      anchoredHunks.add(row.hunkIndex);
    }

    const anchoredNotes = placementsByAnchor.get(row.key) ?? [];
    anchoredNotes.forEach((placement) => {
      plannedRows.push({
        kind: "inline-note",
        key: `inline-note:${placement.note.id}:${row.key}:${placement.noteIndex}`,
        fileId,
        hunkIndex: placement.hunkIndex,
        annotationId: placement.note.id,
        annotation: placement.note.annotation,
        anchorSide: placement.anchorSide,
        noteCount: placement.noteCount,
        noteIndex: placement.noteIndex,
      });
    });

    plannedRows.push({
      kind: "diff-row",
      key: `diff-row:${row.key}`,
      fileId: row.fileId,
      hunkIndex: row.hunkIndex,
      row,
      anchorId,
      noteGuideSide: noteGuideSideByRowKey.get(row.key),
    });

    const guideCaps = guideCapsByRowKey.get(row.key);
    if (guideCaps) {
      Array.from(guideCaps).forEach((side) => {
        plannedRows.push({
          kind: "note-guide-cap",
          key: `note-guide-cap:${row.key}:${side}`,
          fileId,
          hunkIndex: row.hunkIndex,
          side,
        });
      });
    }
  }

  return plannedRows;
}
