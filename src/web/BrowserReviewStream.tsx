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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileDiff } from "@pierre/diffs/react";
import type { ReviewDocumentV1, ReviewFileV1 } from "../core/review/types";
import { formatReviewAddress } from "../core/review/address";
import {
  buildBrowserReviewFileRenderModel,
  browserReviewExpandedGapRows,
  type BrowserReviewExpandedRow,
  type BrowserReviewFileRenderModel,
  type BrowserReviewRenderGap,
} from "./browserPierreDocument";
import type { BrowserReviewSourceEntry } from "./browserReviewSources";
import { resolveBrowserDiffStyle, type BrowserViewOptions } from "./browserViewOptions";

/** What a file with no rows says about itself, in this surface's wording. */
const EMPTY_DIFF_MESSAGES = {
  "rename-only": "Renamed with no content changes.",
  binary: "Binary file.",
  "too-large": "File too large to render.",
  "new-file": "New empty file.",
  "deleted-file": "File deleted.",
  "no-hunks": "No changes to show.",
} as const;

export interface BrowserReviewStreamProps {
  document: ReviewDocumentV1;
  view: BrowserViewOptions;
  /** Width the responsive layout decides from; the window's, in a real page. */
  viewportWidth: number;
  /** Each file's source text, or why it could not be read, for the gaps a reader opened. */
  sourceByFileKey?: Record<string, BrowserReviewSourceEntry>;
  /** Asked for the source behind one file whenever a gap in it is opened. */
  onRequestSource?: (file: ReviewFileV1) => void;
}

/** The whole review, in the order the document lists it. */
export function BrowserReviewStream({
  document,
  view,
  viewportWidth,
  sourceByFileKey = {},
  onRequestSource,
}: BrowserReviewStreamProps) {
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
  source?: BrowserReviewSourceEntry;
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
  // Built from the file's content and nothing else — not from the width, which only reaches
  // Pierre — so a resize re-renders the stream without rebuilding every file's model and
  // handing Pierre fresh object identities to re-highlight.
  const model = useMemo(() => buildBrowserReviewFileRenderModel(file), [file]);
  const [openGaps, setOpenGaps] = useState<ReadonlySet<string>>(() => new Set());

  // A reload replaces the file behind this section; gap ids address the geometry that was
  // published with it, so what was open cannot be carried over.
  useEffect(() => {
    setOpenGaps(new Set());
  }, [file.contentIdentity]);

  const toggleGap = useCallback(
    (gapId: string) => {
      const opening = !openGaps.has(gapId);
      setOpenGaps((open) => {
        const next = new Set(open);
        if (next.delete(gapId)) {
          return next;
        }
        next.add(gapId);
        return next;
      });
      // Asked outside the updater, which React may run more than once. The request is the
      // reader's ask for this file's text and also the retry after one that failed; the
      // store is what decides whether it costs a read.
      if (opening) {
        onRequestSource?.(file);
      }
    },
    [file, onRequestSource, openGaps],
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
            <BrowserGapStrip
              gap={gapBefore(model, hunk.index)}
              open={openGaps}
              file={file}
              source={source}
              onToggle={toggleGap}
              showHeader={view.showHunkHeaders}
              showLineNumbers={view.showLineNumbers}
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
      <BrowserGapStrip
        gap={model.gaps.find((gap) => gap.position === "trailing")}
        open={openGaps}
        file={file}
        source={source}
        onToggle={toggleGap}
        showHeader={view.showHunkHeaders}
        showLineNumbers={view.showLineNumbers}
      />
    </section>
  );
}

/** The collapsed region immediately before one hunk, when the file has one. */
function gapBefore(
  model: BrowserReviewFileRenderModel,
  hunkIndex: number,
): BrowserReviewRenderGap | undefined {
  return model.gaps.find((gap) => gap.position === "before" && gap.hunkIndex === hunkIndex);
}

/** One file's identity row: where it is, where it came from, and how much it changed. */
function ReviewFileHeader({ model }: { model: BrowserReviewFileRenderModel }) {
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

export interface BrowserGapStripProps {
  gap: BrowserReviewRenderGap | undefined;
  open: ReadonlySet<string>;
  file: ReviewFileV1;
  /** This file's source, once it has been read, or why it could not be. */
  source: BrowserReviewSourceEntry | undefined;
  onToggle: (gapId: string) => void;
  /** Whether the strip states the range it covers, as a hunk header would. */
  showHeader: boolean;
  /** Whether the lines it reveals carry their line numbers, as the diff rows do. */
  showLineNumbers: boolean;
}

/**
 * One collapsed region: how many lines it hides, and the lines themselves once opened.
 *
 * The line labels are the gap's own addresses and the text is the shared source splitter's,
 * so an expanded line here is the same line the producer would accept a note on.
 */
export function BrowserGapStrip({
  gap,
  open,
  file,
  source,
  onToggle,
  showHeader,
  showLineNumbers,
}: BrowserGapStripProps) {
  if (!gap) {
    return null;
  }
  const isOpen = open.has(gap.gapId);
  const rows =
    isOpen && source?.text !== undefined
      ? browserReviewExpandedGapRows(file, gap.gapId, source.text)
      : undefined;
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
      {isOpen ? (
        <ExpandedRows
          rows={rows}
          showLineNumbers={showLineNumbers}
          {...(source?.status === "failed" && source.failure
            ? { failure: source.failure.message }
            : {})}
        />
      ) : null}
    </div>
  );
}

/** The `-old +new` label one gap covers, in the ranges core addressed it by. */
function rangeLabel(gap: BrowserReviewRenderGap) {
  return `-${gap.oldRange[0]},${gap.lineCount} +${gap.newRange[0]},${gap.lineCount}`;
}

/** The lines an opened gap reveals, or why they are not there yet. */
function ExpandedRows({
  rows,
  showLineNumbers,
  failure,
}: {
  rows: BrowserReviewExpandedRow[] | undefined;
  showLineNumbers: boolean;
  /** Why the source behind these lines could not be read, in the catalog's words. */
  failure?: string;
}): ReactNode {
  if (failure) {
    // Said once, in the refusal's own wording: a read that will not come back must not look
    // like one that is still on its way. Opening the gap again asks for it again.
    return <p className="review-gap-failure">{failure}</p>;
  }
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
