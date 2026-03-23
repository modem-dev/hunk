import type { DiffFile, LayoutMode } from "../../core/types";
import { measureAgentInlineNoteHeight } from "../components/panes/AgentInlineNote";
import { buildSplitRows, buildStackRows } from "../diff/pierre";
import { buildReviewRenderPlan, type PlannedReviewRow } from "../diff/reviewRenderPlan";
import type { VisibleAgentNote } from "./agentAnnotations";
import type { AppTheme } from "../themes";

export interface DiffSectionMetrics {
  bodyHeight: number;
  hunkAnchorRows: Map<number, number>;
}

const NOTE_AWARE_SECTION_METRICS_CACHE = new WeakMap<
  VisibleAgentNote[],
  Map<string, DiffSectionMetrics>
>();

function buildBasePlannedRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
  visibleAgentNotes: VisibleAgentNote[],
) {
  const rows =
    layout === "split" ? buildSplitRows(file, null, theme) : buildStackRows(file, null, theme);

  return buildReviewRenderPlan({
    fileId: file.id,
    rows,
    selectedHunkIndex: -1,
    showHunkHeaders,
    visibleAgentNotes,
  });
}

function plannedRowHeight(
  row: PlannedReviewRow,
  showHunkHeaders: boolean,
  layout: Exclude<LayoutMode, "auto">,
  width: number,
) {
  if (row.kind === "inline-note") {
    return measureAgentInlineNoteHeight({
      annotation: row.annotation,
      anchorSide: row.anchorSide,
      layout,
      width,
    });
  }

  if (row.kind === "note-guide-cap") {
    return 1;
  }

  if (row.row.type === "hunk-header") {
    return showHunkHeaders ? 1 : 0;
  }

  return 1;
}

/**
 * Measure one file section from the same render plan used by PierreDiffView.
 * This drives the no-wrap/no-note windowing path, where every visible planned row is one terminal row.
 */
export function measureDiffSectionMetrics(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
  visibleAgentNotes: VisibleAgentNote[] = [],
  width = 0,
): DiffSectionMetrics {
  if (file.metadata.hunks.length === 0) {
    return {
      bodyHeight: 1,
      hunkAnchorRows: new Map(),
    };
  }

  const cacheKey = `${file.id}:${layout}:${showHunkHeaders ? 1 : 0}:${theme.id}:${width}`;
  if (visibleAgentNotes.length > 0) {
    const cachedByNotes = NOTE_AWARE_SECTION_METRICS_CACHE.get(visibleAgentNotes);
    const cached = cachedByNotes?.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const plannedRows = buildBasePlannedRows(file, layout, showHunkHeaders, theme, visibleAgentNotes);
  const hunkAnchorRows = new Map<number, number>();
  let bodyHeight = 0;

  for (const row of plannedRows) {
    if (row.kind === "diff-row" && row.anchorId && !hunkAnchorRows.has(row.hunkIndex)) {
      hunkAnchorRows.set(row.hunkIndex, bodyHeight);
    }

    bodyHeight += plannedRowHeight(row, showHunkHeaders, layout, width);
  }

  const metrics = {
    bodyHeight,
    hunkAnchorRows,
  };

  if (visibleAgentNotes.length > 0) {
    const cachedByNotes = NOTE_AWARE_SECTION_METRICS_CACHE.get(visibleAgentNotes) ?? new Map();
    cachedByNotes.set(cacheKey, metrics);
    NOTE_AWARE_SECTION_METRICS_CACHE.set(visibleAgentNotes, cachedByNotes);
  }

  return metrics;
}

/** Estimate the number of diff-body rows for one file in the windowed path. */
export function estimateDiffBodyRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
) {
  return measureDiffSectionMetrics(file, layout, showHunkHeaders, theme).bodyHeight;
}

/** Estimate the body-row offset for the anchor that should represent the selected hunk. */
export function estimateHunkAnchorRow(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  hunkIndex: number,
  theme: AppTheme,
) {
  if (file.metadata.hunks.length === 0) {
    return 0;
  }

  const clampedHunkIndex = Math.max(0, Math.min(hunkIndex, file.metadata.hunks.length - 1));
  return (
    measureDiffSectionMetrics(file, layout, showHunkHeaders, theme).hunkAnchorRows.get(
      clampedHunkIndex,
    ) ?? 0
  );
}
