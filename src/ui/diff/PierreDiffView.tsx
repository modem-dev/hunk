import { useMemo } from "react";
import type { DiffFile, LayoutMode } from "../../core/types";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { diffHunkId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { buildSelectedOverlayNote, renderAgentPopover } from "./agentNoteOverlay";
import { buildSplitRows, buildStackRows } from "./pierre";
import {
  diffMessage,
  DiffRowView,
  findMaxLineNumber,
  fitText,
  measureRenderedRowHeight,
} from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

/** Render a file diff in split or stack mode, with a floating agent-note popover overlay. */
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
  const rowMetrics = useMemo(() => {
    const metrics = new Map<string, { height: number; top: number }>();
    let offset = 0;

    for (const row of rows) {
      const height = measureRenderedRowHeight(
        row,
        width,
        lineNumberDigits,
        showLineNumbers,
        showHunkHeaders,
        wrapLines,
        theme,
      );
      metrics.set(row.key, { top: offset, height });
      offset += height;
    }

    return {
      metrics,
      contentHeight: offset,
    };
  }, [lineNumberDigits, rows, showHunkHeaders, showLineNumbers, theme, width, wrapLines]);
  const selectedOverlayNote = useMemo(
    () =>
      buildSelectedOverlayNote(
        rows,
        visibleAgentNotes,
        selectedHunkIndex,
        showHunkHeaders,
        width,
        lineNumberDigits,
        showLineNumbers,
      ),
    [
      lineNumberDigits,
      rows,
      selectedHunkIndex,
      showHunkHeaders,
      showLineNumbers,
      visibleAgentNotes,
      width,
    ],
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
      {rows.map((row) => (
        <DiffRowView
          key={row.key}
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
          onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
        />
      ))}
    </box>
  );
  const contentWithOverlay = (
    <box style={{ width: "100%", position: "relative", overflow: "visible" }}>
      {content}
      {renderAgentPopover(
        selectedOverlayNote,
        file,
        width,
        rowMetrics.contentHeight,
        rowMetrics.metrics,
        theme,
        onDismissAgentNote,
      )}
    </box>
  );

  if (!scrollable) {
    return contentWithOverlay;
  }

  return (
    <scrollbox width="100%" height="100%" scrollY={true} viewportCulling={true} focused={false}>
      {contentWithOverlay}
    </scrollbox>
  );
}
