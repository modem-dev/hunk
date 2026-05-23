import type { DiffFile, LayoutMode } from "../../core/types";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import type { AppTheme } from "../themes";
import { findMaxLineNumber, findMaxLineNumberInRows } from "./codeColumns";
import { expandCollapsedRows, type FileSourceStatus } from "./expandCollapsedRows";
import {
  buildSplitRows,
  buildStackRows,
  type HighlightedDiffCode,
  type RenderSpan,
} from "./pierre";
import { buildReviewRenderPlan, type PlannedReviewRow } from "./reviewRenderPlan";

const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

export interface DiffSectionRowPlan {
  lineNumberDigits: number;
  plannedRows: PlannedReviewRow[];
}

export interface BuildDiffSectionRowPlanOptions {
  expandedKeys?: ReadonlySet<string>;
  file: DiffFile | undefined;
  highlightedDiff?: HighlightedDiffCode | null;
  layout: Exclude<LayoutMode, "auto">;
  showHunkHeaders: boolean;
  sourceLineSpans?: (line: string | undefined, sourceLineNumber: number) => RenderSpan[];
  sourceStatus?: FileSourceStatus | undefined;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
}

/** Build Pierre rows for one file using the selected terminal diff layout. */
function buildBaseRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  highlightedDiff: HighlightedDiffCode | null | undefined,
  theme: AppTheme,
) {
  return layout === "split"
    ? buildSplitRows(file, highlightedDiff ?? null, theme)
    : buildStackRows(file, highlightedDiff ?? null, theme);
}

/** Build the shared file-level diff plan consumed by rendering and geometry measurement. */
export function buildDiffSectionRowPlan({
  expandedKeys = EMPTY_EXPANDED_GAP_KEYS,
  file,
  highlightedDiff = null,
  layout,
  showHunkHeaders,
  sourceLineSpans,
  sourceStatus,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
}: BuildDiffSectionRowPlanOptions): DiffSectionRowPlan {
  if (!file) {
    return {
      lineNumberDigits: 1,
      plannedRows: [],
    };
  }

  const baseRows = buildBaseRows(file, layout, highlightedDiff, theme);
  const expansionSide = file.metadata.type === "deleted" ? "old" : "new";
  const rows = expandCollapsedRows(baseRows, {
    layout,
    expandedKeys,
    sourceLineSpans,
    sourceStatus,
    side: expansionSide,
  });

  return {
    lineNumberDigits: String(findMaxLineNumberInRows(rows, findMaxLineNumber(file))).length,
    plannedRows: buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders,
      visibleAgentNotes,
    }),
  };
}
