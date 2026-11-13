/**
 * Owns one live review outside any renderer: its store, the facts intents need, and the
 * agent-facing operations on it.
 *
 * Keyboard and mouse actions in the terminal, `hunk session` commands relayed by the daemon,
 * and a soft reload replacing the file set all converge here. The host creates and holds the
 * `ReviewStore`, applies intents with the caller-owned facts core refuses to invent (note and
 * draft ids, timestamps, the annotation index), ingests and removes agent live comments,
 * resolves agent navigation to a semantic selection and reveal request, holds agent line
 * highlights, loads the source text an expanded gap needs, and projects the summaries the
 * session snapshot publishes. It imports nothing from a renderer, so a headless session can
 * drive the same review the terminal does.
 *
 * What it leaves elsewhere: projecting state onto the diff-file model panes render, the
 * measured line cursor and its reveal requests, and note-card measurement belong to the
 * surface (`ui/hooks/useTerminalReview.ts`). A method that can use such a renderer fact —
 * landing on an exact measured line, or validating STML at the live note width — takes it as
 * an explicit optional input and has a defined answer without it. Generations, resources, and
 * brokered actions stay with `ReviewProducer`, which attaches to this host's store.
 *
 * Replacing the file set keeps the store: notes, drafts, filter, and selection survive a
 * reload through the store's own reconcile, and the host retires only what addresses changed
 * content — in-flight source loads and agent marks on files whose content moved.
 */
import {
  buildLiveComment,
  findDiffFileByPath,
  resolveCommentTarget,
  liveCommentToStoredNote,
} from "../../core/liveComments";
import {
  builtinAppCommand,
  lowerAppCommandToReviewIntent,
  type AppCommandId,
  type AppCommandLoweringContext,
} from "../../core/run/commandCatalog";
import { SourceTextTooLargeError } from "../../core/changeset/fileSource";
import type { DiffFile } from "../../core/changeset/model";
import { carryOverLineHighlights } from "../../core/highlights/reconcile";
import {
  MAX_LINE_HIGHLIGHTS_PER_FILE,
  MAX_LINE_HIGHLIGHTS_PER_LINE,
  validateLineHighlights,
  type ValidatedLineHighlight,
} from "../../core/highlights/validate";
import {
  applyReviewIntent,
  requireReviewReplyParent,
  ReviewIntentPlanningError,
  type ReviewExpansionToggledOutcome,
  type ReviewIntent,
  type ReviewIntentFacts,
  type ReviewIntentOutcomeByType,
} from "../../core/review/intents";
import { projectReviewDocument } from "../../core/review/document";
import { reviewExpansionSide } from "../../core/review/expansion";
import { reviewHunkIndexForLine } from "../../core/review/geometry";
import type { ReviewAnnotationIndex, ReviewSelectionScope } from "../../core/review/navigation";
import {
  reviewFileKeysWithRetiredContent,
  selectNormalizedSelection,
} from "../../core/review/selectors";
import {
  REVIEW_VIEWPORT_ANCHOR_REVEAL,
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewDraftNote,
  type ReviewRevealRequest,
  type ReviewSourceStatus,
  type ReviewState,
} from "../../core/review/state";
import { createReviewStore, type ReviewStore } from "../../core/review/store";
import type { ReviewDocumentV1, ReviewNoteTargetV1, ReviewNoteV1 } from "../../core/review/types";
import { STML_REFERENCE_WIDTH, validateStmlMarkup } from "../../core/stml/layout";
import { noDiffFileMatchesMessage } from "../../session/agent/errors";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  AppliedHighlightResult,
  ClearedCommentsResult,
  ClearedHighlightsResult,
  CommentBatchItemInput,
  CommentToolInput,
  HighlightToolInput,
  HunkSessionState,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../session/types";
import {
  buildLiveCommentSummaries,
  buildReviewNoteSummaries,
  buildReviewSessionAnnotationIndex,
  buildSelectedHunkSummary,
  buildSessionSnapshotState,
  indexReviewFiles,
  planReviewSelectionRepair,
  resolveReviewNavigationTarget,
  type ReviewFileIndex,
} from "./reviewSessionProjections";

const EMPTY_AGENT_LINE_HIGHLIGHTS: ReadonlyMap<string, readonly ValidatedLineHighlight[]> =
  new Map();

/**
 * What a `revealLine` call could actually reach.
 *
 * `"line"` landed on the requested line, `"hunk"` fell back to the hunk containing it because
 * the review stream draws no row for that line, and `"none"` means no hunk covers it either.
 */
export type RevealedLineResult = "line" | "hunk" | "none";

/** Lands the viewport on one measured source line; supplied by a surface that measures rows. */
export type RevealLineFn = (
  fileId: string,
  side: "old" | "new",
  line: number,
) => RevealedLineResult;

/**
 * Validates one comment's STML markup at the width its note renders at right now.
 *
 * Supplied by a surface that lays notes out; without it, markup is accepted unmeasured.
 */
export type MeasureMarkupFn = (
  markup: string,
  anchorSide: "old" | "new",
) => Pick<AppliedCommentResult, "markupWidth" | "markupNotes">;

/** How a selection asks the viewport to reveal it. */
export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  scrollToNote?: boolean;
}

/** One gap expansion the host applied, addressed by runtime file id. */
export interface ReviewGapToggle extends ReviewExpansionToggledOutcome {
  fileId: string;
  gapId: string;
}

/** A draft the host started, with the diff file it belongs to when that file is mounted. */
export interface ReviewStartedDraft {
  draft: ReviewDraftNote;
  file: DiffFile | undefined;
}

export interface ReviewSessionHostOptions {
  files: DiffFile[];
  /** Identity of the review's input as a whole; part of every semantic file key. */
  sourceLabel?: string;
  /** A projection of `files` the caller already made, adopted instead of projecting again. */
  document?: ReviewDocumentV1;
  /** Note-layer visibility the launch configuration resolved. */
  showAgentNotes?: boolean;
  /** Accept STML bodies for live comments in this explicitly opted-in session. */
  stmlEnabled?: boolean;
  /**
   * Fixed width notes are laid out at when no surface measures them (a headless session).
   *
   * Markup without a caller-supplied measure is validated at this width, and STML-enabled
   * snapshots report it as `noteMarkupWidth`. Defaults to `STML_REFERENCE_WIDTH`.
   */
  nominalNoteMarkupWidth?: number;
  /** Clock for note ids, draft ids, and timestamps; injectable for tests. */
  now?: () => number;
}

interface SourceLoadRequest {
  fetcher: NonNullable<DiffFile["sourceFetcher"]>;
  requestId: number;
  side: "old" | "new";
}

/**
 * Translate selection options into the shared reveal request.
 *
 * Selections that deliberately leave the viewport alone do not come through here at all:
 * that is the viewport-anchor policy, expressed as its own intent.
 */
export function revealRequestFor(options?: ReviewSelectionOptions): ReviewRevealRequest {
  return {
    anchor: options?.alignFileHeaderTop ? "file-top" : "hunk",
    scrollToNote: Boolean(options?.scrollToNote),
  };
}

/** Re-raise a missing-note rejection as the message agent surfaces already report. */
function withMissingNoteMessage<T>(run: () => T, message: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ReviewIntentPlanningError && error.code === "note-not-found") {
      throw new Error(message);
    }
    throw error;
  }
}

export class ReviewSessionHost {
  /** The semantic review store; producers and surfaces subscribe to it directly. */
  readonly store: ReviewStore;
  private files: DiffFile[];
  private document: ReviewDocumentV1;
  private sourceLabel: string;
  private fileIndex: ReviewFileIndex;
  private stmlEnabled: boolean;
  private readonly nominalNoteMarkupWidth: number;
  private readonly now: () => number;
  private agentLineHighlights = EMPTY_AGENT_LINE_HIGHLIGHTS;
  private readonly highlightListeners = new Set<() => void>();
  private readonly sourceLoadRequests = new Map<string, SourceLoadRequest>();
  private nextSourceLoadRequestId = 1;
  // Monotonic suffixes that keep `user:*` note ids and draft ids unique within one millisecond.
  private userNoteSequence = 0;
  private draftNoteSequence = 0;
  private annotationCache:
    | {
        files: DiffFile[];
        liveNotes: ReviewState["liveNotes"];
        userNotes: ReviewState["userNotes"];
        index: ReviewAnnotationIndex;
      }
    | undefined;

  constructor(options: ReviewSessionHostOptions) {
    this.files = options.files;
    this.sourceLabel = options.sourceLabel ?? "";
    this.document =
      options.document ?? projectReviewDocument(options.files, { sourceLabel: this.sourceLabel });
    this.fileIndex = indexReviewFiles(this.document, this.files);
    this.stmlEnabled = options.stmlEnabled ?? false;
    this.nominalNoteMarkupWidth = options.nominalNoteMarkupWidth ?? STML_REFERENCE_WIDTH;
    // Read the global clock at call time so a replaced `Date.now` is honored.
    this.now = options.now ?? (() => Date.now());
    this.store = createReviewStore(this.document, { showAgentNotes: options.showAgentNotes });
  }

  /** Read the current semantic review state. */
  getSnapshot(): ReviewState {
    return this.store.getSnapshot();
  }

  /** The diff files the review currently holds, in review order. */
  getFiles(): readonly DiffFile[] {
    return this.files;
  }

  /** The semantic document projected from the current files. */
  getDocument(): ReviewDocumentV1 {
    return this.document;
  }

  /** Resolve one runtime file id to its semantic file key. */
  fileKeyFor(fileId: string): string | undefined {
    return this.fileIndex.keyByFileId.get(fileId);
  }

  /** Resolve one semantic file key to the diff file currently mounted for it. */
  fileForKey(fileKey: string): DiffFile | undefined {
    return this.fileIndex.fileByKey.get(fileKey);
  }

  /** Accept or refuse STML live-comment bodies from now on. */
  setStmlEnabled(enabled: boolean) {
    this.stmlEnabled = enabled;
  }

  /**
   * Replace the review's file set, as a soft reload does.
   *
   * The store reconciles its own content-derived state. The host retires in-flight source
   * loads for files whose content changed, carries agent marks only onto files that came back
   * with identical content, and refetches source for gaps that stayed open but lost their
   * unattested text. Returns the semantic keys whose content was retired, so a surface can
   * drop bookkeeping of its own for them.
   */
  replaceFiles(
    files: DiffFile[],
    options: { sourceLabel?: string; document?: ReviewDocumentV1 } = {},
  ): ReadonlySet<string> {
    if (options.sourceLabel !== undefined) {
      this.sourceLabel = options.sourceLabel;
    }
    const document =
      options.document ?? projectReviewDocument(files, { sourceLabel: this.sourceLabel });
    const previous = this.document;
    if (document === previous && files === this.files) {
      return new Set();
    }

    const retiredFileKeys = reviewFileKeysWithRetiredContent(previous, document);
    for (const fileKey of retiredFileKeys) {
      this.sourceLoadRequests.delete(fileKey);
    }
    this.files = files;
    this.document = document;
    this.fileIndex = indexReviewFiles(document, files);
    this.annotationCache = undefined;

    // Marks address exact character offsets in specific line content, and nothing re-derives
    // them after a reload the way extension highlighters re-run — a stale mark would silently
    // light up different text. Files that came back with identical content keep their marks,
    // re-keyed onto the replacement runtime ids; every other mark is dropped.
    if (this.agentLineHighlights.size > 0) {
      const carried = carryOverLineHighlights(this.agentLineHighlights, previous, document);
      this.commitAgentLineHighlights(carried.size > 0 ? carried : EMPTY_AGENT_LINE_HIGHLIGHTS);
    }
    if (document !== previous) {
      this.store.dispatch({ type: "document/reconcile", document });
    }
    this.repairSelection();
    this.reloadOpenGapSources();
    return retiredFileKeys;
  }

  /**
   * Plan and commit one semantic intent against the store.
   *
   * Facts pass through unchanged: the convenience methods below supply ids, timestamps, and
   * the annotation index where their intents need them.
   */
  applyIntent<T extends ReviewIntent>(
    intent: T,
    facts?: ReviewIntentFacts,
  ): ReviewIntentOutcomeByType[T["type"]] {
    return applyReviewIntent(this.store, intent, facts);
  }

  /**
   * Lower one built-in command to the intent its catalog entry declares.
   *
   * What "toggle the note layer" or "toggle the nearest gap" means is the catalog's
   * declaration; a caller only supplies the facts it owns, such as a measured note target.
   */
  lowerCommand(id: AppCommandId, facts?: Omit<AppCommandLoweringContext, "count" | "state">) {
    return lowerAppCommandToReviewIntent(builtinAppCommand(id), {
      count: 1,
      state: this.store.getSnapshot(),
      ...facts,
    });
  }

  /** Which files and hunks the review's notes currently reach, for annotated navigation. */
  getAnnotationIndex(): ReviewAnnotationIndex {
    const state = this.store.getSnapshot();
    const cached = this.annotationCache;
    if (
      cached?.files === this.files &&
      cached.liveNotes === state.liveNotes &&
      cached.userNotes === state.userNotes
    ) {
      return cached.index;
    }

    const index = buildReviewSessionAnnotationIndex(this.files, this.fileIndex, state);
    this.annotationCache = {
      files: this.files,
      liveNotes: state.liveNotes,
      userNotes: state.userNotes,
      index,
    };
    return index;
  }

  /** Read the normalized selection, addressed by runtime file id. */
  getSelection(): { fileId: string | null; hunkIndex: number | null } {
    const selection = selectNormalizedSelection(this.store.getSnapshot());
    const file = selection.fileKey ? this.fileIndex.fileByKey.get(selection.fileKey) : undefined;
    return { fileId: file?.id ?? null, hunkIndex: file ? selection.hunkIndex : null };
  }

  /**
   * Re-point a stored selection the document no longer supports at the normalized one.
   *
   * A filter only changes the visible stream, so a selected file it hides stays selected; only
   * a file the document lost or a stale hunk index is replaced. No reveal is requested:
   * repairing state must not move anybody's viewport. `replaceFiles` runs this itself.
   */
  repairSelection() {
    const action = planReviewSelectionRepair(this.store.getSnapshot());
    if (action) {
      this.store.dispatch(action);
    }
  }

  /** Select one hunk and record the reveal it asks for. */
  selectHunk(fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) {
    const fileKey = this.fileKeyFor(fileId);
    if (!fileKey) {
      return;
    }

    this.applyIntent({
      type: "selection/select",
      fileKey,
      hunkIndex,
      reveal: revealRequestFor(options),
    });
  }

  /** Jump to one file through the shared file-jump rule. */
  selectFile(fileId: string, options?: ReviewSelectionOptions) {
    const fileKey = this.fileKeyFor(fileId);
    if (!fileKey) {
      return;
    }

    this.applyIntent({ type: "selection/select-file", fileKey, reveal: revealRequestFor(options) });
  }

  /**
   * Adopt a selection a viewport arrived at on its own.
   *
   * Scrolling reports where the reviewer is; it never asks any viewport to move, which is the
   * shared anchor policy rather than a local "preserve viewport" flag.
   */
  anchorSelection(fileId: string, hunkIndex: number) {
    const fileKey = this.fileKeyFor(fileId);
    if (!fileKey) {
      return;
    }

    this.applyIntent({ type: "selection/anchor", fileKey, hunkIndex });
  }

  /**
   * Step the selection through one scope of the canonical document walk.
   *
   * The shared planner owns wrap and reveal; the host supplies the annotation index that
   * annotated scopes plan over.
   */
  moveSelection(scope: ReviewSelectionScope, delta: number) {
    return this.applyIntent(
      { type: "selection/move", scope, delta },
      { annotations: this.getAnnotationIndex() },
    );
  }

  /** Set the shared file filter. */
  setFilter(value: string) {
    this.applyIntent({ type: "filter/set", filter: value });
  }

  /** Show or hide the shared agent note layer. */
  setShowAgentNotes(visible: boolean) {
    this.applyIntent({ type: "notes/set-visibility", visible });
  }

  /** Flip the shared agent note layer, as the catalogued command declares that flip. */
  toggleAgentNotes() {
    const intent = this.lowerCommand("hunk.view.toggleAgentNotes");
    if (intent) {
      this.applyIntent(intent);
    }
  }

  /**
   * Toggle one collapsed gap and start loading the source text it needs.
   *
   * Returns what the toggle did, or nothing when the file cannot expand (no source fetcher).
   */
  toggleGap(fileId: string, gapId: string): ReviewGapToggle | undefined {
    const fileKey = this.fileKeyFor(fileId);
    const file = fileKey ? this.fileIndex.fileByKey.get(fileKey) : undefined;
    if (!file?.sourceFetcher || !fileKey) {
      return undefined;
    }

    return this.applyGapToggle(file, { type: "expansion/toggle", fileKey, gapId });
  }

  /** Toggle the collapsed gap the catalogued "toggle unchanged context" command reaches. */
  toggleSelectedHunkGap(): ReviewGapToggle | undefined {
    const intent = this.lowerCommand("hunk.review.toggleHunkGap");
    if (intent?.type !== "expansion/toggle") {
      return undefined;
    }

    const file = this.fileIndex.fileByKey.get(intent.fileKey);
    return file?.sourceFetcher ? this.applyGapToggle(file, intent) : undefined;
  }

  /**
   * Resolve one session-daemon navigation request against the current review and select it.
   *
   * Relative comment navigation is the same walk the keyboard performs and goes through the
   * shared planner. A line target asks `revealLine` to land on the exact measured row when a
   * surface supplies one, and a surface that cannot reach the line gets the plain hunk
   * selection. With no surface at all, no row can be revealed: the containing hunk is selected
   * and revealed and the result says `revealed: "hunk"`.
   */
  navigateToLocation(
    input: NavigateToHunkToolInput,
    renderer: { revealLine?: RevealLineFn } = {},
  ): NavigatedSelectionResult {
    if (input.commentDirection) {
      const moved = this.moveSelection(
        "annotated-hunk",
        input.commentDirection === "next" ? 1 : -1,
      );
      if (!moved) {
        throw new Error("No annotated hunks found in the current review.");
      }

      const file = this.fileIndex.fileByKey.get(moved.fileKey);
      if (!file) {
        throw new Error("Resolved annotated hunk references an unknown file.");
      }

      return {
        fileId: file.id,
        filePath: file.path,
        hunkIndex: moved.hunkIndex,
        selectedHunk: buildSelectedHunkSummary(file, moved.hunkIndex),
      };
    }

    const target = resolveReviewNavigationTarget({ allFiles: this.files, input });

    // A line target lands the viewport on the exact line through the surface's reveal path,
    // degrading to the hunk when the stream renders no row for the line. `"none"` means the
    // file is not currently visible, where only the plain hunk selection below has defined
    // behavior.
    if (input.hunkIndex === undefined && input.side && input.line !== undefined) {
      let reached: RevealedLineResult;
      if (renderer.revealLine) {
        reached = renderer.revealLine(target.file.id, input.side, input.line);
      } else {
        this.selectHunk(target.file.id, target.hunkIndex);
        reached = "hunk";
      }
      if (reached !== "none") {
        return {
          fileId: target.file.id,
          filePath: target.file.path,
          hunkIndex: target.hunkIndex,
          selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
          revealed: reached,
          side: input.side,
          line: input.line,
        };
      }
    }

    this.selectHunk(target.file.id, target.hunkIndex);
    return {
      fileId: target.file.id,
      filePath: target.file.path,
      hunkIndex: target.hunkIndex,
      selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
    };
  }

  /** Agent attention marks per runtime file id. */
  getAgentLineHighlights(): ReadonlyMap<string, readonly ValidatedLineHighlight[]> {
    return this.agentLineHighlights;
  }

  /** Observe agent attention mark changes; read them through `getAgentLineHighlights`. */
  subscribeAgentLineHighlights(listener: () => void): () => void {
    this.highlightListeners.add(listener);
    return () => {
      this.highlightListeners.delete(listener);
    };
  }

  /**
   * Paint one agent attention mark, validated by the same contract extension line
   * highlighters answer to, so both sources feed one painted-mark pipeline.
   */
  addAgentLineHighlight(
    input: HighlightToolInput,
    renderer: { revealLine?: RevealLineFn } = {},
  ): AppliedHighlightResult {
    const file = findDiffFileByPath(this.files, input.filePath);
    if (!file) {
      throw new Error(noDiffFileMatchesMessage(input.filePath));
    }

    // Requiring hunk coverage catches line-number typos the way comment targets do; the
    // agent-visible review model only exposes hunk-covered lines anyway.
    const hunkIndex = reviewHunkIndexForLine(file.metadata.hunks, input.side, input.line);
    if (hunkIndex < 0) {
      throw new Error(`No ${input.side} diff hunk in ${input.filePath} covers line ${input.line}.`);
    }

    const validation = validateLineHighlights([
      { side: input.side, line: input.line, range: [input.start, input.end], tone: input.tone },
    ]);
    const mark = validation.ok ? validation.marks[0] : undefined;
    if (!mark) {
      throw new Error(
        `Highlight range [${input.start}, ${input.end}) is not a valid [start, end) character range.`,
      );
    }

    const existing = this.agentLineHighlights.get(file.id) ?? [];
    if (existing.length >= MAX_LINE_HIGHLIGHTS_PER_FILE) {
      throw new Error(
        `${input.filePath} already carries ${MAX_LINE_HIGHLIGHTS_PER_FILE} attention marks. Clear some first.`,
      );
    }
    const marksOnLine = existing.filter(
      (candidate) => candidate.side === mark.side && candidate.line === mark.line,
    ).length;
    if (marksOnLine >= MAX_LINE_HIGHLIGHTS_PER_LINE) {
      throw new Error(
        `${input.filePath}:${input.line} already carries ${MAX_LINE_HIGHLIGHTS_PER_LINE} attention marks. Clear some first.`,
      );
    }

    const next = new Map(this.agentLineHighlights);
    next.set(file.id, [...existing, mark]);
    this.commitAgentLineHighlights(next);

    let revealed: "line" | "hunk" | undefined;
    if (input.reveal ?? false) {
      const reached = renderer.revealLine?.(file.id, mark.side, mark.line) ?? "none";
      if (reached === "none") {
        this.selectHunk(file.id, hunkIndex);
        revealed = "hunk";
      } else {
        revealed = reached;
      }
    }

    return {
      fileId: file.id,
      filePath: file.path,
      hunkIndex,
      side: mark.side,
      line: mark.line,
      start: mark.start,
      end: mark.end,
      tone: mark.tone,
      fileMarkCount: existing.length + 1,
      ...(revealed ? { revealed } : {}),
    };
  }

  /** Clear agent attention marks, globally or for one file. */
  clearAgentLineHighlights(filePath?: string): ClearedHighlightsResult {
    const current = this.agentLineHighlights;
    const total = [...current.values()].reduce((sum, marks) => sum + marks.length, 0);

    if (!filePath) {
      if (total > 0) {
        this.commitAgentLineHighlights(EMPTY_AGENT_LINE_HIGHLIGHTS);
      }
      return { removedCount: total, remainingCount: 0 };
    }

    const file = findDiffFileByPath(this.files, filePath);
    if (!file) {
      throw new Error(noDiffFileMatchesMessage(filePath));
    }

    const removed = current.get(file.id)?.length ?? 0;
    if (removed > 0) {
      const next = new Map(current);
      next.delete(file.id);
      this.commitAgentLineHighlights(next);
    }

    return { removedCount: removed, remainingCount: total - removed, filePath };
  }

  /** Add one live comment, optionally revealing its hunk in the active review. */
  addLiveComment(
    input: CommentToolInput,
    commentId: string,
    options: { reveal?: boolean; measureMarkup?: MeasureMarkupFn } = {},
  ): AppliedCommentResult {
    const { file, fileKey, target, replyParent, feedback } = this.resolveCommentRequest(
      input,
      options.measureMarkup,
    );
    const liveComment = buildLiveComment(
      { ...input, filePath: file.path, side: target.side, line: target.line },
      commentId,
      new Date(this.now()).toISOString(),
      target.hunkIndex,
    );
    this.store.dispatch({
      type: "notes/add-live",
      notes: [liveCommentToStoredNote(liveComment, fileKey, file.metadata.hunks, replyParent)],
    });

    if (options.reveal ?? false) {
      this.selectHunk(file.id, target.hunkIndex);
    }

    return {
      commentId,
      fileId: file.id,
      filePath: file.path,
      hunkIndex: target.hunkIndex,
      side: target.side,
      line: target.line,
      ...feedback,
    };
  }

  /** Apply several live comments together after validating every target first. */
  addLiveCommentBatch(
    inputs: CommentBatchItemInput[],
    requestId: string,
    options: { revealMode?: "none" | "first"; measureMarkup?: MeasureMarkupFn } = {},
  ): AppliedCommentBatchResult {
    const createdAt = new Date(this.now()).toISOString();
    const prepared = inputs.map((input, index) => {
      const resolved = this.resolveCommentRequest(input, options.measureMarkup);
      return {
        ...resolved,
        liveComment: buildLiveComment(
          {
            ...input,
            filePath: resolved.file.path,
            side: resolved.target.side,
            line: resolved.target.line,
          },
          `mcp:${requestId}:${index}`,
          createdAt,
          resolved.target.hunkIndex,
        ),
      };
    });

    if (prepared.length > 0) {
      this.store.dispatch({
        type: "notes/add-live",
        notes: prepared.map((entry) =>
          liveCommentToStoredNote(
            entry.liveComment,
            entry.fileKey,
            entry.file.metadata.hunks,
            entry.replyParent,
          ),
        ),
      });
    }

    const first = prepared[0];
    if (options.revealMode === "first" && first) {
      this.selectHunk(first.file.id, first.target.hunkIndex);
    }

    return {
      applied: prepared.map(({ feedback, file, target, liveComment }) => ({
        commentId: liveComment.id,
        fileId: file.id,
        filePath: file.path,
        hunkIndex: target.hunkIndex,
        side: target.side,
        line: target.line,
        ...feedback,
      })),
    };
  }

  /** Remove one daemon-addressable comment, including human notes by stable `user:*` id. */
  removeLiveComment(commentId: string): RemovedCommentResult {
    const isUserNote = commentId.startsWith("user:");
    withMissingNoteMessage(
      () =>
        this.applyIntent(
          isUserNote
            ? { type: "notes/remove-user", noteId: commentId }
            : { type: "notes/remove-live", noteId: commentId },
        ),
      isUserNote
        ? `No user note matches id ${commentId}.`
        : `No live comment matches id ${commentId}.`,
    );

    const snapshot = this.store.getSnapshot();
    return {
      commentId,
      removed: true,
      remainingCommentCount: snapshot.liveNotes.length + snapshot.userNotes.length,
      source: isUserNote ? "user" : "agent",
    };
  }

  /** Clear live comments, optionally including human notes, globally or for one file. */
  clearLiveComments(
    filePath?: string,
    options: { includeUser?: boolean } = {},
  ): ClearedCommentsResult {
    const file = filePath ? findDiffFileByPath(this.files, filePath) : undefined;
    const fileKey = file ? this.fileKeyFor(file.id) : undefined;
    if (filePath && !fileKey) {
      throw new Error(noDiffFileMatchesMessage(filePath));
    }

    const cleared = this.applyIntent({
      type: "notes/clear",
      ...(fileKey ? { fileKey } : {}),
      ...(options.includeUser ? { includeUser: true } : {}),
    });

    return {
      removedCount: cleared.removedLiveCount + cleared.removedUserCount,
      remainingCommentCount: cleared.remainingLiveCount + cleared.remainingUserCount,
      filePath,
      includeUser: options.includeUser,
      removedLiveCommentCount: cleared.removedLiveCount,
      removedUserNoteCount: cleared.removedUserCount,
      remainingLiveCommentCount: cleared.remainingLiveCount,
      remainingUserNoteCount: cleared.remainingUserCount,
    };
  }

  /**
   * Start a reviewer-authored draft at one hunk.
   *
   * Where the note lands is the catalogued command's effect: the target a surface measured
   * when it has one, the shared whole-hunk default when it does not. Returns nothing when the
   * file or hunk is not in the review.
   */
  startUserNote(input: {
    fileId: string | undefined;
    hunkIndex: number;
    target?: ReviewNoteTargetV1;
    preserveViewport?: boolean;
  }): { draft: ReviewDraftNote; file: DiffFile } | null {
    const file = this.files.find((candidate) => candidate.id === input.fileId);
    const hunk = file?.metadata.hunks[input.hunkIndex];
    const fileKey = file ? this.fileKeyFor(file.id) : undefined;
    if (!file || !hunk || !fileKey) {
      return null;
    }

    const intent = this.lowerCommand("hunk.review.startNote", {
      noteLocation: { fileKey, hunkIndex: input.hunkIndex },
      ...(input.target ? { noteTarget: input.target } : {}),
    });
    if (intent?.type !== "notes/start-draft") {
      return null;
    }

    // Adopting a position the viewport already settled on is the shared anchor policy, so such
    // a draft asks for no reveal.
    const { draft } = this.applyIntent(
      {
        ...intent,
        ...(input.preserveViewport ? { reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL } : {}),
      },
      { draftId: `draft:${file.id}:${input.hunkIndex}:${this.nextSequenceSuffix("draft")}` },
    );
    return { draft, file };
  }

  /** Open one saved reviewer note in the shared composer. */
  startUserNoteEdit(noteId: string, options: { preserveViewport?: boolean } = {}) {
    return this.startNoteComposer(
      {
        type: "notes/start-edit",
        noteId,
        ...(options.preserveViewport ? { reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL } : {}),
      },
      `draft:edit:${noteId}`,
    );
  }

  /** Open a reply composer under one stored note. */
  startUserNoteReply(noteId: string, options: { preserveViewport?: boolean } = {}) {
    return this.startNoteComposer(
      {
        type: "notes/start-reply",
        noteId,
        ...(options.preserveViewport ? { reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL } : {}),
      },
      `draft:reply:${noteId}`,
    );
  }

  /** Replace the active draft's body when it is still the draft the caller expects. */
  updateDraftNote(body: string, expectedDraftId?: string): boolean {
    if (
      expectedDraftId !== undefined &&
      this.store.getSnapshot().draftNote?.id !== expectedDraftId
    ) {
      return false;
    }
    this.applyIntent({ type: "notes/update-draft", body });
    return true;
  }

  /** Discard the active reviewer draft. */
  cancelDraftNote() {
    this.applyIntent({ type: "notes/cancel-draft" });
  }

  /**
   * Persist the active draft into the review's user notes exactly once.
   *
   * The store settles synchronously, so a coalesced repeat of the save finds no draft left to
   * consume rather than needing its own guard.
   */
  saveDraftNote(): { note: ReviewNoteV1; file: DiffFile } | null {
    const draft = this.store.getSnapshot().draftNote;
    const file = draft ? this.fileIndex.fileByKey.get(draft.fileKey) : undefined;
    if (!draft || !file) {
      return null;
    }

    const timestamp = new Date(this.now()).toISOString();
    const saved =
      draft.kind === "edit"
        ? this.applyIntent(
            { type: "notes/update-user", noteId: draft.targetNoteId, consumeDraft: true },
            { timestamp },
          )
        : this.applyIntent(
            { type: "notes/create-user", consumeDraft: true },
            { noteId: `user:${this.nextSequenceSuffix("user")}`, timestamp },
          );
    return saved ? { note: saved.note.note, file } : null;
  }

  /** Remove one reviewer note by id. */
  removeUserNote(noteId: string) {
    withMissingNoteMessage(
      () => this.applyIntent({ type: "notes/remove-user", noteId }),
      `No user note matches id ${noteId}.`,
    );
  }

  /** The agent live comments a session snapshot publishes. */
  getLiveCommentSummaries(): SessionLiveCommentSummary[] {
    return buildLiveCommentSummaries(this.files, this.fileIndex, this.store.getSnapshot());
  }

  /** Every inline note a session snapshot publishes, sidecar annotations included. */
  getReviewNoteSummaries(): SessionReviewNoteSummary[] {
    return buildReviewNoteSummaries(this.files, this.fileIndex, this.store.getSnapshot());
  }

  /**
   * Build the live state a session snapshot publishes for this review.
   *
   * `noteMarkupWidth` is the width a surface measured; without one, an STML-enabled session
   * reports its nominal width. `publicationGeneration` is the producer generation being served,
   * when there is one.
   */
  getSessionSnapshotState(
    options: { noteMarkupWidth?: number; publicationGeneration?: string } = {},
  ): HunkSessionState {
    const state = this.store.getSnapshot();
    const selection = selectNormalizedSelection(state);
    const file = selection.fileKey ? this.fileIndex.fileByKey.get(selection.fileKey) : undefined;
    const liveComments = this.getLiveCommentSummaries();
    const reviewNotes = this.getReviewNoteSummaries();
    return buildSessionSnapshotState({
      selectedFile: file,
      selectedHunk: file?.metadata.hunks[selection.hunkIndex],
      selectedHunkIndex: selection.hunkIndex,
      showAgentNotes: state.showAgentNotes,
      noteMarkupWidth:
        options.noteMarkupWidth ?? (this.stmlEnabled ? this.nominalNoteMarkupWidth : undefined),
      liveCommentCount: liveComments.length,
      liveComments,
      reviewNoteCount: reviewNotes.length,
      reviewNotes,
      publicationGeneration: options.publicationGeneration,
      stateRevision: state.stateRevision,
    });
  }

  /** Publish one agent-mark map to subscribers. */
  private commitAgentLineHighlights(next: ReadonlyMap<string, readonly ValidatedLineHighlight[]>) {
    this.agentLineHighlights = next;
    for (const listener of Array.from(this.highlightListeners)) {
      listener();
    }
  }

  /** Allocate a millisecond-plus-sequence suffix for one caller-owned id. */
  private nextSequenceSuffix(kind: "user" | "draft") {
    const sequence = kind === "user" ? ++this.userNoteSequence : ++this.draftNoteSequence;
    return `${this.now()}-${sequence}`;
  }

  /** Start an edit or reply composer and pair its draft with the mounted file. */
  private startNoteComposer(
    intent: Extract<ReviewIntent, { type: "notes/start-edit" | "notes/start-reply" }>,
    draftIdPrefix: string,
  ): ReviewStartedDraft {
    const { draft } = this.applyIntent(intent, {
      draftId: `${draftIdPrefix}:${this.nextSequenceSuffix("draft")}`,
    });
    return { draft, file: this.fileIndex.fileByKey.get(draft.fileKey) };
  }

  /** Run one expansion toggle and load the source its expanded side needs. */
  private applyGapToggle(
    file: DiffFile,
    intent: Extract<ReviewIntent, { type: "expansion/toggle" }>,
  ): ReviewGapToggle {
    // The intent decides whether this is an expand or a collapse and reports the side whose
    // source fills the gap.
    const toggled = this.applyIntent(intent);
    this.startSourceLoad(file, intent.fileKey, toggled.side);
    return { ...toggled, fileId: file.id, gapId: intent.gapId };
  }

  /**
   * Refetch source for gaps that stayed open across a reload but lost their source status.
   *
   * A reload drops unattested source text while its gap stays open (the reducer's attestation
   * rule), so an open gap refetches instead of rendering lines the source may no longer
   * contain. The side is the shared expansion-side policy, since no intent outcome is in hand.
   */
  private reloadOpenGapSources() {
    const snapshot = this.store.getSnapshot();
    for (const gap of snapshot.expandedGaps) {
      if (!gap.expanded || snapshot.sourceStatusByFileKey[gap.fileKey]) {
        continue;
      }
      const file = this.fileIndex.fileByKey.get(gap.fileKey);
      if (file?.sourceFetcher) {
        this.startSourceLoad(file, gap.fileKey, reviewExpansionSide(file.metadata.type));
      }
    }
  }

  /** Start one full-source load and mirror its progress into review state as a status. */
  private startSourceLoad(file: DiffFile, fileKey: string, side: SourceLoadRequest["side"]) {
    if (!file.sourceFetcher) {
      return;
    }
    // The fetcher caches its own resolved text; the store mirrors it as a tagged status so a
    // surface can distinguish loading, loaded, and error states. Skip the fetch when one is
    // already in flight or has resolved to avoid redundant work and stale "loading" flicker.
    const currentStatus = this.store.getSnapshot().sourceStatusByFileKey[fileKey]?.kind;
    if (currentStatus === "loaded" || currentStatus === "loading") {
      return;
    }

    const request = {
      fetcher: file.sourceFetcher,
      requestId: this.nextSourceLoadRequestId,
      side,
    } satisfies SourceLoadRequest;
    this.nextSourceLoadRequestId += 1;
    this.sourceLoadRequests.set(fileKey, request);
    this.store.dispatch({
      type: "expansion/set-source-status",
      fileKey,
      status: { kind: "loading" },
    });

    const isCurrentRequest = () => {
      const current = this.sourceLoadRequests.get(fileKey);
      return (
        current?.requestId === request.requestId &&
        current.fetcher === request.fetcher &&
        current.side === request.side
      );
    };

    const setSettledStatus = (status: ReviewSourceStatus) => {
      if (!isCurrentRequest()) {
        return;
      }

      this.sourceLoadRequests.delete(fileKey);
      this.store.dispatch({ type: "expansion/set-source-status", fileKey, status });
    };

    void file.sourceFetcher
      .getFullText(side)
      .then((text) => {
        setSettledStatus(text === null ? { kind: "error" } : { kind: "loaded", text });
      })
      .catch((error: unknown) => {
        if (!isCurrentRequest()) {
          console.error(
            `hunk: ignored stale ${side} source load failure for ${file.path} (${file.id}).`,
            error,
          );
          return;
        }

        const reason = error instanceof SourceTextTooLargeError ? "too-large" : undefined;
        if (reason !== "too-large") {
          console.error(
            `hunk: failed to load ${side} source for ${file.path} (${file.id}).`,
            error,
          );
        }
        setSettledStatus({ kind: "error", reason });
      });
  }

  /**
   * Check one comment's STML markup against this session's policy and the caller's measure.
   *
   * Without a measure the markup is validated at the session's nominal note width.
   */
  private markupFeedback(
    markup: string | undefined,
    anchorSide: "old" | "new",
    measureMarkup: MeasureMarkupFn | undefined,
  ): Pick<AppliedCommentResult, "markupWidth" | "markupNotes"> {
    if (!markup) {
      return {};
    }

    if (!this.stmlEnabled) {
      throw new Error(
        "STML markup is disabled for this session. Relaunch Hunk with --experimental, or omit markup.",
      );
    }

    if (measureMarkup) {
      return measureMarkup(markup, anchorSide);
    }
    const markupNotes = validateStmlMarkup(markup, this.nominalNoteMarkupWidth);
    return {
      markupWidth: this.nominalNoteMarkupWidth,
      ...(markupNotes.length > 0 ? { markupNotes } : {}),
    };
  }

  /** Resolve one root or reply comment against the review's files and stored notes. */
  private resolveCommentRequest(
    input: CommentToolInput | CommentBatchItemInput,
    measureMarkup: MeasureMarkupFn | undefined,
  ) {
    if (input.replyTo !== undefined) {
      if (
        input.filePath !== undefined ||
        input.hunkIndex !== undefined ||
        input.side !== undefined ||
        input.line !== undefined
      ) {
        throw new Error("A reply comment must not include an explicit file or target.");
      }
      const replyParent = requireReviewReplyParent(this.store.getSnapshot(), input.replyTo);
      const file = this.fileIndex.fileByKey.get(replyParent.note.fileKey);
      if (!file) {
        throw new ReviewIntentPlanningError(
          "invalid-note-parent",
          `Review note ${input.replyTo} is no longer available as a reply parent.`,
        );
      }
      const target = {
        hunkIndex: reviewNoteOwnerHunkIndex(replyParent.note),
        ...reviewNoteAnchorLine(replyParent.note),
      };
      return {
        file,
        fileKey: replyParent.note.fileKey,
        target,
        replyParent,
        feedback: this.markupFeedback(input.markup, target.side, measureMarkup),
      };
    }

    if (!input.filePath) {
      throw new Error("A root comment requires a file path.");
    }
    const file = findDiffFileByPath(this.files, input.filePath);
    const fileKey = file ? this.fileKeyFor(file.id) : undefined;
    if (!file || !fileKey) {
      throw new Error(noDiffFileMatchesMessage(input.filePath));
    }

    const target = resolveCommentTarget(file, { ...input, filePath: input.filePath });
    return {
      file,
      fileKey,
      target,
      replyParent: undefined,
      feedback: this.markupFeedback(input.markup, target.side, measureMarkup),
    };
  }
}
