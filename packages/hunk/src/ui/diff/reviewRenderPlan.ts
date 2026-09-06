import { DEFAULT_HUNK_GAP } from "../../core/run/reviewGap";
import { reviewNoteAnchorLine, reviewNoteOwnerHunkIndex } from "../../core/review/state";
import type { ReviewRangeAnchorV1 } from "../../core/review/types";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { AgentAnnotation } from "../../extension-api/types";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { DiffRow } from "./diffRows";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];
const EMPTY_ROW_KEYS = new Set<string>();

type DiffLineRow = Extract<DiffRow, { type: "split-line" | "stack-line" }>;

interface InlineVisibleNotePlacement {
  anchorKey: string;
  anchorSide?: "old" | "new";
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
      stableKey: string;
      stableAliasKeys?: string[];
      fileId: string;
      hunkIndex: number;
      row: DiffRow;
      anchorId?: string;
      noteGuideSide?: "old" | "new";
    }
  | {
      kind: "inline-note";
      key: string;
      stableKey: string;
      fileId: string;
      hunkIndex: number;
      annotationId: string;
      annotation: AgentAnnotation;
      note: VisibleAgentNote;
      anchorSide?: "old" | "new";
      noteCount: number;
      noteIndex: number;
    }
  | {
      kind: "hunk-gap";
      key: string;
      stableKey: string;
      fileId: string;
      hunkIndex: number;
      height: number;
    };

function lineRows(rows: DiffRow[]) {
  return rows.filter(
    (row): row is DiffLineRow => row.type === "split-line" || row.type === "stack-line",
  );
}

/** Deduplicate stable row anchors while preserving the preferred resolution order. */
function uniqueStableKeys(keys: Array<string | undefined>) {
  const next: string[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    next.push(key);
  }

  return next;
}

/** Build the file-scoped stable anchor for one source line on either diff side. */
export function lineStableKey(hunkIndex: number, side: "old" | "new", lineNumber: number) {
  return `line:${hunkIndex}:${side}:${lineNumber}`;
}

/** Build the stable anchor for one inline note card. */
export function inlineNoteStableKey(noteId: string) {
  return `inline-note:${noteId}`;
}

/** Build the file-scoped stable anchor for one old-side source line. */
function oldLineStableKey(hunkIndex: number, lineNumber?: number) {
  return lineNumber === undefined ? undefined : lineStableKey(hunkIndex, "old", lineNumber);
}

/** Build the file-scoped stable anchor for one new-side source line. */
function newLineStableKey(hunkIndex: number, lineNumber?: number) {
  return lineNumber === undefined ? undefined : lineStableKey(hunkIndex, "new", lineNumber);
}

/** Build the file-scoped stable anchor for one context row shared by both sides. */
function contextLineStableKey(hunkIndex: number, oldLineNumber?: number, newLineNumber?: number) {
  return oldLineNumber === undefined || newLineNumber === undefined
    ? undefined
    : `line:${hunkIndex}:context:${oldLineNumber}:${newLineNumber}`;
}

const SIDED_LINE_STABLE_KEY = /^line:(\d+):(old|new):(\d+)$/;
const CONTEXT_LINE_STABLE_KEY = /^line:(\d+):context:\d+:(\d+)$/;
const CONTEXT_LINE_STABLE_KEY_SIDES = /^line:(\d+):context:(\d+):(\d+)$/;

/** Recover the source line one single-sided stable anchor names. */
export function lineStableKeyTarget(
  stableKey: string,
): (UserNoteLineTarget & { hunkIndex: number }) | null {
  const match = SIDED_LINE_STABLE_KEY.exec(stableKey);
  if (!match) {
    return null;
  }

  return { hunkIndex: Number(match[1]), side: match[2] as "old" | "new", line: Number(match[3]) };
}

/**
 * Recover the source line one shared context anchor names.
 *
 * Resolves to the new side, which is what the add-note affordance already anchors to.
 */
export function contextLineStableKeyTarget(
  stableKey: string,
): (UserNoteLineTarget & { hunkIndex: number }) | null {
  const match = CONTEXT_LINE_STABLE_KEY.exec(stableKey);
  if (!match) {
    return null;
  }

  return { hunkIndex: Number(match[1]), side: "new", line: Number(match[2]) };
}

/**
 * Recover both source lines one shared context anchor names.
 *
 * A context row shows the same text on both sides under two different numbers, so a caller
 * addressing it by line number has to be able to match either one.
 */
export function contextLineStableKeySides(
  stableKey: string,
): { hunkIndex: number; oldLine: number; newLine: number } | null {
  const match = CONTEXT_LINE_STABLE_KEY_SIDES.exec(stableKey);
  if (!match) {
    return null;
  }

  return {
    hunkIndex: Number(match[1]),
    oldLine: Number(match[2]),
    newLine: Number(match[3]),
  };
}

/** Resolve the stable anchor keys for one rendered diff row across split and stack layouts. */
function diffRowStableKeys(row: DiffRow) {
  if (row.type === "collapsed") {
    return [`meta:collapsed:${row.position}:${row.hunkIndex}`];
  }

  if (row.type === "hunk-header") {
    return [`meta:hunk-header:${row.hunkIndex}`];
  }

  if (row.type === "split-line") {
    const contextKey = contextLineStableKey(
      row.hunkIndex,
      row.left.lineNumber,
      row.right.lineNumber,
    );

    if (row.left.kind === "context" && row.right.kind === "context") {
      return uniqueStableKeys([
        contextKey,
        newLineStableKey(row.hunkIndex, row.right.lineNumber),
        oldLineStableKey(row.hunkIndex, row.left.lineNumber),
      ]);
    }

    // Prefer the old-side line so split→stack toggles stay near the same vertical position even
    // when one large change block expands into many deletions followed by many additions.
    return uniqueStableKeys([
      oldLineStableKey(row.hunkIndex, row.left.lineNumber),
      newLineStableKey(row.hunkIndex, row.right.lineNumber),
    ]);
  }

  const contextKey = contextLineStableKey(
    row.hunkIndex,
    row.cell.oldLineNumber,
    row.cell.newLineNumber,
  );

  if (row.cell.kind === "context") {
    return uniqueStableKeys([
      contextKey,
      newLineStableKey(row.hunkIndex, row.cell.newLineNumber),
      oldLineStableKey(row.hunkIndex, row.cell.oldLineNumber),
    ]);
  }

  return uniqueStableKeys([
    newLineStableKey(row.hunkIndex, row.cell.newLineNumber),
    oldLineStableKey(row.hunkIndex, row.cell.oldLineNumber),
  ]);
}

/** The line one rendered row shows on one diff side, when it shows one at all. */
function rowLineNumber(row: DiffLineRow, side: "old" | "new") {
  if (row.type === "split-line") {
    return side === "new" ? row.right.lineNumber : row.left.lineNumber;
  }

  return side === "new" ? row.cell.newLineNumber : row.cell.oldLineNumber;
}

/** Check whether one rendered diff row falls inside the note's range on either side. */
function rowOverlapsNoteRange(row: DiffLineRow, anchor: ReviewRangeAnchorV1) {
  for (const side of ["old", "new"] as const) {
    const range = side === "old" ? anchor.oldRange : anchor.newRange;
    const lineNumber = rowLineNumber(row, side);
    if (range && lineNumber !== undefined && lineNumber >= range[0] && lineNumber <= range[1]) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve the rendered diff row after which one inline note should appear.
 *
 * The owning hunk is the one the shared anchor resolver named, never the hunk of whatever
 * row happens to contain the note's range: a note anchored to lines this patch collapsed,
 * or to a gap line, has an owner but no matching row, and re-deriving placement by
 * containment strands it at the top of the file. Inside that hunk the note sits beside the
 * first row at or after its anchor line, falling back to the closest row before it and
 * then to the hunk's first row — a note always lands next to the code it explains.
 */
function findInlineNoteAnchorRow(rows: DiffRow[], note: VisibleAgentNote) {
  const fileLineRows = lineRows(rows);
  const ownerHunkIndex = reviewNoteOwnerHunkIndex(note);
  const ownerRows = fileLineRows.filter((row) => row.hunkIndex === ownerHunkIndex);
  const candidates = ownerRows.length > 0 ? ownerRows : fileLineRows;
  const { side, line } = reviewNoteAnchorLine(note);

  let precedingRow: DiffLineRow | undefined;
  for (const row of candidates) {
    const lineNumber = rowLineNumber(row, side);
    if (lineNumber === undefined) {
      continue;
    }

    if (lineNumber >= line) {
      return row;
    }

    precedingRow = row;
  }

  return (
    precedingRow ??
    candidates[0] ??
    rows.find((row) => row.type === "hunk-header" && row.hunkIndex === ownerHunkIndex) ??
    rows.find((row) => row.type === "hunk-header")
  );
}

function buildInlineVisibleNotePlacements(rows: DiffRow[], visibleAgentNotes: VisibleAgentNote[]) {
  const fileLineRows = lineRows(rows);
  const placementsByAnchor = new Map<string, InlineVisibleNotePlacement[]>();

  for (const note of visibleAgentNotes) {
    const anchorRow = findInlineNoteAnchorRow(rows, note);
    if (!anchorRow) {
      continue;
    }

    const anchorSide = note.anchor.preferred?.side;
    const coveredRows = fileLineRows.filter((row) => rowOverlapsNoteRange(row, note.anchor));
    const guideRows = coveredRows.filter((row) => row.key !== anchorRow.key);
    const anchorPlacements = placementsByAnchor.get(anchorRow.key) ?? [];

    anchorPlacements.push({
      anchorKey: anchorRow.key,
      anchorSide,
      guidedRowKeys:
        guideRows.length > 0 ? new Set(guideRows.map((row) => row.key)) : EMPTY_ROW_KEYS,
      // The row's own hunk, which is the resolved owner whenever that hunk drew rows;
      // reporting an owner with no rows here would give it measured bounds it has not got.
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

function rowCanAnchorHunk(row: DiffRow, showHunkHeaders: boolean) {
  if (showHunkHeaders) {
    return row.type === "hunk-header";
  }

  if (row.type === "collapsed" || row.type === "hunk-header") {
    return false;
  }

  // Synthesized collapsed-gap rows carry the neighbor hunk's index for placement,
  // but anchoring on them would scroll navigation to the top of the expanded gap
  // instead of the actual changed code.
  return row.isExpansionRow !== true;
}

/**
 * Build the explicit presentational row plan for one file diff body.
 * The plan always preserves diff-row order and may insert inline notes for every visible note
 * anchored in this file. Decorative hunk-gap rows sit before each hunk after the first.
 */
export function buildReviewRenderPlan({
  fileId,
  rows,
  showHunkHeaders,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  selectedHunkIndex: _selectedHunkIndex,
  hunkGap = DEFAULT_HUNK_GAP,
}: {
  fileId: string;
  rows: DiffRow[];
  showHunkHeaders: boolean;
  visibleAgentNotes?: VisibleAgentNote[];
  selectedHunkIndex?: number;
  hunkGap?: number;
}) {
  const placementsByAnchor = buildInlineVisibleNotePlacements(rows, visibleAgentNotes);
  const noteGuideSideByRowKey = buildNoteGuideSideByRowKey(placementsByAnchor);
  const plannedRows: PlannedReviewRow[] = [];
  const anchoredHunks = new Set<number>();

  for (const row of rows) {
    const shouldAnchorHunk =
      rowCanAnchorHunk(row, showHunkHeaders) && !anchoredHunks.has(row.hunkIndex);
    const anchorId = shouldAnchorHunk ? diffHunkId(fileId, row.hunkIndex) : undefined;
    const diffStableKeys = diffRowStableKeys(row);
    const diffStableKey = diffStableKeys[0] ?? `row:${row.key}`;
    const diffStableAliasKeys = diffStableKeys.slice(1);

    if (hunkGap > 0 && row.type === "hunk-header" && row.hunkIndex > 0) {
      plannedRows.push({
        kind: "hunk-gap",
        key: `hunk-gap:${fileId}:${row.hunkIndex}`,
        stableKey: `hunk-gap:${row.hunkIndex}`,
        fileId,
        hunkIndex: row.hunkIndex,
        height: hunkGap,
      });
    }

    if (shouldAnchorHunk) {
      anchoredHunks.add(row.hunkIndex);
    }

    plannedRows.push({
      kind: "diff-row",
      key: `diff-row:${row.key}`,
      stableKey: diffStableKey,
      stableAliasKeys: diffStableAliasKeys,
      fileId: row.fileId,
      hunkIndex: row.hunkIndex,
      row,
      anchorId,
      noteGuideSide: noteGuideSideByRowKey.get(row.key),
    });

    const anchoredNotes = placementsByAnchor.get(row.key) ?? [];
    anchoredNotes.forEach((placement) => {
      plannedRows.push({
        kind: "inline-note",
        key: `inline-note:${placement.note.id}:${row.key}:${placement.noteIndex}`,
        stableKey: inlineNoteStableKey(placement.note.id),
        fileId,
        hunkIndex: placement.hunkIndex,
        annotationId: placement.note.id,
        annotation: placement.note.annotation,
        note: placement.note,
        anchorSide: placement.anchorSide,
        noteCount: placement.noteCount,
        noteIndex: placement.noteIndex,
      });
    });
  }

  return plannedRows;
}
