import type { DiffFile, LayoutMode } from "../../core/types";
import { measureAgentInlineNoteHeight } from "../components/panes/AgentInlineNote";
import { findMaxLineNumber, findMaxLineNumberInRows } from "../diff/codeColumns";
import { expandCollapsedRows, type FileSourceStatus } from "../diff/expandCollapsedRows";
import { buildSplitRows, buildStackRows } from "../diff/pierre";
import { measureRenderedRowHeight } from "../diff/renderRows";
import {
  plannedReviewRowContributesToHunkBounds,
  type PlannedHunkBounds,
} from "../diff/plannedReviewRows";
import { buildReviewRenderPlan, type PlannedReviewRow } from "../diff/reviewRenderPlan";
import type { SectionGeometry, VerticalBounds } from "./diffSpatial";
import { reviewRowId } from "./ids";
import type { VisibleAgentNote } from "./agentAnnotations";
import type { AppTheme } from "../themes";

const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();

export interface DiffSectionRowBounds extends VerticalBounds {
  key: string;
  stableKey: string;
  stableKeys: string[];
}

/** Cached placeholder sizing and hunk navigation geometry for one file section. */
export interface DiffSectionGeometry extends SectionGeometry<PlannedHunkBounds> {
  rowBounds: DiffSectionRowBounds[];
  rowBoundsByKey: Map<string, DiffSectionRowBounds>;
  rowBoundsByStableKey: Map<string, DiffSectionRowBounds>;
}

const NOTE_AWARE_SECTION_GEOMETRY_CACHE = new WeakMap<
  VisibleAgentNote[],
  Map<string, DiffSectionGeometry>
>();

/** Build the exact review rows for one file before converting them into section geometry. */
function buildBasePlannedRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
  visibleAgentNotes: VisibleAgentNote[],
  expandedKeys: ReadonlySet<string>,
  sourceStatus: FileSourceStatus | undefined,
) {
  const baseRows =
    layout === "split" ? buildSplitRows(file, null, theme) : buildStackRows(file, null, theme);
  const side = file.metadata.type === "deleted" ? "old" : "new";
  const rows = expandCollapsedRows(baseRows, {
    layout,
    expandedKeys,
    sourceStatus,
    side,
  });

  return {
    plannedRows: buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: -1,
      showHunkHeaders,
      visibleAgentNotes,
    }),
    rows,
  };
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

/** Measure how many terminal rows one planned review row occupies for the current view settings. */
function plannedRowHeight(
  row: PlannedReviewRow,
  showHunkHeaders: boolean,
  layout: Exclude<LayoutMode, "auto">,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  wrapLines: boolean,
  theme: AppTheme,
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

  return measureRenderedRowHeight(
    row.row,
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    theme,
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
): DiffSectionGeometry {
  if (file.metadata.hunks.length === 0) {
    return {
      bodyHeight: 1,
      hunkAnchorRows: new Map(),
      hunkBounds: new Map(),
      rowBounds: [],
      rowBoundsByKey: new Map(),
      rowBoundsByStableKey: new Map(),
    };
  }

  // Width, wrapping, and line-number visibility all affect rendered row heights, so they must
  // participate in the cache key alongside the structural file/layout inputs. Expansion state
  // changes the row stream, so it has to participate too.
  const cacheKey = `${file.id}:${layout}:${showHunkHeaders ? 1 : 0}:${theme.id}:${width}:${showLineNumbers ? 1 : 0}:${wrapLines ? 1 : 0}${expansionCacheKey(expandedKeys, sourceStatus)}`;
  if (visibleAgentNotes.length > 0) {
    const cachedByNotes = NOTE_AWARE_SECTION_GEOMETRY_CACHE.get(visibleAgentNotes);
    const cached = cachedByNotes?.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const { plannedRows, rows } = buildBasePlannedRows(
    file,
    layout,
    showHunkHeaders,
    theme,
    visibleAgentNotes,
    expandedKeys,
    sourceStatus,
  );
  const hunkAnchorRows = new Map<number, number>();
  const hunkBounds = new Map<number, PlannedHunkBounds>();
  const rowBounds: DiffSectionRowBounds[] = [];
  const rowBoundsByKey = new Map<string, DiffSectionRowBounds>();
  const rowBoundsByStableKey = new Map<string, DiffSectionRowBounds>();
  const lineNumberDigits = String(findMaxLineNumberInRows(rows, findMaxLineNumber(file))).length;
  let bodyHeight = 0;

  for (const row of plannedRows) {
    if (row.kind === "diff-row" && row.anchorId && !hunkAnchorRows.has(row.hunkIndex)) {
      hunkAnchorRows.set(row.hunkIndex, bodyHeight);
    }

    const height = plannedRowHeight(
      row,
      showHunkHeaders,
      layout,
      width,
      lineNumberDigits,
      showLineNumbers,
      wrapLines,
      theme,
    );
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
    rowBounds,
    rowBoundsByKey,
    rowBoundsByStableKey,
  };

  if (visibleAgentNotes.length > 0) {
    const cachedByNotes = NOTE_AWARE_SECTION_GEOMETRY_CACHE.get(visibleAgentNotes) ?? new Map();
    cachedByNotes.set(cacheKey, geometry);
    NOTE_AWARE_SECTION_GEOMETRY_CACHE.set(visibleAgentNotes, cachedByNotes);
  }

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
