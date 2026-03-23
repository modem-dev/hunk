import { Fragment, useMemo } from "react";
import type { AgentAnnotation, DiffFile, LayoutMode } from "../../core/types";
import { AgentInlineNote, AgentInlineNoteGuideCap } from "../components/panes/AgentInlineNote";
import { annotationAnchor, type VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { buildSplitRows, type DiffRow, buildStackRows } from "./pierre";
import { diffMessage, DiffRowView, findMaxLineNumber, fitText } from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
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

/** Check whether a rendered diff row visually covers the note anchor line. */
function rowMatchesNote(row: Extract<DiffRow, { type: "split-line" | "stack-line" }>, annotation: AgentAnnotation) {
  const anchor = annotationAnchor(annotation);
  if (!anchor) {
    return false;
  }

  if (row.type === "split-line") {
    return anchor.side === "new" ? row.right.lineNumber === anchor.lineNumber : row.left.lineNumber === anchor.lineNumber;
  }

  return anchor.side === "new" ? row.cell.newLineNumber === anchor.lineNumber : row.cell.oldLineNumber === anchor.lineNumber;
}

/** Check whether one rendered diff row falls inside the annotation range on either side. */
function rowOverlapsAnnotation(row: Extract<DiffRow, { type: "split-line" | "stack-line" }>, annotation: AgentAnnotation) {
  const matchesOld =
    annotation.oldRange &&
    (row.type === "split-line"
      ? row.left.lineNumber !== undefined && row.left.lineNumber >= annotation.oldRange[0] && row.left.lineNumber <= annotation.oldRange[1]
      : row.cell.oldLineNumber !== undefined && row.cell.oldLineNumber >= annotation.oldRange[0] && row.cell.oldLineNumber <= annotation.oldRange[1]);

  if (matchesOld) {
    return true;
  }

  return Boolean(
    annotation.newRange &&
      (row.type === "split-line"
        ? row.right.lineNumber !== undefined && row.right.lineNumber >= annotation.newRange[0] && row.right.lineNumber <= annotation.newRange[1]
        : row.cell.newLineNumber !== undefined && row.cell.newLineNumber >= annotation.newRange[0] && row.cell.newLineNumber <= annotation.newRange[1]),
  );
}

/** Resolve the rendered diff row before which the visible inline note should appear. */
function findInlineNoteAnchorRow(rows: DiffRow[], annotation: AgentAnnotation, selectedHunkIndex: number) {
  const selectedHunkRows = rows.filter((row) => row.hunkIndex === selectedHunkIndex);
  const lineRows = selectedHunkRows.filter(
    (row): row is Extract<DiffRow, { type: "split-line" | "stack-line" }> => row.type === "split-line" || row.type === "stack-line",
  );
  const headerRow = selectedHunkRows.find((row) => row.type === "hunk-header");

  return lineRows.find((row) => rowMatchesNote(row, annotation)) ?? lineRows[0] ?? headerRow;
}

/** Return the one visible note, plus the diff rows that should show its guide rail. */
function buildSelectedInlineNote(rows: DiffRow[], visibleAgentNotes: VisibleAgentNote[], selectedHunkIndex: number) {
  if (visibleAgentNotes.length === 0 || selectedHunkIndex < 0) {
    return null;
  }

  const note = visibleAgentNotes[0]!;
  const anchorRow = findInlineNoteAnchorRow(rows, note.annotation, selectedHunkIndex);
  if (!anchorRow) {
    return null;
  }

  const selectedHunkLineRows = rows.filter(
    (row): row is Extract<DiffRow, { type: "split-line" | "stack-line" }> =>
      row.hunkIndex === selectedHunkIndex && (row.type === "split-line" || row.type === "stack-line"),
  );
  const coveredRows = selectedHunkLineRows.filter((row) => rowOverlapsAnnotation(row, note.annotation));
  const fallbackGuideRow =
    anchorRow.type === "split-line" || anchorRow.type === "stack-line"
      ? anchorRow
      : selectedHunkLineRows[0];
  const guideRows = coveredRows.length > 0 ? coveredRows : fallbackGuideRow ? [fallbackGuideRow] : [];
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
    () => (file ? (layout === "split" ? buildSplitRows(file, resolvedHighlighted, theme) : buildStackRows(file, resolvedHighlighted, theme)) : []),
    [file, layout, resolvedHighlighted, theme],
  );
  const hunkAnchorIds = useMemo(() => {
    const anchors = new Map<string, string>();
    const seenHunks = new Set<number>();

    for (const row of rows) {
      if (seenHunks.has(row.hunkIndex)) {
        continue;
      }

      if (showHunkHeaders) {
        if (row.type !== "hunk-header") {
          continue;
        }
      } else if (row.type === "collapsed" || row.type === "hunk-header") {
        continue;
      }

      anchors.set(row.key, diffHunkId(row.fileId, row.hunkIndex));
      seenHunks.add(row.hunkIndex);
    }

    return anchors;
  }, [rows, showHunkHeaders]);
  const lineNumberDigits = useMemo(() => String(file ? findMaxLineNumber(file) : 1).length, [file]);
  const selectedInlineNote = useMemo(
    () => buildSelectedInlineNote(rows, visibleAgentNotes, selectedHunkIndex),
    [rows, selectedHunkIndex, visibleAgentNotes],
  );

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
      {rows.map((row) => {
        const showInlineNote = selectedInlineNote?.anchorKey === row.key;
        const rowShowsGuide = Boolean(selectedInlineNote?.coveredRowKeys.has(row.key));
        const showGuideCap = selectedInlineNote?.endGuideAfterKey === row.key;

        return (
          <Fragment key={row.key}>
            {showInlineNote ? (
              <AgentInlineNote
                annotation={selectedInlineNote.note.annotation}
                anchorSide={selectedInlineNote.anchorSide}
                layout={layout}
                noteCount={selectedInlineNote.noteCount}
                noteIndex={selectedInlineNote.noteIndex}
                theme={theme}
                width={width}
                onClose={onDismissAgentNote ? () => onDismissAgentNote(selectedInlineNote.note.id) : undefined}
              />
            ) : null}
            <DiffRowView
              row={row}
              width={width}
              lineNumberDigits={lineNumberDigits}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              theme={theme}
              selected={row.hunkIndex === selectedHunkIndex}
              annotated={row.type === "hunk-header" && annotatedHunkIndices.has(row.hunkIndex)}
              anchorId={hunkAnchorIds.get(row.key)}
              noteGuideSide={rowShowsGuide ? selectedInlineNote?.anchorSide : undefined}
              onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
            />
            {showGuideCap && selectedInlineNote?.anchorSide ? (
              <AgentInlineNoteGuideCap side={selectedInlineNote.anchorSide} theme={theme} width={width} />
            ) : null}
          </Fragment>
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
