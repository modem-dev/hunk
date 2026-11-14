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
 *
 * The header also carries the reviewer's "Viewed" checkbox, and says when a file changed since
 * it was marked. A viewed file's body is collapsed to one row that expands it on click; the
 * page decides which files are viewed and collapsed (`../viewed/useViewedFiles.ts`).
 */
import { memo, useCallback, useContext, useMemo, useRef, type CSSProperties } from "react";
import type { ReviewEmptyDiffReason } from "../../core/review/document";
import type { ReviewStoredNote } from "../../core/review/state";
import type { ReviewAgentHighlightV1, ReviewSharedNoteV1 } from "../../session/reviewSharedState";
import type { NoteComposer } from "../notes/composerStore";
import { planReviewFileNotes } from "../notes/noteProjection";
import type { ReviewNoteInteraction } from "../notes/noteInteraction";
import { reviewFileChangeGlyph, reviewFileLabelParts } from "../../core/review/fileLabels";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import type { ReviewFileRenderPlan } from "./fileProjection";
import { FilePreviewBody, FilePreviewHeaderAction } from "../previews/FilePreviews";
import type { ReviewFileGeometry } from "./hunkGeometry";
import { PierreFileView } from "./PierreFileView";
import { SessionEndedContext } from "../session/sessionEnded";
import type { ReviewViewedStatus } from "../viewed/viewedFiles";

/** Height of one Pierre row, and of the header, in CSS pixels. */
export const STREAM_ROW_HEIGHT_PX = 20;
export const STREAM_HEADER_HEIGHT_PX = 34;

/** Height of a collapsed viewed file's body, in CSS pixels. */
export const VIEWED_COLLAPSED_HEIGHT_PX = 32;

/** What the viewed controls in a file header do; stable for the page's lifetime. */
export interface ReviewViewedControls {
  toggle: (fileKey: string) => void;
  expand: (fileKey: string) => void;
  collapse: (fileKey: string) => void;
}

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
  /** This file's open composers. */
  composers: readonly NoteComposer[];
  /** What note gestures in this file do; stable for the page's lifetime. */
  interaction: ReviewNoteInteraction;
  /** This file's viewed mark as the page shows it. */
  viewedStatus?: ReviewViewedStatus;
  /** Whether the body is collapsed because the file is viewed. */
  collapsed?: boolean;
  viewed?: ReviewViewedControls;
  /**
   * Called with the body element each time one is created or removed (with the one it
   * replaces), so the stream measures every body this file ever has.
   */
  observeBody?: (body: HTMLDivElement | null, previous: HTMLDivElement | null) => void;
}

const NO_HIGHLIGHTS: readonly ReviewAgentHighlightV1[] = [];

/** The header row for one file. */
function FileHeader({
  index,
  fileKey,
  expandedGaps,
  onCollapseGaps,
  viewedStatus,
  collapsed,
  viewed,
}: {
  index?: ReviewFileIndexEntry;
  fileKey: string;
  expandedGaps: number;
  onCollapseGaps: () => void;
  viewedStatus?: ReviewViewedStatus;
  collapsed?: boolean;
  viewed?: ReviewViewedControls;
}) {
  if (!index) {
    return (
      <header className="file-header" data-loading="">
        <span className="file-name muted">Loading file…</span>
      </header>
    );
  }
  const sessionEnded = useContext(SessionEndedContext);
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
      <FilePreviewHeaderAction fileKey={fileKey} path={index.path} changeKind={index.changeKind} />
      {expandedGaps > 0 ? (
        <button type="button" className="header-action" onClick={onCollapseGaps}>
          Hide expanded lines
        </button>
      ) : null}
      {viewedStatus === "changed" ? (
        <span className="viewed-changed" title="The file changed after it was marked viewed">
          Changed since viewed
        </span>
      ) : null}
      {viewedStatus === "viewed" && !collapsed && viewed ? (
        <button type="button" className="header-action" onClick={() => viewed.collapse(fileKey)}>
          Collapse
        </button>
      ) : null}
      <span className="file-stats">
        <span className="stat-added">{`+${index.stats.additions}${index.stats.truncated ? "+" : ""}`}</span>{" "}
        <span className="stat-removed">{`-${index.stats.deletions}`}</span>
      </span>
      {viewed ? (
        <label className="viewed-toggle" data-status={viewedStatus ?? "unviewed"}>
          <input
            type="checkbox"
            checked={viewedStatus === "viewed"}
            disabled={sessionEnded}
            onChange={() => viewed.toggle(fileKey)}
            aria-label={`Viewed ${filename}`}
          />
          <span aria-hidden="true">Viewed</span>
        </label>
      ) : null}
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
  const sessionEnded = useContext(SessionEndedContext);
  // Notes hang from lines as drawn, so expanded context counts; the plan's metadata is that.
  const noteGroups = useMemo(() => {
    if (!plan?.metadata) return [];
    const groups = planReviewFileNotes({
      file: { key: fileKey, hunks: plan.metadata.hunks },
      state: {
        liveNotes: liveNotes as ReviewStoredNote[],
        userNotes: userNotes as ReviewStoredNote[],
        showAgentNotes,
      },
      sidecar: sidecarNotes,
    });
    if (!sessionEnded) return groups;
    return groups.map((group) => ({
      ...group,
      cards: group.cards.map((card) => ({ ...card, actionsDisabled: true })),
    }));
  }, [fileKey, plan, liveNotes, userNotes, showAgentNotes, sidecarNotes, sessionEnded]);
  // Collapsing a viewed file removes its body and expanding creates a new one; each is handed
  // to the stream's observer for its whole life.
  const { observeBody } = props;
  const body = useRef<HTMLDivElement | null>(null);
  const bodyRef = useCallback(
    (element: HTMLDivElement | null) => {
      const previous = body.current;
      body.current = element;
      observeBody?.(element, previous);
    },
    [observeBody],
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
        {...(props.viewedStatus ? { viewedStatus: props.viewedStatus } : {})}
        {...(props.collapsed ? { collapsed: true } : {})}
        {...(props.viewed ? { viewed: props.viewed } : {})}
      />
      {props.collapsed && props.viewed ? (
        // Not a `.file-body`: the stream measures bodies, and a collapsed one must not stand in
        // for the file's real height once it is expanded or unmounted.
        <button
          type="button"
          className="file-collapsed"
          style={{ height: VIEWED_COLLAPSED_HEIGHT_PX }}
          onClick={() => props.viewed!.expand(fileKey)}
        >
          Viewed · show changes
        </button>
      ) : (
        <div className="file-body" style={bodyStyle} ref={bodyRef}>
          <FilePreviewBody
            fileKey={fileKey}
            file={plan?.file}
            emptyReason={plan?.emptyReason}
            mounted={mounted}
          >
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
                composers={props.composers}
                renderComposer={props.interaction.renderComposer}
                onPickLines={(side, start, end) =>
                  props.interaction.onPickLines(fileKey, side, start, end)
                }
                onNoteAction={(action, noteId) =>
                  props.interaction.onNoteAction(fileKey, action, noteId)
                }
              />
            ) : null}
          </FilePreviewBody>
        </div>
      )}
    </section>
  );
});
