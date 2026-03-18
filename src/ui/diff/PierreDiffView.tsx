import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentAnnotation, DiffFile, LayoutMode } from "../../core/types";
import { AgentCard } from "../components/panes/AgentCard";
import { annotationLocationLabel, type VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { AppTheme } from "../themes";
import {
  buildSplitRows,
  buildStackRows,
  loadHighlightedDiff,
  type DiffRow,
  type HighlightedDiffCode,
  type RenderSpan,
  type SplitLineCell,
  type StackLineCell,
} from "./pierre";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width === 1) {
    return "…";
  }

  return `${text.slice(0, width - 1)}…`;
}

function trimSpans(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return [];
  }

  const trimmed: RenderSpan[] = [];
  let remaining = width;

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    const text = span.text.slice(0, remaining);
    if (text.length === 0) {
      continue;
    }

    const nextSpan = {
      ...span,
      text,
    };

    const previous = trimmed.at(-1);
    if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
      previous.text += nextSpan.text;
    } else {
      trimmed.push(nextSpan);
    }

    remaining -= text.length;
  }

  return trimmed;
}

function marker(selected: boolean) {
  return selected ? "▌" : " ";
}

function splitCellPalette(kind: SplitLineCell["kind"], theme: AppTheme) {
  if (kind === "addition") {
    return {
      gutterBg: theme.addedBg,
      contentBg: theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: theme.removedBg,
      contentBg: theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  if (kind === "empty") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.panelAlt,
      signColor: theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

function stackCellPalette(kind: StackLineCell["kind"], theme: AppTheme) {
  if (kind === "addition") {
    return {
      gutterBg: theme.addedBg,
      contentBg: theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: theme.removedBg,
      contentBg: theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

function renderInlineSpans(
  spans: RenderSpan[],
  width: number,
  fallbackColor: string,
  fallbackBg: string,
  keyPrefix: string,
) {
  const trimmed = trimSpans(spans, width);
  const usedWidth = trimmed.reduce((sum, span) => sum + span.text.length, 0);
  const padding = Math.max(0, width - usedWidth);

  return (
    <>
      {trimmed.map((span, index) => (
        <span key={`${keyPrefix}:${index}`} fg={span.fg ?? fallbackColor} bg={span.bg ?? fallbackBg}>
          {span.text}
        </span>
      ))}
      {padding > 0 ? (
        <span key={`${keyPrefix}:padding`} fg={fallbackColor} bg={fallbackBg}>{`${" ".repeat(padding)}`}</span>
      ) : null}
    </>
  );
}

function renderSplitCell(
  cell: SplitLineCell,
  width: number,
  lineNumberDigits: number,
  theme: AppTheme,
  keyPrefix: string,
) {
  const palette = splitCellPalette(cell.kind, theme);
  const gutterWidth = Math.min(width, lineNumberDigits + 3);
  const contentWidth = Math.max(0, width - gutterWidth);
  const gutterText = `${cell.lineNumber ? String(cell.lineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits)} ${cell.sign}`.padEnd(gutterWidth);

  return (
    <box key={keyPrefix} style={{ width, height: 1 }}>
      <text>
        <span fg={palette.numberColor} bg={palette.gutterBg}>
          {gutterText}
        </span>
        {renderInlineSpans(cell.spans, contentWidth, theme.text, palette.contentBg, `${keyPrefix}:content`)}
      </text>
    </box>
  );
}

function renderStackCell(
  cell: StackLineCell,
  width: number,
  lineNumberDigits: number,
  theme: AppTheme,
  keyPrefix: string,
) {
  const palette = stackCellPalette(cell.kind, theme);
  const gutterWidth = Math.min(width, lineNumberDigits * 2 + 5);
  const contentWidth = Math.max(0, width - gutterWidth);

  const oldNumber = cell.oldLineNumber ? String(cell.oldLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);
  const newNumber = cell.newLineNumber ? String(cell.newLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);

  return (
    <box key={keyPrefix} style={{ width, height: 1 }}>
      <text>
        <span fg={palette.numberColor} bg={palette.gutterBg}>{`${oldNumber} ${newNumber} ${cell.sign}`.padEnd(gutterWidth)}</span>
        {renderInlineSpans(cell.spans, contentWidth, theme.text, palette.contentBg, `${keyPrefix}:content`)}
      </text>
    </box>
  );
}

function diffMessage(file: DiffFile) {
  if (file.metadata.type === "rename-pure") {
    return "No textual hunks. This change only renames the file.";
  }

  if (file.metadata.type === "new") {
    return "No textual hunks. The file is marked as new.";
  }

  if (file.metadata.type === "deleted") {
    return "No textual hunks. The file is marked as deleted.";
  }

  return "No textual hunks to render for this file.";
}

function findMaxLineNumber(file: DiffFile) {
  let highest = 0;

  for (const hunk of file.metadata.hunks) {
    highest = Math.max(highest, hunk.deletionStart + hunk.deletionCount, hunk.additionStart + hunk.additionCount);
  }

  return Math.max(highest, 1);
}

function renderHeaderRow(
  row: Extract<DiffRow, { type: "collapsed" | "hunk-header" }>,
  width: number,
  theme: AppTheme,
  selected: boolean,
  annotated: boolean,
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
) {
  const badgeText = annotated ? "[AI]" : "";
  const badgeWidth = annotated ? badgeText.length + 1 : 0;
  const label =
    row.type === "collapsed"
      ? fitText(`··· ${row.text} ···`, Math.max(0, width - 1 - badgeWidth))
      : fitText(row.text, Math.max(0, width - 1 - badgeWidth));

  return (
    <box
      key={row.key}
      id={row.type === "hunk-header" ? diffHunkId(row.fileId, row.hunkIndex) : undefined}
      style={{
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: theme.panelAlt,
      }}
    >
      <box style={{ width: 1, height: 1 }}>
        <text fg={selected ? theme.accent : theme.panelAlt}>{marker(selected)}</text>
      </box>
      <box style={{ width: Math.max(0, width - 1 - badgeWidth), height: 1 }}>
        <text fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral}>{label}</text>
      </box>
      {annotated ? (
        <box style={{ width: badgeWidth, height: 1 }} onMouseUp={() => onOpenAgentNotesAtHunk?.(row.hunkIndex)}>
          <text fg={theme.accent}>{badgeText}</text>
        </box>
      ) : null}
    </box>
  );
}

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

function rowMatchesNote(row: Extract<DiffRow, { type: "split-line" | "stack-line" }>, note: VisibleAgentNote) {
  const anchor = noteAnchor(note.annotation);
  if (!anchor) {
    return false;
  }

  if (row.type === "split-line") {
    return anchor.side === "new" ? row.right.lineNumber === anchor.lineNumber : row.left.lineNumber === anchor.lineNumber;
  }

  return anchor.side === "new" ? row.cell.newLineNumber === anchor.lineNumber : row.cell.oldLineNumber === anchor.lineNumber;
}

function buildAnchoredNotes(rows: DiffRow[], visibleAgentNotes: VisibleAgentNote[], selectedHunkIndex: number) {
  const anchoredNotes = new Map<string, VisibleAgentNote[]>();

  if (visibleAgentNotes.length === 0 || selectedHunkIndex < 0) {
    return anchoredNotes;
  }

  const selectedHunkRows = rows.filter((row) => row.hunkIndex === selectedHunkIndex);
  const lineRows = selectedHunkRows.filter(
    (row): row is Extract<DiffRow, { type: "split-line" | "stack-line" }> => row.type === "split-line" || row.type === "stack-line",
  );
  const headerRow = selectedHunkRows.find((row) => row.type === "hunk-header");

  for (const note of visibleAgentNotes) {
    const anchorRow = lineRows.find((row) => rowMatchesNote(row, note));
    const targetKey = anchorRow?.key ?? headerRow?.key;
    if (!targetKey) {
      continue;
    }

    const current = anchoredNotes.get(targetKey) ?? [];
    current.push(note);
    anchoredNotes.set(targetKey, current);
  }

  return anchoredNotes;
}

function renderAnchoredNotes(
  anchoredNotes: VisibleAgentNote[],
  file: DiffFile,
  width: number,
  theme: AppTheme,
  onDismissAgentNote?: (id: string) => void,
) {
  if (anchoredNotes.length === 0) {
    return null;
  }

  const noteWidth = Math.min(Math.max(28, Math.floor(width * 0.46)), Math.max(28, width - 6));

  return (
    <box
      style={{
        width: "100%",
        flexDirection: "column",
        gap: 1,
        paddingRight: 2,
        alignItems: "flex-end",
      }}
    >
      {anchoredNotes.map((note) => (
        <AgentCard
          key={note.id}
          locationLabel={annotationLocationLabel(file, note.annotation)}
          rationale={note.annotation.rationale}
          summary={note.annotation.summary}
          theme={theme}
          width={noteWidth}
          onClose={onDismissAgentNote ? () => onDismissAgentNote(note.id) : undefined}
        />
      ))}
    </box>
  );
}

function renderRow(
  row: DiffRow,
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  width: number,
  lineNumberDigits: number,
  theme: AppTheme,
  selected: boolean,
  annotated: boolean,
  anchoredNotes: VisibleAgentNote[],
  onDismissAgentNote?: (id: string) => void,
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void,
) {
  let baseRow: ReactNode;

  if (row.type === "collapsed" || row.type === "hunk-header") {
    baseRow = renderHeaderRow(row, width, theme, selected, annotated, onOpenAgentNotesAtHunk);
  } else if (layout === "split" && row.type === "split-line") {
    const markerWidth = 1;
    const separatorWidth = 1;
    const usableWidth = Math.max(0, width - markerWidth - separatorWidth);
    const leftWidth = Math.max(0, Math.floor(usableWidth / 2));
    const rightWidth = Math.max(0, usableWidth - leftWidth);

    baseRow = (
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        <box style={{ width: markerWidth, height: 1 }}>
          <text fg={selected ? theme.accent : theme.panel}>{marker(selected)}</text>
        </box>
        {renderSplitCell(row.left, leftWidth, lineNumberDigits, theme, `${row.key}:left`)}
        <box
          style={{
            width: separatorWidth,
            height: 1,
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.border}>│</text>
        </box>
        {renderSplitCell(row.right, rightWidth, lineNumberDigits, theme, `${row.key}:right`)}
      </box>
    );
  } else if (row.type === "stack-line") {
    baseRow = (
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        <box style={{ width: 1, height: 1 }}>
          <text fg={selected ? theme.accent : theme.panel}>{marker(selected)}</text>
        </box>
        {renderStackCell(row.cell, Math.max(0, width - 1), lineNumberDigits, theme, `${row.key}:stack`)}
      </box>
    );
  } else {
    baseRow = (
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>Unsupported row.</text>
      </box>
    );
  }

  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {baseRow}
      {renderAnchoredNotes(anchoredNotes, file, width, theme, onDismissAgentNote)}
    </box>
  );
}

interface DiffRowViewProps {
  row: DiffRow;
  file: DiffFile;
  layout: Exclude<LayoutMode, "auto">;
  width: number;
  lineNumberDigits: number;
  theme: AppTheme;
  selected: boolean;
  annotated: boolean;
  anchoredNotes: VisibleAgentNote[];
  onDismissAgentNote?: (id: string) => void;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
}

const DiffRowView = memo(
  function DiffRowViewComponent({
    row,
    file,
    layout,
    width,
    lineNumberDigits,
    theme,
    selected,
    annotated,
    anchoredNotes,
    onDismissAgentNote,
    onOpenAgentNotesAtHunk,
  }: DiffRowViewProps) {
    return renderRow(
      row,
      file,
      layout,
      width,
      lineNumberDigits,
      theme,
      selected,
      annotated,
      anchoredNotes,
      onDismissAgentNote,
      onOpenAgentNotesAtHunk,
    );
  },
  (previous, next) => {
    return (
      previous.row === next.row &&
      previous.file === next.file &&
      previous.layout === next.layout &&
      previous.width === next.width &&
      previous.lineNumberDigits === next.lineNumberDigits &&
      previous.theme === next.theme &&
      previous.selected === next.selected &&
      previous.annotated === next.annotated &&
      previous.anchoredNotes === next.anchoredNotes
    );
  },
);

export function PierreDiffView({
  annotatedHunkIndices = EMPTY_ANNOTATED_HUNK_INDICES,
  file,
  layout,
  onDismissAgentNote,
  onOpenAgentNotesAtHunk,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  width,
  selectedHunkIndex,
  scrollable = true,
}: {
  annotatedHunkIndices?: Set<number>;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onDismissAgentNote?: (id: string) => void;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  width: number;
  selectedHunkIndex: number;
  scrollable?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedDiffCode | null>(null);
  const [highlightedFileId, setHighlightedFileId] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setHighlighted(null);
      setHighlightedFileId(null);
      return;
    }

    if (highlightedFileId === file.id) {
      return;
    }

    let cancelled = false;
    setHighlighted(null);

    loadHighlightedDiff(file)
      .then((nextHighlighted) => {
        if (cancelled) {
          return;
        }

        setHighlighted(nextHighlighted);
        setHighlightedFileId(file.id);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setHighlighted({
          deletionLines: [],
          additionLines: [],
        });
        setHighlightedFileId(file.id);
      });

    return () => {
      cancelled = true;
    };
  }, [file, highlightedFileId]);

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

  const rows = useMemo(
    () => (layout === "split" ? buildSplitRows(file, highlighted, theme) : buildStackRows(file, highlighted, theme)),
    [file, highlighted, layout, theme],
  );
  const anchoredNotes = useMemo(
    () => buildAnchoredNotes(rows, visibleAgentNotes, selectedHunkIndex),
    [rows, selectedHunkIndex, visibleAgentNotes],
  );
  const lineNumberDigits = useMemo(() => String(findMaxLineNumber(file)).length, [file]);
  const content = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {rows.map((row) => (
        <DiffRowView
          key={row.key}
          row={row}
          file={file}
          layout={layout}
          width={width}
          lineNumberDigits={lineNumberDigits}
          theme={theme}
          selected={row.hunkIndex === selectedHunkIndex}
          annotated={row.type === "hunk-header" && annotatedHunkIndices.has(row.hunkIndex)}
          anchoredNotes={anchoredNotes.get(row.key) ?? EMPTY_VISIBLE_AGENT_NOTES}
          onDismissAgentNote={onDismissAgentNote}
          onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
        />
      ))}
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
