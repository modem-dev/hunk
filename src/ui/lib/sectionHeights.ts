import type { DiffFile, LayoutMode } from "../../core/types";
import { buildSplitRows, buildStackRows } from "../diff/pierre";
import { measurePlannedHunkBounds, type PlannedHunkBounds } from "../diff/plannedReviewRows";
import { buildReviewRenderPlan } from "../diff/reviewRenderPlan";
import type { VisibleAgentNote } from "./agentAnnotations";
import type { AppTheme } from "../themes";

/** Cached placeholder sizing and hunk navigation metrics for one file section. */
export interface DiffSectionMetrics {
  bodyHeight: number;
  hunkAnchorRows: Map<number, number>;
  hunkBounds: Map<number, PlannedHunkBounds>;
}

const NOTE_AWARE_SECTION_METRICS_CACHE = new WeakMap<
  VisibleAgentNote[],
  Map<string, DiffSectionMetrics>
>();

/** Build the same planned rows the renderer will consume, but without requiring mounted UI. */
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

/**
 * Measure one file section from the same render plan used by PierreDiffView.
 * This drives the windowed review stream and keeps scrolling and rendering aligned.
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
      hunkBounds: new Map(),
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
  // Reuse the same bounds pass as the live renderer so placeholder sizing and navigation math stay
  // in lock-step with what the user actually sees.
  const metrics = measurePlannedHunkBounds(plannedRows, {
    showHunkHeaders,
    layout,
    width,
  });

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
