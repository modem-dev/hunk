/** @jsxImportSource react */
/**
 * Draws one file of the review stream: its sticky header and its body.
 *
 * The header shows what the terminal's file header shows — change-kind letter, the path with
 * the old name of a rename, and right-aligned `+A −D` that hides zeros — from the shared labels
 * in `core/review/fileLabels.ts`. The path dims its directory and a rename's old name so the
 * basename reads first, and stays one selectable string. A quiet chip after it says what kind
 * of change the file is ("new", "renamed, no content changes", "binary", "too large") from the
 * shared model, so a file with nothing to render needs no body sentence: it is a header-only
 * row, except a too-large file, whose body says why it is not drawn. The body is otherwise
 * Pierre once the file is near the viewport, or space reserved from the file's row count while
 * the file is still loading or far away.
 *
 * The header carries the file's actions: a chevron that collapses and expands the body, a
 * copy-path button shown on hover and focus, the reviewer's "Viewed" checkbox, and a marker
 * when a file changed since it was marked. A viewed file is collapsed by default and any file
 * can be folded; the page decides which files are viewed and collapsed
 * (`../viewed/useViewedFiles.ts`).
 */
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ReviewEmptyDiffReason } from "../../core/review/document";
import { reviewEmptyDiffReason } from "../../core/review/document";
import type { ReviewStoredNote } from "../../core/review/state";
import type { ReviewAgentHighlight, ReviewSharedNote } from "../../session/reviewSharedState";
import type { NoteComposer } from "../notes/composerStore";
import { planReviewFileNotes } from "../notes/noteProjection";
import type { ReviewNoteInteraction } from "../notes/noteInteraction";
import { reviewFileChangeGlyph } from "../../core/review/fileLabels";
import { webFileHeaderPath, webFileStateChip } from "../format/fileHeader";
import { formatAddedBadge, formatRemovedBadge } from "../format/lineCounts";
import { Icon } from "../icons/Icon";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import type { ReviewFileRenderPlan } from "./fileProjection";
import {
  emptyFileHasBody,
  FilePreviewBody,
  FilePreviewHeaderAction,
  useBinaryFileSizes,
} from "../previews/FilePreviews";
import type { ReviewFileGeometry } from "./hunkGeometry";
import { PierreFileView } from "./PierreFileView";
import { SessionEndedContext } from "../session/sessionEnded";
import type { ReviewViewedStatus } from "../viewed/viewedFiles";

/** Height of one Pierre row, and of the header, in CSS pixels. */
export const STREAM_ROW_HEIGHT_PX = 20;
export const STREAM_HEADER_HEIGHT_PX = 34;

/** Height of a collapsed file's body, in CSS pixels: the header stands alone. */
export const COLLAPSED_BODY_HEIGHT_PX = 0;

/** What the viewed and collapse controls in a file header do; stable for the page's lifetime. */
export interface ReviewViewedControls {
  toggle: (fileKey: string) => void;
  expand: (fileKey: string) => void;
  collapse: (fileKey: string) => void;
}

/** What a too-large file's body says; the other empty reasons are told by the header chip. */
export const TOO_LARGE_MESSAGE = "File too large to render automatically.";

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
  /** The active note, when this file draws it. */
  activeNoteId?: string | null;
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
  sidecarNotes: readonly ReviewSharedNote[];
  /** This file's agent attention marks. */
  highlights: readonly ReviewAgentHighlight[];
  /** This file's open composers. */
  composers: readonly NoteComposer[];
  /** What note gestures in this file do; stable for the page's lifetime. */
  interaction: ReviewNoteInteraction;
  /** This file's viewed mark as the page shows it. */
  viewedStatus?: ReviewViewedStatus;
  /** Whether the body is collapsed: the file is viewed, or the reader folded it. */
  collapsed?: boolean;
  viewed?: ReviewViewedControls;
  /** The keymap's chord for the viewed toggle, given only to the selected file's header. */
  viewedKeyHint?: string;
  /**
   * Called with the body element each time one is created or removed (with the one it
   * replaces), so the stream measures every body this file ever has.
   */
  observeBody?: (body: HTMLDivElement | null, previous: HTMLDivElement | null) => void;
}

const NO_HIGHLIGHTS: readonly ReviewAgentHighlight[] = [];

/** How long a copy result shows before the button returns to its icon, in milliseconds. */
const COPY_FEEDBACK_MS = 2_000;

/**
 * Why a file renders no rows, from the plan once it loads, or from the index entry when that
 * already knows the file has no hunks.
 */
function headerEmptyReason(
  index: ReviewFileIndexEntry,
  plan: ReviewFileRenderPlan | undefined,
): ReviewEmptyDiffReason | undefined {
  if (plan) return plan.emptyReason;
  if (index.hunkCount !== 0) return undefined;
  return reviewEmptyDiffReason({
    changeKind: index.changeKind,
    binary: index.flags.binary,
    tooLarge: index.flags.tooLarge,
  });
}

/** Whether a file has a body to collapse: rows to draw, or a preview or message in their place. */
export function fileHasBody(plan: ReviewFileRenderPlan | undefined) {
  return !plan?.emptyReason || emptyFileHasBody(plan.file, plan.emptyReason);
}

/** The copy-path button, which shows the copy's result briefly the way the toolbar's does. */
function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy path";

  return (
    <button
      type="button"
      className="file-header-button file-copy-path"
      data-state={copied}
      title={`Copy ${path}`}
      onClick={async () => {
        let ok = true;
        try {
          await navigator.clipboard.writeText(path);
        } catch {
          ok = false;
        }
        setCopied(ok ? "copied" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied("idle"), COPY_FEEDBACK_MS);
      }}
    >
      <Icon name={copied === "copied" ? "check" : copied === "failed" ? "cross" : "copy"} />
      {/* The name doubles as the result: shown briefly after a copy, announced politely. */}
      <span className={copied === "idle" ? "visually-hidden" : "copy-feedback"} aria-live="polite">
        {label}
      </span>
    </button>
  );
}

/** The header row for one file. */
function FileHeader({
  index,
  plan,
  fileKey,
  expandedGaps,
  onCollapseGaps,
  viewedStatus,
  collapsed,
  viewed,
  viewedKeyHint,
}: {
  index?: ReviewFileIndexEntry;
  plan?: ReviewFileRenderPlan;
  fileKey: string;
  expandedGaps: number;
  onCollapseGaps: () => void;
  viewedStatus?: ReviewViewedStatus;
  collapsed?: boolean;
  viewed?: ReviewViewedControls;
  viewedKeyHint?: string;
}) {
  const sessionEnded = useContext(SessionEndedContext);
  const sizes = useBinaryFileSizes(fileKey, index?.flags.binary ?? false);
  if (!index) {
    return (
      <header className="file-header" data-loading="">
        <span className="file-collapse-spacer" aria-hidden="true" />
        <span className="file-name muted">Loading file…</span>
      </header>
    );
  }
  const glyph = reviewFileChangeGlyph(index.changeKind, index.flags.untracked);
  const path = webFileHeaderPath({
    path: index.path,
    ...(index.previousPath !== undefined ? { previousPath: index.previousPath } : {}),
    changeKind: index.changeKind,
    untracked: index.flags.untracked,
  });
  const emptyReason = headerEmptyReason(index, plan);
  const chip = webFileStateChip({
    changeKind: index.changeKind,
    untracked: index.flags.untracked,
    ...(emptyReason ? { emptyReason } : {}),
    ...(sizes ? { sizes } : {}),
  });
  const added = formatAddedBadge(index.stats.additions, index.stats.truncated);
  const removed = formatRemovedBadge(index.stats.deletions);
  // A file with rows to draw can fold; a header-only row has nothing under it to hide.
  const hasBody = plan ? fileHasBody(plan) : emptyReason === undefined;

  return (
    <header className="file-header" data-file-header={fileKey}>
      {viewed && hasBody ? (
        <button
          type="button"
          className="file-header-button file-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          title={collapsed ? `Show the changes in ${index.path}` : `Collapse ${index.path}`}
          onClick={() => (collapsed ? viewed.expand(fileKey) : viewed.collapse(fileKey))}
        >
          <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
        </button>
      ) : (
        <span className="file-collapse-spacer" aria-hidden="true" />
      )}
      <span className="file-glyph" data-role={glyph.role} aria-label={glyph.role}>
        {glyph.glyph}
      </span>
      <span className="file-name" title={path.text}>
        <span className="file-path">
          {path.from !== undefined ? (
            <>
              <span className="file-path-from">{path.from}</span>
              <span className="file-path-arrow">
                <Icon name="arrow-right" size={12} />
                {/* The arrow's text, so a copied or read path still says `old -> new`. */}
                <span className="file-path-arrow-text">{" -> "}</span>
              </span>
            </>
          ) : null}
          <span className="file-path-dir">{path.directory}</span>
          <span className="file-path-base">{path.basename}</span>
        </span>
      </span>
      {chip ? (
        <span className="file-chip" {...(emptyReason ? { "data-empty-reason": emptyReason } : {})}>
          {chip}
        </span>
      ) : null}
      <CopyPathButton path={index.path} />
      <span className="file-header-spacer" />
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
      {added || removed ? (
        <span className="file-stats">
          {added ? <span className="stat-added">{added}</span> : null}
          {added && removed ? " " : null}
          {removed ? <span className="stat-removed">{removed}</span> : null}
        </span>
      ) : null}
      {viewed ? (
        <label
          className="viewed-toggle"
          data-status={viewedStatus ?? "unviewed"}
          {...(viewedKeyHint ? { title: `Mark viewed (${viewedKeyHint})` } : {})}
        >
          <input
            type="checkbox"
            checked={viewedStatus === "viewed"}
            disabled={sessionEnded}
            onChange={() => viewed.toggle(fileKey)}
            aria-label={`Viewed ${path.text}`}
          />
          <span aria-hidden="true">Viewed</span>
          {viewedKeyHint ? (
            <kbd className="key-hint" aria-hidden="true">
              {viewedKeyHint}
            </kbd>
          ) : null}
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
  if (!fileHasBody(plan)) return 0;
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
  // Collapsing a file removes its body and expanding creates a new one; each is handed to the
  // stream's observer for its whole life.
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
      data-collapsed={props.collapsed && props.viewed ? "" : undefined}
      aria-label={index?.path ?? "Loading file"}
    >
      <FileHeader
        index={index}
        plan={plan}
        fileKey={fileKey}
        expandedGaps={expandedGaps}
        onCollapseGaps={() => props.onCollapseGaps(fileKey)}
        {...(props.viewedStatus ? { viewedStatus: props.viewedStatus } : {})}
        {...(props.collapsed ? { collapsed: true } : {})}
        {...(props.viewed ? { viewed: props.viewed } : {})}
        {...(props.viewedKeyHint ? { viewedKeyHint: props.viewedKeyHint } : {})}
      />
      {props.collapsed && props.viewed ? null : (
        <div className="file-body" style={bodyStyle} ref={bodyRef}>
          <FilePreviewBody
            fileKey={fileKey}
            file={plan?.file}
            emptyReason={plan?.emptyReason}
            mounted={mounted}
          >
            {!plan ? (
              <p className="file-placeholder">Loading…</p>
            ) : plan.emptyReason === "too-large" ? (
              <p className="file-placeholder">{TOO_LARGE_MESSAGE}</p>
            ) : plan.emptyReason ? null : mounted ? (
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
                activeNoteId={props.activeNoteId}
                {...(props.interaction.actionHints
                  ? { actionHints: props.interaction.actionHints }
                  : {})}
              />
            ) : null}
          </FilePreviewBody>
        </div>
      )}
    </section>
  );
});
