/** @jsxImportSource react */
/**
 * Draws one file of the review stream: its sticky header and its body.
 *
 * The header shows what the terminal's file header shows — change-kind letter, the path with
 * `old -> new` for a rename and a state suffix, and right-aligned `+A -D` — from the shared
 * labels in `core/review/fileLabels.ts`. The body is Pierre once the file is near the
 * viewport, a placeholder for a file with nothing to render (its reason from the shared
 * model, its wording this page's own), or space reserved from the file's row count while the
 * file is still loading or far away.
 */
import { memo, useMemo, type CSSProperties } from "react";
import type { ReviewEmptyDiffReason } from "../../core/review/document";
import type { ReviewStoredNote } from "../../core/review/state";
import type { ReviewAgentHighlightV1, ReviewSharedNoteV1 } from "../../session/reviewSharedState";
import { planReviewFileNotes } from "../notes/noteProjection";
import { reviewFileChangeGlyph, reviewFileLabelParts } from "../../core/review/fileLabels";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import type { ReviewFileRenderPlan } from "./fileProjection";
import type { ReviewFileGeometry } from "./hunkGeometry";
import { PierreFileView } from "./PierreFileView";

/** Height of one Pierre row, and of the header, in CSS pixels. */
export const STREAM_ROW_HEIGHT_PX = 20;
export const STREAM_HEADER_HEIGHT_PX = 34;

/** What a file with nothing to render says, per shared reason. */
export const EMPTY_DIFF_MESSAGES: Record<ReviewEmptyDiffReason, string> = {
  "rename-only": "No textual hunks. This change only renames the file.",
  binary: "Binary file skipped",
  "too-large": "File too large to render automatically.",
  "new-file": "No textual hunks. The file is marked as new.",
  "deleted-file": "No textual hunks. The file is marked as deleted.",
  "no-hunks": "No textual hunks to render for this file.",
};

export interface FileSectionProps {
  fileKey: string;
  index?: ReviewFileIndexEntry;
  plan?: ReviewFileRenderPlan;
  mounted: boolean;
  /** Height measured the last time this file was mounted, preferred over the estimate. */
  measuredHeight?: number;
  selected: boolean;
  /** The selected hunk, when this file holds the selection. */
  selectedHunk?: number;
  layout: "split" | "unified";
  wrapLines: boolean;
  showLineNumbers: boolean;
  syntaxTheme: string;
  appearance: "light" | "dark";
  onToggleGap: (fileKey: string, gapId: string) => void;
  onCollapseGaps: (fileKey: string) => void;
  onSelectHunk: (fileKey: string, hunkIndex: number) => void;
  onGeometry: (fileKey: string, geometry: ReviewFileGeometry) => void;
  /** The page store's stored notes and visibility, passed apart so unrelated changes skip. */
  liveNotes: readonly ReviewStoredNote[];
  userNotes: readonly ReviewStoredNote[];
  showAgentNotes: boolean;
  /** The shared snapshot's sidecar annotations. */
  sidecarNotes: readonly ReviewSharedNoteV1[];
  /** This file's agent attention marks. */
  highlights: readonly ReviewAgentHighlightV1[];
}

const NO_HIGHLIGHTS: readonly ReviewAgentHighlightV1[] = [];

/** The header row for one file. */
function FileHeader({
  index,
  fileKey,
  expandedGaps,
  onCollapseGaps,
}: {
  index?: ReviewFileIndexEntry;
  fileKey: string;
  expandedGaps: number;
  onCollapseGaps: () => void;
}) {
  if (!index) {
    return (
      <header className="file-header" data-loading="">
        <span className="file-name muted">Loading file…</span>
      </header>
    );
  }
  const glyph = reviewFileChangeGlyph(index.changeKind, index.flags.untracked);
  const { filename, stateLabel } = reviewFileLabelParts({
    path: index.path,
    ...(index.previousPath !== undefined ? { previousPath: index.previousPath } : {}),
    changeKind: index.changeKind,
    untracked: index.flags.untracked,
  });
  return (
    <header className="file-header" data-file-header={fileKey}>
      <span className="file-glyph" data-role={glyph.role} aria-label={glyph.role}>
        {glyph.glyph}
      </span>
      <span className="file-name" title={`${filename}${stateLabel ?? ""}`}>
        <span className="file-path">{filename}</span>
        {stateLabel ? <span className="file-state">{stateLabel}</span> : null}
      </span>
      {expandedGaps > 0 ? (
        <button type="button" className="header-action" onClick={onCollapseGaps}>
          Hide expanded lines
        </button>
      ) : null}
      <span className="file-stats">
        <span className="stat-added">{`+${index.stats.additions}${index.stats.truncated ? "+" : ""}`}</span>{" "}
        <span className="stat-removed">{`-${index.stats.deletions}`}</span>
      </span>
    </header>
  );
}

/** Estimate a file's body height before it has ever been measured. */
export function reservedBodyHeight(
  plan: ReviewFileRenderPlan | undefined,
  index: ReviewFileIndexEntry | undefined,
  layout: "split" | "unified",
) {
  const rows = plan
    ? plan.reservedRows[layout]
    : index
      ? layout === "split"
        ? index.splitLineCount
        : index.unifiedLineCount
      : 3;
  return Math.max(1, rows) * STREAM_ROW_HEIGHT_PX;
}

/** One file of the stream. */
export const FileSection = memo(function FileSection(props: FileSectionProps) {
  const { fileKey, index, plan, mounted, measuredHeight, layout } = props;
  const expandedGaps = plan?.gaps.filter((gap) => gap.state !== "collapsed").length ?? 0;
  const { liveNotes, userNotes, showAgentNotes, sidecarNotes } = props;
  // Notes hang from lines as drawn, so expanded context counts; the plan's metadata is that.
  const noteGroups = useMemo(
    () =>
      plan?.metadata
        ? planReviewFileNotes({
            file: { key: fileKey, hunks: plan.metadata.hunks },
            state: {
              liveNotes: liveNotes as ReviewStoredNote[],
              userNotes: userNotes as ReviewStoredNote[],
              showAgentNotes,
            },
            sidecar: sidecarNotes,
          })
        : [],
    [fileKey, plan, liveNotes, userNotes, showAgentNotes, sidecarNotes],
  );
  const bodyStyle: CSSProperties | undefined =
    mounted && plan
      ? undefined
      : { height: measuredHeight ?? reservedBodyHeight(plan, index, layout) };

  return (
    <section
      className="file-section"
      data-file-key={fileKey}
      data-selected={props.selected ? "" : undefined}
      aria-label={index?.path ?? "Loading file"}
    >
      <FileHeader
        index={index}
        fileKey={fileKey}
        expandedGaps={expandedGaps}
        onCollapseGaps={() => props.onCollapseGaps(fileKey)}
      />
      <div className="file-body" style={bodyStyle}>
        {!plan ? (
          <p className="file-placeholder">Loading…</p>
        ) : plan.emptyReason ? (
          <p className="file-placeholder" data-empty-reason={plan.emptyReason}>
            {EMPTY_DIFF_MESSAGES[plan.emptyReason]}
          </p>
        ) : mounted ? (
          <PierreFileView
            plan={plan}
            layout={layout}
            wrapLines={props.wrapLines}
            showLineNumbers={props.showLineNumbers}
            syntaxTheme={props.syntaxTheme}
            appearance={props.appearance}
            onToggleGap={(gapId) => props.onToggleGap(fileKey, gapId)}
            selectedHunk={props.selectedHunk}
            onSelectHunk={(hunkIndex) => props.onSelectHunk(fileKey, hunkIndex)}
            onGeometry={(geometry) => props.onGeometry(fileKey, geometry)}
            noteGroups={noteGroups}
            highlights={props.highlights ?? NO_HIGHLIGHTS}
          />
        ) : null}
      </div>
    </section>
  );
});
