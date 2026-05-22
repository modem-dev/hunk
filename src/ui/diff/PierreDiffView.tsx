import { useMemo } from "react";
import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { DiffFile, LayoutMode } from "../../core/types";
import type { DiffSide } from "../../hunk-session/types";
import { AgentInlineNote, AgentInlineNoteGuideCap } from "../components/panes/AgentInlineNote";
import { CommentComposer } from "../components/panes/CommentComposer";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { clickTargetForDiffRow } from "../lib/commentCursor";
import type { DiffSectionGeometry } from "../lib/diffSectionGeometry";
import { COMMENT_CURSOR_ANCHOR_ID, reviewRowId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { findMaxLineNumber } from "./codeColumns";
import { buildSplitRows, buildStackRows } from "./pierre";
import { plannedReviewRowVisible } from "./plannedReviewRows";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { resolveVisiblePlannedRowWindow, type VisibleBodyBounds } from "./rowWindowing";
import { diffMessage, DiffRowView, fitText } from "./renderRows";
import { useHighlightedDiff } from "./useHighlightedDiff";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

/** Render a file diff in split or stack mode, with inline agent notes inserted between diff rows. */
export function PierreDiffView({
  annotatedHunkIndices = EMPTY_ANNOTATED_HUNK_INDICES,
  codeHorizontalOffset = 0,
  commentCursorRowStableKey,
  composer,
  file,
  layout,
  onCommentComposerCancel,
  onCommentComposerSubmit,
  onOpenAgentNotesAtHunk,
  onSelectCommentTarget,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  width,
  selectedHunkIndex,
  sectionGeometry,
  shouldLoadHighlight = true,
  scrollable = true,
  visibleBodyBounds,
}: {
  annotatedHunkIndices?: Set<number>;
  codeHorizontalOffset?: number;
  commentCursorRowStableKey?: string | null;
  composer?: {
    fileId: string;
    hunkIndex: number;
    side: "old" | "new";
    line: number;
  } | null;
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  onCommentComposerCancel?: () => void;
  onCommentComposerSubmit?: (summary: string) => void;
  onOpenAgentNotesAtHunk?: (hunkIndex: number) => void;
  onSelectCommentTarget?: (target: { hunkIndex: number; side: DiffSide; line: number }) => void;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  width: number;
  selectedHunkIndex: number;
  sectionGeometry?: DiffSectionGeometry;
  shouldLoadHighlight?: boolean;
  scrollable?: boolean;
  visibleBodyBounds?: VisibleBodyBounds;
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
            composer: composer ?? null,
          })
        : [],
    [composer, file, rows, showHunkHeaders, visibleAgentNotes],
  );
  const lineNumberDigits = useMemo(() => String(file ? findMaxLineNumber(file) : 1).length, [file]);
  const visiblePlannedRowWindow = useMemo(() => {
    // Fall back to the full row list unless all three row-windowing inputs are ready:
    // - the complete planned row stream for this file
    // - measured per-row geometry for that same stream
    // - one file-local visible body slice from DiffPane
    // The helper relies on those structures staying in lockstep, so any missing input means
    // "render everything" instead of risking a mismatched partial slice.
    if (!sectionGeometry || !visibleBodyBounds) {
      return {
        bottomSpacerHeight: 0,
        plannedRows,
        topSpacerHeight: 0,
      };
    }

    // `visibleBodyBounds` is already relative to this file body, not the whole review stream.
    // Example: if DiffPane says "mount rows 120..260 within package-lock.json", this helper keeps
    // only the planned rows whose measured bounds overlap that interval.
    //
    // The return value is not just the sliced rows. It also includes spacer heights for the skipped
    // region above and below so the file still occupies its original total body height inside the
    // scroll stream. That lets navigation, sticky headers, and reveal math keep using the same
    // absolute geometry even though most rows are temporarily unmounted.
    return resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds,
    });
  }, [plannedRows, sectionGeometry, visibleBodyBounds]);

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
      {visiblePlannedRowWindow.topSpacerHeight > 0 ? (
        // Reserve the skipped height above the mounted slice so the file body keeps its original
        // absolute row positions inside the larger review stream.
        <box
          style={{
            width: "100%",
            height: visiblePlannedRowWindow.topSpacerHeight,
            backgroundColor: theme.panel,
          }}
        />
      ) : null}
      {visiblePlannedRowWindow.plannedRows.map((plannedRow) => {
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

        if (plannedRow.kind === "comment-composer") {
          return (
            <box key={plannedRow.key} id={rowId} style={{ width: "100%", flexDirection: "column" }}>
              <CommentComposer
                filePath={file.path}
                hunkIndex={plannedRow.hunkIndex}
                line={plannedRow.line}
                side={plannedRow.side}
                theme={theme}
                width={width}
                onCancel={() => onCommentComposerCancel?.()}
                onSubmit={(summary) => onCommentComposerSubmit?.(summary)}
              />
            </box>
          );
        }

        const isCursorRow = Boolean(
          commentCursorRowStableKey &&
          (plannedRow.stableKey === commentCursorRowStableKey ||
            plannedRow.stableAliasKeys?.includes(commentCursorRowStableKey)),
        );
        // Resolve the click target up front so the wrapper only registers a handler when the
        // clicked row is actually commentable (additions and deletions, not context/headers).
        const clickTarget = onSelectCommentTarget ? clickTargetForDiffRow(plannedRow.row) : null;
        // OpenTUI's renderer auto-focuses the nearest focusable ancestor on left-button mouseDown
        // unless the event has had preventDefault() called. The diff scrollbox is focusable, so a
        // bare click would steer arrow keys into its internal scroll handler *in parallel* with
        // the cursor hook. Suppressing the default on mouseDown keeps focus where it was and lets
        // the cursor hook be the sole owner of arrow keys.
        const handleRowMouseDown = clickTarget
          ? (event: TuiMouseEvent) => {
              event.preventDefault();
            }
          : undefined;
        const handleRowMouseUp = clickTarget
          ? (event: TuiMouseEvent) => {
              event.stopPropagation();
              onSelectCommentTarget?.(clickTarget);
            }
          : undefined;

        const diffRowView = (
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
            isCursor={isCursorRow}
          />
        );

        return (
          <box
            key={plannedRow.key}
            id={rowId}
            style={{ width: "100%", flexDirection: "column" }}
            onMouseDown={handleRowMouseDown}
            onMouseUp={handleRowMouseUp}
          >
            {isCursorRow ? (
              // Tag the active cursor row with a constant id so the scroll engine can target it
              // via scrollChildIntoView when the cursor moves out of the viewport.
              <box id={COMMENT_CURSOR_ANCHOR_ID} style={{ width: "100%", flexDirection: "column" }}>
                {diffRowView}
              </box>
            ) : (
              diffRowView
            )}
          </box>
        );
      })}
      {visiblePlannedRowWindow.bottomSpacerHeight > 0 ? (
        // Mirror that reservation below the mounted slice so total file-body height stays stable.
        <box
          style={{
            width: "100%",
            height: visiblePlannedRowWindow.bottomSpacerHeight,
            backgroundColor: theme.panel,
          }}
        />
      ) : null}
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
