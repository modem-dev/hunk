import type { DiffFile, LayoutMode } from "../../core/types";
import { measureAgentInlineNoteHeight } from "../components/panes/AgentInlineNote";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import type { SectionGeometry, VerticalBounds } from "../lib/diffSpatial";
import { reviewRowId } from "../lib/ids";
import type { AppTheme } from "../themes";
import { findMaxLineNumber } from "./codeColumns";
import { buildDiffSectionRowPlan, type DiffSectionRowPlan } from "./diffSectionRowPlan";
import { type FileSourceStatus } from "./expandCollapsedRows";
import {
  plannedReviewRowContributesToHunkBounds,
  type PlannedHunkBounds,
} from "./plannedReviewRows";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import { measureRenderedRowHeight } from "./renderRows";

const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();

export interface DiffSectionRowBounds extends VerticalBounds {
  key: string;
  stableKey: string;
  stableKeys: string[];
}

/**
 * Cached placeholder sizing and hunk navigation geometry for one file section.
 *
 * `plannedRows` is retained alongside the row-bounds map so downstream features (notably
 * clipboard rendering of mouse selections) can re-render the exact same rows the layout was
 * measured against, without rebuilding the plan. The cache is owned by the immutable DiffFile
 * object and includes note content in its key, so memory grows with visible diff lifetimes.
 */
export interface DiffSectionGeometry extends SectionGeometry<PlannedHunkBounds> {
  lineNumberDigits: number;
  plannedRows: PlannedReviewRow[];
  rowBounds: DiffSectionRowBounds[];
  rowBoundsByKey: Map<string, DiffSectionRowBounds>;
  rowBoundsByStableKey: Map<string, DiffSectionRowBounds>;
}

/** Fingerprint loaded source text so same-length edits invalidate geometry. */
function sourceTextFingerprint(text: string) {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** Stable suffix that captures note content/order for the geometry cache key. */
function notesCacheKey(visibleAgentNotes: VisibleAgentNote[]) {
  if (visibleAgentNotes.length === 0) {
    return "";
  }

  return `:notes:${visibleAgentNotes
    .map(({ annotation }) => {
      const key = JSON.stringify({
        author: annotation.author,
        id: annotation.id,
        newRange: annotation.newRange,
        oldRange: annotation.oldRange,
        rationale: annotation.rationale,
        source: annotation.source,
        summary: annotation.summary,
        title: annotation.title,
      });
      return `${key.length}:${key}`;
    })
    .join("")}`;
}

/** Stable suffix that captures expansion state for the geometry cache key. */
function expansionCacheKey(
  expandedKeys: ReadonlySet<string>,
  sourceStatus: FileSourceStatus | undefined,
) {
  if (expandedKeys.size === 0) {
    return "";
  }

  const sortedKeys = [...expandedKeys].sort().join(",");
  const statusKey =
    sourceStatus === undefined
      ? "pending"
      : sourceStatus.kind === "loaded"
        ? `loaded:${sourceTextFingerprint(sourceStatus.text)}`
        : sourceStatus.kind;
  return `:${sortedKeys}:${statusKey}`;
}

// Cache geometry by immutable DiffFile object so hunk navigation can survive parent re-renders
// without rebuilding every file section. Replaced file objects naturally drop from the WeakMap.
const SECTION_GEOMETRY_CACHE = new WeakMap<DiffFile, Map<string, DiffSectionGeometry>>();

interface DiffSectionRowHeightOptions {
  layout: Exclude<LayoutMode, "auto">;
  lineNumberDigits: number;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  reserveAddNoteColumn: boolean;
  theme: AppTheme;
  width: number;
  wrapLines: boolean;
}

/** Bundle the layout inputs needed to measure rows from a shared section row plan. */
function buildDiffSectionRowHeightOptions(
  rowPlan: DiffSectionRowPlan,
  {
    layout,
    showHunkHeaders,
    showLineNumbers,
    reserveAddNoteColumn,
    theme,
    width,
    wrapLines,
  }: Omit<DiffSectionRowHeightOptions, "lineNumberDigits">,
): DiffSectionRowHeightOptions {
  return {
    layout,
    lineNumberDigits: rowPlan.lineNumberDigits,
    showHunkHeaders,
    reserveAddNoteColumn,
    showLineNumbers,
    theme,
    width,
    wrapLines,
  };
}

/** Measure how many terminal rows one planned row occupies in a concrete section row plan. */
function measurePlannedDiffSectionRowHeight(
  row: PlannedReviewRow,
  {
    layout,
    lineNumberDigits,
    showHunkHeaders,
    reserveAddNoteColumn,
    showLineNumbers,
    theme,
    width,
    wrapLines,
  }: DiffSectionRowHeightOptions,
) {
  if (row.kind === "inline-note") {
    return measureAgentInlineNoteHeight({
      annotation: row.annotation,
      anchorSide: row.anchorSide,
      layout,
      width,
    });
  }

  return measureRenderedRowHeight(
    row.row,
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    theme,
    reserveAddNoteColumn,
  );
}

/** Measure one file section from the same render plan used by PierreDiffView. */
export function measureDiffSectionGeometry(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
  visibleAgentNotes: VisibleAgentNote[] = [],
  width = 0,
  showLineNumbers = true,
  wrapLines = false,
  expandedKeys: ReadonlySet<string> = EMPTY_EXPANDED_GAP_KEYS,
  sourceStatus: FileSourceStatus | undefined = undefined,
  reserveAddNoteColumn = false,
): DiffSectionGeometry {
  if (file.metadata.hunks.length === 0) {
    return {
      bodyHeight: 1,
      hunkAnchorRows: new Map(),
      hunkBounds: new Map(),
      lineNumberDigits: String(findMaxLineNumber(file)).length,
      plannedRows: [],
      rowBounds: [],
      rowBoundsByKey: new Map(),
      rowBoundsByStableKey: new Map(),
    };
  }

  // Width, wrapping, and line-number visibility all affect rendered row heights, so they must
  // participate in the cache key alongside the structural file/layout inputs. Expansion state
  // changes the row stream, so it has to participate too.
  const cacheKey = `${file.id}:${layout}:${showHunkHeaders ? 1 : 0}:${theme.id}:${width}:${showLineNumbers ? 1 : 0}:${wrapLines ? 1 : 0}:${reserveAddNoteColumn ? 1 : 0}${expansionCacheKey(expandedKeys, sourceStatus)}${notesCacheKey(visibleAgentNotes)}`;
  const cachedByFile = SECTION_GEOMETRY_CACHE.get(file);
  const cached = cachedByFile?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sectionRowPlan = buildDiffSectionRowPlan({
    expandedKeys,
    file,
    layout,
    showHunkHeaders,
    sourceStatus,
    theme,
    visibleAgentNotes,
  });
  const { plannedRows } = sectionRowPlan;
  const hunkAnchorRows = new Map<number, number>();
  const hunkBounds = new Map<number, PlannedHunkBounds>();
  const rowBounds: DiffSectionRowBounds[] = [];
  const rowBoundsByKey = new Map<string, DiffSectionRowBounds>();
  const rowBoundsByStableKey = new Map<string, DiffSectionRowBounds>();
  const lineNumberDigits = sectionRowPlan.lineNumberDigits;
  const rowHeightOptions = buildDiffSectionRowHeightOptions(sectionRowPlan, {
    layout,
    showHunkHeaders,
    reserveAddNoteColumn,
    showLineNumbers,
    theme,
    width,
    wrapLines,
  });
  let bodyHeight = 0;

  for (const row of plannedRows) {
    if (row.kind === "diff-row" && row.anchorId && !hunkAnchorRows.has(row.hunkIndex)) {
      hunkAnchorRows.set(row.hunkIndex, bodyHeight);
    }

    const height = measurePlannedDiffSectionRowHeight(row, rowHeightOptions);
    const stableKeys = [
      row.stableKey,
      ...(row.kind === "diff-row" ? (row.stableAliasKeys ?? []) : []),
    ];
    const rowBoundsEntry = {
      key: row.key,
      stableKey: row.stableKey,
      stableKeys,
      // Record both the starting top and the measured height so callers can translate between
      // scroll positions and stable review-row identities across wrap/layout changes.
      top: bodyHeight,
      height,
    };
    rowBounds.push(rowBoundsEntry);
    rowBoundsByKey.set(row.key, rowBoundsEntry);
    for (const stableKey of stableKeys) {
      if (!rowBoundsByStableKey.has(stableKey)) {
        rowBoundsByStableKey.set(stableKey, rowBoundsEntry);
      }
    }

    if (height > 0 && plannedReviewRowContributesToHunkBounds(row)) {
      const rowId = reviewRowId(row.key);
      const existingBounds = hunkBounds.get(row.hunkIndex);

      if (existingBounds) {
        existingBounds.endRowId = rowId;
        existingBounds.height += height;
      } else {
        hunkBounds.set(row.hunkIndex, {
          top: bodyHeight,
          height,
          startRowId: rowId,
          endRowId: rowId,
        });
      }
    }

    bodyHeight += height;
  }

  const geometry: DiffSectionGeometry = {
    bodyHeight,
    hunkAnchorRows,
    hunkBounds,
    lineNumberDigits,
    plannedRows,
    rowBounds,
    rowBoundsByKey,
    rowBoundsByStableKey,
  };

  const nextCachedByFile = cachedByFile ?? new Map();
  nextCachedByFile.set(cacheKey, geometry);
  SECTION_GEOMETRY_CACHE.set(file, nextCachedByFile);

  return geometry;
}

/** Estimate the number of diff-body rows for one file section in the windowed path. */
export function estimateDiffSectionBodyRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
) {
  return measureDiffSectionGeometry(file, layout, showHunkHeaders, theme).bodyHeight;
}

/** Estimate the body-row position for the anchor that should represent the selected hunk. */
export function estimateHunkAnchorBodyRow(
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
    measureDiffSectionGeometry(file, layout, showHunkHeaders, theme).hunkAnchorRows.get(
      clampedHunkIndex,
    ) ?? 0
  );
}
