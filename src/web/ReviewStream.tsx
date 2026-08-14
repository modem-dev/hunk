/** @jsxImportSource react */
/**
 * The read-only review stream: every visible file's diff, top to bottom, in review order.
 *
 * This is the browser's half of the product rule the terminal already follows — one
 * continuous stream rather than one file at a time — and it draws nothing it derives
 * itself. What to draw comes from `pierreDocument`'s render model, which reads geometry
 * from `src/core/review/`; how a diff looks is Pierre's; this file places them.
 *
 * Two structural decisions:
 *
 * - **One Pierre render per hunk, not per file.** A collapsed region sits *between* two
 *   hunks, so drawing hunks separately is what lets the strip that describes one appear
 *   where it belongs. The isolation is the shared re-basing walk (A6), not a second one.
 * - **Presentation state stays here.** Which gaps a reader has opened is this client's
 *   business in a read-only mirror; when actions land it becomes the shared
 *   `expansion/toggle` intent instead, and this component reads the answer rather than
 *   holding it.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FileDiff } from "@pierre/diffs/react";
import type { ReviewDocumentV1, ReviewFileV1 } from "../core/review/types";
import { formatReviewAddress } from "../core/review/address";
import {
  buildReviewFileRenderModel,
  reviewExpandedGapRows,
  type ReviewExpandedRow,
  type ReviewFileRenderModel,
  type ReviewRenderGap,
} from "./pierreDocument";
import { resolveBrowserDiffStyle, type BrowserViewOptions } from "./viewOptions";

/** What a file with no rows says about itself, in this surface's wording. */
const EMPTY_DIFF_MESSAGES = {
  "rename-only": "Renamed with no content changes.",
  binary: "Binary file.",
  "too-large": "File too large to render.",
  "new-file": "New empty file.",
  "deleted-file": "File deleted.",
  "no-hunks": "No changes to show.",
} as const;

export interface ReviewStreamProps {
  document: ReviewDocumentV1;
  view: BrowserViewOptions;
  /** Width the responsive layout decides from; the window's, in a real page. */
  viewportWidth: number;
  /** Full source text per file key, for the gaps a reader has opened. */
  sourceByFileKey?: Record<string, string>;
  /** Asked for the source behind one file the first time a gap in it is opened. */
  onRequestSource?: (file: ReviewFileV1) => void;
}

/** The whole review, in the order the document lists it. */
export function ReviewStream({
  document,
  view,
  viewportWidth,
  sourceByFileKey = {},
  onRequestSource,
}: ReviewStreamProps) {
  const diffStyle = resolveBrowserDiffStyle(view.layout, viewportWidth);
  return (
    <main className="review-stream">
      {document.files.map((file) => (
        <ReviewFileSection
          key={file.key}
          file={file}
          view={view}
          diffStyle={diffStyle}
          source={sourceByFileKey[file.key]}
          {...(onRequestSource ? { onRequestSource } : {})}
        />
      ))}
    </main>
  );
}

interface ReviewFileSectionProps {
  file: ReviewFileV1;
  view: BrowserViewOptions;
  diffStyle: "split" | "unified";
  source?: string;
  onRequestSource?: (file: ReviewFileV1) => void;
}

/** One file: its header, its collapsed regions, and its hunks between them. */
function ReviewFileSection({
  file,
  view,
  diffStyle,
  source,
  onRequestSource,
}: ReviewFileSectionProps) {
  const model = buildReviewFileRenderModel(file);
  const [openGaps, setOpenGaps] = useState<ReadonlySet<string>>(() => new Set());

  // A reload replaces the file behind this section; gap ids address the geometry that was
  // published with it, so what was open cannot be carried over.
  useEffect(() => {
    setOpenGaps(new Set());
  }, [file.contentIdentity]);

  const toggleGap = useCallback(
    (gapId: string) => {
      setOpenGaps((open) => {
        const next = new Set(open);
        if (!next.delete(gapId)) {
          next.add(gapId);
          onRequestSource?.(file);
        }
        return next;
      });
    },
    [file, onRequestSource],
  );

  return (
    <section
      className="review-file"
      id={formatReviewAddress({ kind: "file", fileKey: model.fileKey })}
      aria-label={model.path}
    >
      <ReviewFileHeader model={model} />
      {model.emptyDiffReason ? (
        <p className="review-file-empty">{EMPTY_DIFF_MESSAGES[model.emptyDiffReason]}</p>
      ) : (
        model.hunks.map((hunk) => (
          <div
            key={hunk.index}
            className="review-hunk"
            id={formatReviewAddress({
              kind: "hunk",
              fileKey: model.fileKey,
              hunkIndex: hunk.index,
            })}
          >
            <GapStrip
              gap={gapBefore(model, hunk.index)}
              open={openGaps}
              file={file}
              source={source}
              onToggle={toggleGap}
              showHeader={view.showHunkHeaders}
            />
            <FileDiff
              fileDiff={hunk.fileDiff}
              options={{
                diffStyle,
                disableFileHeader: true,
                disableLineNumbers: !view.showLineNumbers,
                overflow: view.wrapLines ? "wrap" : "scroll",
                hunkSeparators: view.showHunkHeaders ? "line-info" : "simple",
              }}
            />
          </div>
        ))
      )}
      <GapStrip
        gap={model.gaps.find((gap) => gap.position === "trailing")}
        open={openGaps}
        file={file}
        source={source}
        onToggle={toggleGap}
        showHeader={view.showHunkHeaders}
      />
    </section>
  );
}

/** The collapsed region immediately before one hunk, when the file has one. */
function gapBefore(model: ReviewFileRenderModel, hunkIndex: number): ReviewRenderGap | undefined {
  return model.gaps.find((gap) => gap.position === "before" && gap.hunkIndex === hunkIndex);
}

/** One file's identity row: where it is, where it came from, and how much it changed. */
function ReviewFileHeader({ model }: { model: ReviewFileRenderModel }) {
  return (
    <header className="review-file-header">
      <span className="review-file-path">{model.path}</span>
      {model.previousPath ? (
        <span className="review-file-renamed">renamed from {model.previousPath}</span>
      ) : null}
      <span className="review-file-stats">
        {model.statBadges.additionsText ? (
          <span className="review-stat review-stat-addition">{model.statBadges.additionsText}</span>
        ) : null}
        {model.statBadges.deletionsText ? (
          <span className="review-stat review-stat-deletion">{model.statBadges.deletionsText}</span>
        ) : null}
      </span>
    </header>
  );
}

interface GapStripProps {
  gap: ReviewRenderGap | undefined;
  open: ReadonlySet<string>;
  file: ReviewFileV1;
  source: string | undefined;
  onToggle: (gapId: string) => void;
  showHeader: boolean;
}

/**
 * One collapsed region: how many lines it hides, and the lines themselves once opened.
 *
 * The line labels are the gap's own addresses and the text is the shared source splitter's,
 * so an expanded line here is the same line the producer would accept a note on.
 */
function GapStrip({ gap, open, file, source, onToggle, showHeader }: GapStripProps) {
  if (!gap) {
    return null;
  }
  const isOpen = open.has(gap.gapId);
  const rows =
    isOpen && source !== undefined ? reviewExpandedGapRows(file, gap.gapId, source) : undefined;
  return (
    <div className="review-gap">
      <button
        type="button"
        className="review-gap-toggle"
        aria-expanded={isOpen}
        onClick={() => onToggle(gap.gapId)}
      >
        {isOpen ? "Hide" : "Show"} {gap.lineCount} unchanged{" "}
        {gap.lineCount === 1 ? "line" : "lines"}
        {showHeader ? <span className="review-gap-range"> @@ {rangeLabel(gap)}</span> : null}
      </button>
      {isOpen ? <ExpandedRows rows={rows} showLineNumbers={showHeader} /> : null}
    </div>
  );
}

/** The `-old +new` label one gap covers, in the ranges core addressed it by. */
function rangeLabel(gap: ReviewRenderGap) {
  return `-${gap.oldRange[0]},${gap.lineCount} +${gap.newRange[0]},${gap.lineCount}`;
}

/** The lines an opened gap reveals, or why they are not there yet. */
function ExpandedRows({
  rows,
  showLineNumbers,
}: {
  rows: ReviewExpandedRow[] | undefined;
  showLineNumbers: boolean;
}): ReactNode {
  if (!rows) {
    return <p className="review-gap-pending">Loading unchanged lines…</p>;
  }
  return (
    <pre className="review-gap-rows">
      {rows.map((row) => (
        <div key={`${row.oldLine}:${row.newLine}`} className="review-gap-row">
          {showLineNumbers ? (
            <span className="review-gap-line-numbers">
              {row.oldLine} {row.newLine}
            </span>
          ) : null}
          <span className="review-gap-text">{row.text}</span>
        </div>
      ))}
    </pre>
  );
}
